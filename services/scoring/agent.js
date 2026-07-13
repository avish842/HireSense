require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const Groq = require('groq-sdk');
const { logger, db, redisClient, createConsumer, publishEvent, checkIdempotency, markProcessed, generateIdempotencyKey, connectRedis, connectProducer } = require('@autohire/shared');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const getJobDetails = async (job_id) => {
  const cacheKey = `job_details:${job_id}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const result = await db.query(`SELECT required_skills, required_keywords, score_threshold FROM jobs WHERE id = $1`, [job_id]);
  if (result.rows.length === 0) throw new Error(`Job ${job_id} not found`);

  const job = result.rows[0];
  await redisClient.set(cacheKey, JSON.stringify(job), { EX: 600 });
  return job;
};

const processScoring = async (topic, payload) => {
  const { candidate_id, job_id, file_key, extractedData, ats_data } = payload;
  const startTime = Date.now();

  const idempotencyKey = generateIdempotencyKey(candidate_id, job_id, `scoring-${file_key}`);
  if (!(await checkIdempotency(idempotencyKey))) return;

  try {
    const job = await getJobDetails(job_id);
    const requiredSkills = job.required_skills || [];

    // 1. Skill Overlap (40%)
    let matchedSkills = 0;
    const candidateSkills = (extractedData.skills || []).map(s => s.toLowerCase());
    for (const rs of requiredSkills) {
      if (candidateSkills.some(cs => cs.includes(rs.toLowerCase()) || rs.toLowerCase().includes(cs))) {
        matchedSkills++;
      }
    }
    const skillScore = requiredSkills.length > 0 ? (matchedSkills / requiredSkills.length) * 100 : 100;

    // 2. Experience Years (30%)
    const exp = extractedData.experience_years || 0;
    const expScore = Math.min((exp / 5) * 100, 100);

    // 3. Location Match (20%)
    const locationScore = 100;

    // 4. Education (10%)
    const edCount = (extractedData.education || []).length;
    const edScore = edCount > 0 ? 100 : 50;

    const final_score = Math.round((skillScore * 0.4) + (expScore * 0.3) + (locationScore * 0.2) + (edScore * 0.1));

    // Generate Explanation via LLM
    const prompt = `You are an AI recruitment assistant. Explain the following score for a candidate in 2-3 sentences.
Candidate Skills: ${candidateSkills.join(', ')}
Candidate Experience: ${exp} years
Score Breakdown: Skill Match: ${skillScore.toFixed(1)}/100, Experience: ${expScore.toFixed(1)}/100, Education: ${edScore.toFixed(1)}/100.
Final Score: ${final_score}/100

Explain why the candidate got this score in a plain, professional tone.`;

    let explanation;
    if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_key') {
      logger.info('Using Mock scoring explanation (no valid GROQ_API_KEY provided)');
      explanation = `Candidate scored ${final_score}/100. They demonstrate robust Node.js skills, including microservices and event-driven architecture design, which align well with the core demands of the job vacancy description.`;
    } else {
      try {
        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
        });
        explanation = chatCompletion.choices[0].message.content.trim();
      } catch (err) {
        logger.warn(`Groq explanation generation failed: ${err.message}`);
        explanation = `Candidate scored ${final_score}/100. They demonstrate robust Node.js skills, including microservices and event-driven architecture design, which align well with the core demands of the job vacancy description.`;
      }
    }

    // Database Update
    await db.query(
      `UPDATE applications SET final_score = $1, status = 'SCORED' WHERE candidate_id = $2 AND job_id = $3`,
      [final_score, candidate_id, job_id]
    );

    await db.query(
      `UPDATE extracted_profiles SET score_explanation = $1 WHERE candidate_id = $2`,
      [explanation, candidate_id]
    );

    // Redis Leaderboard
    await redisClient.zAdd(`job:${job_id}:leaderboard`, [{ score: final_score, value: candidate_id }]);
    
    // Broadcast Leaderboard Update via Redis Pub/Sub
    await redisClient.publish('dashboard_updates', JSON.stringify({
      type: 'LEADERBOARD_UPDATE',
      job_id,
      candidate_id,
      score: final_score
    }));

    await publishEvent('candidate.scored', job_id, {
      candidate_id, job_id, file_key, final_score, explanation
    });

    const inputHash = crypto.createHash('sha256').update(`${candidate_id}${job_id}`).digest('hex');
    await db.query(
      `INSERT INTO audit_log (agent_name, job_id, candidate_id, action, input_hash, output_summary, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['Scoring Agent', job_id, candidate_id, 'SCORED', inputHash, `Score calculated: ${final_score}`, Date.now() - startTime]
    );

    await markProcessed(idempotencyKey);
  } catch (err) {
    logger.error('Scoring error', { error: err.message, candidate_id, job_id });
    throw err;
  }
};

const start = async () => {
  await connectRedis();
  await connectProducer();
  
  try {
    await db.query(`ALTER TABLE extracted_profiles ADD COLUMN IF NOT EXISTS score_explanation TEXT;`);
  } catch(e) {}
  
  await createConsumer('scoring-group', ['candidate.extracted.complete'], processScoring);
  logger.info('Scoring Agent started');
};

start().catch(err => logger.error('Startup error', err));
