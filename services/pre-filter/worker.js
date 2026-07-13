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
const { logger, db, redisClient, createConsumer, publishEvent, checkIdempotency, markProcessed, generateIdempotencyKey, connectRedis, connectProducer } = require('@autohire/shared');

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'autohire_minio',
  secretKey: process.env.MINIO_SECRET_KEY || 'autohire_minio_secret'
});

const BUCKET_NAME = 'resumes';
const ENCRYPTION_KEY = Buffer.from(process.env.FILE_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

// Email queue
const emailQueue = new Queue('emailQueue', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
});

const getJobRequirements = async (job_id) => {
  const cacheKey = `job_reqs:${job_id}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const result = await db.query(`SELECT required_skills, required_keywords, min_skill_hit_ratio FROM jobs WHERE id = $1`, [job_id]);
  if (result.rows.length === 0) throw new Error(`Job ${job_id} not found`);

  const reqs = result.rows[0];
  await redisClient.set(cacheKey, JSON.stringify(reqs), { EX: 600 }); // 10 min TTL
  return reqs;
};

const processResume = async (topic, payload) => {
  const { candidate_id, job_id, file_key } = payload;
  const startTime = Date.now();

  const idempotencyKey = generateIdempotencyKey(candidate_id, job_id, `pre-filter-${file_key}`);
  const canProcess = await checkIdempotency(idempotencyKey);
  if (!canProcess) {
    logger.info(`Idempotency check skipped for ${candidate_id} on job ${job_id} for file ${file_key}`);
    return;
  }

  try {
    // 1. Decrypt from MinIO
    const dataStream = await minioClient.getObject(BUCKET_NAME, file_key);
    const chunks = [];
    for await (const chunk of dataStream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    const iv = fileBuffer.subarray(0, 12);
    const authTag = fileBuffer.subarray(12, 28);
    const encryptedText = fileBuffer.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // 2. Extract PDF Text
    const pdfData = await parsePDFWithRetry(decrypted);
    
    // 3. Get Job Reqs
    const reqs = await getJobRequirements(job_id);
    const requiredSkills = reqs.required_skills || [];
    
    // 4. Compute Hit Ratio (with robust spacing/punctuation normalization)
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedResumeText = normalize(pdfData.text);

    let matched = 0;
    for (const skill of requiredSkills) {
      const normalizedSkill = normalize(skill);
      if (normalizedSkill && normalizedResumeText.includes(normalizedSkill)) {
        matched++;
      }
    }
    const hit_ratio = requiredSkills.length > 0 ? matched / requiredSkills.length : 1.0;

    let pre_filter_status = '';
    let actionSummary = '';

    if (hit_ratio < reqs.min_skill_hit_ratio) {
      pre_filter_status = 'PRE_FILTER_REJECTED';
      
      await db.query(
        `UPDATE applications SET pre_filter_status = $1, pre_filter_hit_ratio = $2, rejection_reason = $3, rejection_stage = $4, status = $1 WHERE candidate_id = $5 AND job_id = $6`,
        [pre_filter_status, hit_ratio, 'insufficient skill match', 'PRE_FILTER', candidate_id, job_id]
      );

      await publishEvent('resume.rejected', job_id, {
        candidate_id, job_id, reason: 'skill_mismatch', hit_ratio
      });

      // Dispatch rejection email
      const userRes = await db.query(`SELECT email FROM users WHERE id = $1`, [candidate_id]);
      if (userRes.rows.length > 0) {
        await emailQueue.add('rejection_skill_mismatch', {
          email: userRes.rows[0].email,
          job_id,
          candidate_id
        });
      }

      actionSummary = `Rejected candidate with hit ratio ${hit_ratio}`;
    } else {
      pre_filter_status = 'PRE_FILTER_PASSED';

      await db.query(
        `UPDATE applications SET pre_filter_status = $1, pre_filter_hit_ratio = $2, status = $1 WHERE candidate_id = $3 AND job_id = $4`,
        [pre_filter_status, hit_ratio, candidate_id, job_id]
      );

      await publishEvent('resume.prefilter.passed', job_id, {
        candidate_id, job_id, file_key, hit_ratio
      });

      actionSummary = `Passed candidate with hit ratio ${hit_ratio}`;
    }

    // Write to audit_log
    const inputHash = crypto.createHash('sha256').update(`${candidate_id}${job_id}${file_key}`).digest('hex');
    await db.query(
      `INSERT INTO audit_log (agent_name, job_id, candidate_id, action, input_hash, output_summary, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['Pre-filter Worker', job_id, candidate_id, pre_filter_status, inputHash, actionSummary, Date.now() - startTime]
    );

    await markProcessed(idempotencyKey);
  } catch (err) {
    logger.error('Pre-filter processing error', { error: err.message, candidate_id, job_id });
    throw err;
  }
};

const start = async () => {
  await connectRedis();
  await connectProducer();
  await createConsumer('prefilter-group', ['resume.uploaded'], processResume);
  logger.info('Pre-filter worker started');
};

start().catch(err => logger.error('Startup error', err));
