require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const { Queue } = require('bullmq');
const Groq = require('groq-sdk');
const { logger, db, createConsumer, publishEvent, checkIdempotency, markProcessed, generateIdempotencyKey, connectRedis, redisClient, connectProducer } = require('@autohire/shared');

const emailQueue = new Queue('emailQueue', {
  connection: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379') }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const callGroqWithRetry = async (prompt, retries = 3) => {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_key') {
    logger.info('Using Mock Interviewer Notes (no valid GROQ_API_KEY provided)');
    return null;
  }
  for (let i = 0; i < retries; i++) {
    try {
      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
      });
      return chatCompletion.choices[0].message.content.trim();
    } catch (err) {
      logger.warn(`Groq API attempt ${i + 1} failed for interviewer notes: ${err.message}`);
      if (i === retries - 1) {
        logger.warn('Groq API calls exhausted for interviewer notes. Falling back.');
        return null;
      }
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
  return null;
};

const generateMockInterviewerNotes = (profile, ats) => {
  const years = profile.experience_years || 5;
  const skillsList = Array.isArray(profile.skills) ? profile.skills.slice(0, 5).join(', ') : 'Node.js, Express, JavaScript';
  const missing = Array.isArray(ats.missing_keywords) ? ats.missing_keywords.slice(0, 3).join(', ') : 'None';
  
  return `### Candidate Interview Briefing

**Candidate Background**
The candidate is a backend software engineer with ${years} years of experience specializing in node-based API services and database structures.

**Key Resume Highlights**
- Worked on scalable backend APIs and microservices deployment.
- Technical skills include: ${skillsList}.

**Strengths & Strong Areas**
- High compatibility match score: ${ats.ats_score || 85}/100.
- Good formatting and structured experience representation.

**Weakness & Growth Areas**
- Lacks explicit keyword match for: ${missing}.
- Need to verify familiarity with large-scale distributed architectures during the technical interview.

**Recommended Vetting Questions**
1. Can you explain your design process when building and scaling API routing endpoints?
2. How do you handle concurrency, race conditions, or scaling performance in a Node.js microservice?`;
};

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

const processScheduler = async (topic, payload) => {
  const { candidate_id, job_id, file_key, final_score } = payload;
  const startTime = Date.now();

  const idempotencyKey = generateIdempotencyKey(candidate_id, job_id, `scheduler-${file_key}`);
  if (!(await checkIdempotency(idempotencyKey))) return;

  try {
    const job = await getJobDetails(job_id);
    const score_threshold = job.score_threshold || 70;

    let actionSummary = '';

    if (final_score >= score_threshold) {
      // Book interview: tomorrow at 10 AM
      const scheduled_at = new Date();
      scheduled_at.setDate(scheduled_at.getDate() + 1);
      scheduled_at.setHours(10, 0, 0, 0);
      const meeting_link = `https://meet.autohire.com/${crypto.randomBytes(4).toString('hex')}`;

      // Generate Interviewer Notes
      let interviewerNotes = null;
      try {
        const profileRes = await db.query(
          `SELECT name, email, skills, experience_years, education, projects, location 
           FROM extracted_profiles 
           WHERE application_id = (SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2)`,
          [candidate_id, job_id]
        );
        const profile = profileRes.rows[0] || {};

        const atsRes = await db.query(
          `SELECT ats_score, matched_keywords, missing_keywords, improvement_suggestions 
           FROM ats_scores 
           WHERE application_id = (SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2)`,
          [candidate_id, job_id]
        );
        const ats = atsRes.rows[0] || {};

        const notesPrompt = `You are an expert technical recruiter preparing a briefing sheet for an interviewer.
Analyze this candidate's profile and screening details to generate clean, professional Interviewer Notes.
Keep the notes concise, highly scannable, and maximum one page (no more than 300-400 words).
Use Markdown headings, bullet points, and bold text.

CANDIDATE PROFILE:
- Name: ${profile.name || 'Candidate'}
- Location: ${profile.location || 'N/A'}
- Experience: ${profile.experience_years || 0} years
- Education: ${JSON.stringify(profile.education || [])}
- Skills: ${JSON.stringify(profile.skills || [])}
- Projects: ${JSON.stringify(profile.projects || [])}

SCREENING FEEDBACK:
- ATS Score: ${ats.ats_score || 'N/A'}/100
- Matched Keywords: ${JSON.stringify(ats.matched_keywords || [])}
- Missing Keywords: ${JSON.stringify(ats.missing_keywords || [])}
- Improvement Suggestions: ${JSON.stringify(ats.improvement_suggestions || [])}

Format the notes exactly as follows:
### Candidate Interview Briefing

**Candidate Background**
[Brief 1-2 sentence overview of candidate's career, experience, and educational background]

**Key Resume Highlights**
- [Highlight 1: Notable project or key technical skills]
- [Highlight 2: Relevant experience depth or alignment with job profile]

**Strengths & Strong Areas**
- [Strength 1: High keyword overlap, key technologies mastered]
- [Strength 2: Formatting completeness, project application]

**Weakness & Growth Areas**
- [Weakness 1: Missing keywords or skill gaps]
- [Weakness 2: Areas that need deeper technical vetting]

**Recommended Vetting Questions**
1. [Tailored Question 1 addressing a weakness or project detail]
2. [Tailored Question 2 addressing technology alignment]
`;

        interviewerNotes = await callGroqWithRetry(notesPrompt);
        if (!interviewerNotes) {
          interviewerNotes = generateMockInterviewerNotes(profile, ats);
        }
      } catch (err) {
        logger.warn('Failed to generate AI interviewer notes, falling back to mock notes:', err.message);
        // Fallback
        const profileRes = await db.query(
          `SELECT name, email, skills, experience_years, education, projects, location 
           FROM extracted_profiles 
           WHERE application_id = (SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2)`,
          [candidate_id, job_id]
        );
        const profile = profileRes.rows[0] || {};

        const atsRes = await db.query(
          `SELECT ats_score, matched_keywords, missing_keywords, improvement_suggestions 
           FROM ats_scores 
           WHERE application_id = (SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2)`,
          [candidate_id, job_id]
        );
        const ats = atsRes.rows[0] || {};
        interviewerNotes = generateMockInterviewerNotes(profile, ats);
      }

      // Insert/Update interview record
      await db.query(
        `INSERT INTO interviews (application_id, candidate_id, job_id, scheduled_at, meeting_link, interviewer_notes)
         VALUES ((SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2), $1, $2, $3, $4, $5)
         ON CONFLICT (application_id) DO UPDATE SET
           scheduled_at = EXCLUDED.scheduled_at,
           meeting_link = EXCLUDED.meeting_link,
           interviewer_notes = EXCLUDED.interviewer_notes`,
        [candidate_id, job_id, scheduled_at, meeting_link, interviewerNotes]
      );

      // Update application status
      await db.query(
        `UPDATE applications SET status = 'INTERVIEW_SCHEDULED' WHERE candidate_id = $1 AND job_id = $2`,
        [candidate_id, job_id]
      );

      // Get Candidate Email
      const userRes = await db.query(`SELECT email FROM users WHERE id = $1`, [candidate_id]);
      const email = userRes.rows[0]?.email;

      if (email) {
        await emailQueue.add('interview_scheduled', {
          email,
          job_id,
          candidate_id,
          scheduled_at,
          meeting_link
        });
      }

      await publishEvent('interview.scheduled', job_id, {
        candidate_id, job_id, scheduled_at, meeting_link
      });

      // Broadcast update
      await redisClient.publish('dashboard_updates', JSON.stringify({
        type: 'PIPELINE_UPDATE',
        job_id,
        candidate_id,
        status: 'INTERVIEW_SCHEDULED'
      }));

      actionSummary = `Interview scheduled for ${scheduled_at.toISOString()}`;
    } else {
      actionSummary = `Candidate score ${final_score} below threshold ${score_threshold}, no interview booked.`;
    }

    const inputHash = crypto.createHash('sha256').update(`${candidate_id}${job_id}`).digest('hex');
    await db.query(
      `INSERT INTO audit_log (agent_name, job_id, candidate_id, action, input_hash, output_summary, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['Scheduler Agent', job_id, candidate_id, final_score >= score_threshold ? 'INTERVIEW_SCHEDULED' : 'SKIPPED', inputHash, actionSummary, Date.now() - startTime]
    );

    await markProcessed(idempotencyKey);
  } catch (err) {
    logger.error('Scheduler error', { error: err.message, candidate_id, job_id });
    throw err;
  }
};

const start = async () => {
  await connectRedis();
  await connectProducer();

  try {
    await db.query(`ALTER TABLE interviews ADD COLUMN IF NOT EXISTS interviewer_notes TEXT;`);
    logger.info('DB migration: added interviewer_notes to interviews table (if not exists)');
  } catch (err) {
    logger.warn('Failed to add interviewer_notes column to interviews table:', err.message);
  }

  await createConsumer('scheduler-group', ['candidate.scored'], processScheduler);
  logger.info('Scheduler Agent started');
};

start().catch(err => logger.error('Startup error', err));
