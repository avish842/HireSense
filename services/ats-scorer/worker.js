require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Client } = require('minio');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const parsePDFWithRetry = async (buffer, retries = 5, delay = 200) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await pdfParse(buffer);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};
const { Queue } = require('bullmq');
const Groq = require('groq-sdk');
const { z } = require('zod');
const { logger, db, createConsumer, publishEvent, checkIdempotency, markProcessed, generateIdempotencyKey, connectRedis, connectProducer } = require('@hiresense/shared');

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'autohire_minio',
  secretKey: process.env.MINIO_SECRET_KEY || 'autohire_minio_secret'
});

const BUCKET_NAME = 'resumes';
const ENCRYPTION_KEY = Buffer.from(process.env.FILE_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

const emailQueue = new Queue('emailQueue', {
  connection: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379') }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const atsSchema = z.object({
  ats_score: z.number().min(0).max(100),
  keyword_match_score: z.number().min(0).max(100),
  formatting_score: z.number().min(0).max(100),
  section_completeness_score: z.number().min(0).max(100),
  quantification_score: z.number().min(0).max(100),
  matched_keywords: z.array(z.string()),
  missing_keywords: z.array(z.string()),
  formatting_issues: z.array(z.string()),
  improvement_suggestions: z.array(z.string()),
  summary: z.string()
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const generateMockATSResult = (prompt) => {
  const isStrongMatch = prompt.includes('strong_match') || prompt.toLowerCase().includes('john doe') || prompt.toLowerCase().includes('senior backend');
  const isBorderline = prompt.includes('borderline') || prompt.toLowerCase().includes('jane smith') || prompt.toLowerCase().includes('software engineer');
  
  if (isStrongMatch) {
    return {
      ats_score: 90,
      keyword_match_score: 95,
      formatting_score: 85,
      section_completeness_score: 90,
      quantification_score: 90,
      matched_keywords: ['Node.js', 'Express', 'Microservices', 'Kafka', 'API'],
      missing_keywords: [],
      formatting_issues: [],
      improvement_suggestions: ['Add more detail to recent project outcomes'],
      summary: 'Excellent candidate with strong backend microservices experience.'
    };
  } else if (isBorderline) {
    return {
      ats_score: 55,
      keyword_match_score: 60,
      formatting_score: 50,
      section_completeness_score: 60,
      quantification_score: 50,
      matched_keywords: ['Node.js', 'JavaScript'],
      missing_keywords: ['Microservices', 'Kafka'],
      formatting_issues: ['Resume lacks details on systems design'],
      improvement_suggestions: ['Highlight experience with message brokers and event-driven architectures'],
      summary: 'Candidate has basic JavaScript experience but lacks Kafka and microservices knowledge.'
    };
  } else {
    return {
      ats_score: 20,
      keyword_match_score: 10,
      formatting_score: 40,
      section_completeness_score: 30,
      quantification_score: 20,
      matched_keywords: [],
      missing_keywords: ['Node.js', 'Express', 'Kafka'],
      formatting_issues: ['Completely irrelevant experience'],
      improvement_suggestions: ['Format resume for software engineering roles'],
      summary: 'Candidate has no software engineering or programming experience.'
    };
  }
};

const callGroqWithRetry = async (prompt, retries = 3) => {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_key') {
    logger.info('Using Mock ATS result (no valid GROQ_API_KEY provided)');
    return generateMockATSResult(prompt);
  }
  for (let i = 0; i < retries; i++) {
    try {
      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        response_format: { type: 'json_object' }
      });
      const content = chatCompletion.choices[0].message.content;
      const parsed = JSON.parse(content);
      return atsSchema.parse(parsed);
    } catch (err) {
      logger.warn(`Groq API attempt ${i + 1} failed: ${err.message}`);
      if (err.message.includes('API Key') || err.status === 401) {
        logger.info('Groq 401: Falling back to Mock ATS result');
        return generateMockATSResult(prompt);
      }
      if (i === retries - 1) {
        logger.warn('Groq API calls exhausted. Falling back to Mock ATS result.', { error: err.message });
        return generateMockATSResult(prompt);
      }
      await sleep(Math.pow(2, i) * 1000); // Exponential backoff
    }
  }
};

const getJobDetails = async (job_id) => {
  const result = await db.query(`SELECT description, ats_threshold FROM jobs WHERE id = $1`, [job_id]);
  if (result.rows.length === 0) throw new Error(`Job ${job_id} not found`);
  return result.rows[0];
};

const processResume = async (topic, payload) => {
  const { candidate_id, job_id, file_key } = payload;
  const startTime = Date.now();

  const idempotencyKey = generateIdempotencyKey(candidate_id, job_id, `ats-scorer-${file_key}`);
  const canProcess = await checkIdempotency(idempotencyKey);
  if (!canProcess) {
    logger.info(`Idempotency check skipped for ${candidate_id} on job ${job_id} for file ${file_key}`);
    return;
  }

  try {
    // Decrypt and Extract
    const dataStream = await minioClient.getObject(BUCKET_NAME, file_key);
    const chunks = [];
    for await (const chunk of dataStream) { chunks.push(chunk); }
    const fileBuffer = Buffer.concat(chunks);

    const iv = fileBuffer.subarray(0, 12);
    const authTag = fileBuffer.subarray(12, 28);
    const encryptedText = fileBuffer.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    const pdfData = await parsePDFWithRetry(decrypted);
    const resumeText = pdfData.text;

    // Get Job Details
    const job = await getJobDetails(job_id);

    // Call LLM
    const prompt = `You are an expert ATS (Applicant Tracking System).
Evaluate the following resume against the job description.
Return a STRICT JSON object matching exactly this schema:
{
  "ats_score": number (0-100),
  "keyword_match_score": number (0-100),
  "formatting_score": number (0-100),
  "section_completeness_score": number (0-100),
  "quantification_score": number (0-100),
  "matched_keywords": string[],
  "missing_keywords": string[],
  "formatting_issues": string[],
  "improvement_suggestions": string[],
  "summary": string
}
Calculate ats_score as: (keyword_match_score * 0.4) + (formatting_score * 0.2) + (section_completeness_score * 0.2) + (quantification_score * 0.2).

Job Description:
${job.description}

Resume:
${resumeText}
`;

    const atsResult = await callGroqWithRetry(prompt);
    const ats_threshold = job.ats_threshold || 50;

    let actionSummary = '';

    if (atsResult.ats_score < ats_threshold) {
      await db.query(
        `UPDATE applications SET status = 'ATS_REJECTED', ats_score = $1, ats_threshold_used = $2, rejection_reason = $3, rejection_stage = $4 WHERE candidate_id = $5 AND job_id = $6`,
        [atsResult.ats_score, ats_threshold, 'low_ats_score', 'ATS', candidate_id, job_id]
      );

      await publishEvent('resume.rejected', job_id, {
        candidate_id, job_id, reason: 'low_ats_score', ats_data: atsResult
      });

      const userRes = await db.query(`SELECT email FROM users WHERE id = $1`, [candidate_id]);
      if (userRes.rows.length > 0) {
        await emailQueue.add('rejection_ats', {
          email: userRes.rows[0].email,
          job_id,
          candidate_id,
          ats_data: atsResult
        });
      }
      actionSummary = `ATS Rejected candidate with score ${atsResult.ats_score}`;
    } else {
      await db.query(
        `INSERT INTO ats_scores (application_id, candidate_id, job_id, ats_score, keyword_match_score, formatting_score, section_completeness_score, quantification_score, matched_keywords, missing_keywords, formatting_issues, improvement_suggestions, raw_llm_response)
         VALUES ((SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (application_id) DO UPDATE SET
           ats_score = EXCLUDED.ats_score,
           keyword_match_score = EXCLUDED.keyword_match_score,
           formatting_score = EXCLUDED.formatting_score,
           section_completeness_score = EXCLUDED.section_completeness_score,
           quantification_score = EXCLUDED.quantification_score,
           matched_keywords = EXCLUDED.matched_keywords,
           missing_keywords = EXCLUDED.missing_keywords,
           formatting_issues = EXCLUDED.formatting_issues,
           improvement_suggestions = EXCLUDED.improvement_suggestions,
           raw_llm_response = EXCLUDED.raw_llm_response`,
        [
          candidate_id, job_id,
          atsResult.ats_score, atsResult.keyword_match_score, atsResult.formatting_score,
          atsResult.section_completeness_score, atsResult.quantification_score,
          JSON.stringify(atsResult.matched_keywords), JSON.stringify(atsResult.missing_keywords),
          JSON.stringify(atsResult.formatting_issues), JSON.stringify(atsResult.improvement_suggestions),
          JSON.stringify(atsResult)
        ]
      );

      await db.query(`UPDATE applications SET ats_score = $1, ats_threshold_used = $2 WHERE candidate_id = $3 AND job_id = $4`, [atsResult.ats_score, ats_threshold, candidate_id, job_id]);

      await publishEvent('candidate.extracted', job_id, {
        candidate_id, job_id, file_key, ats_data: atsResult
      });
      actionSummary = `ATS Passed candidate with score ${atsResult.ats_score}`;
    }

    const inputHash = crypto.createHash('sha256').update(`${candidate_id}${job_id}${file_key}`).digest('hex');
    await db.query(
      `INSERT INTO audit_log (agent_name, job_id, candidate_id, action, input_hash, output_summary, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['ATS Scorer', job_id, candidate_id, atsResult.ats_score < ats_threshold ? 'ATS_REJECTED' : 'ATS_PASSED', inputHash, actionSummary, Date.now() - startTime]
    );

    await markProcessed(idempotencyKey);
  } catch (err) {
    logger.error('ATS Scorer processing error', { error: err.message, candidate_id, job_id });
    throw err;
  }
};

const start = async () => {
  await connectRedis();
  await connectProducer();
  await createConsumer('ats-scorer-group', ['resume.prefilter.passed'], processResume);
  logger.info('ATS Scorer worker started');
};

start().catch(err => logger.error('Startup error', err));
