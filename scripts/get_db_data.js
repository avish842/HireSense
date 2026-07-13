require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const db = require('../libs/shared/db');

async function run() {
  try {
    const jobs = await db.query('SELECT id, title FROM jobs');
    console.log('--- JOBS ---');
    jobs.rows.forEach(j => {
      console.log(`ID: ${j.id} | Title: ${j.title}`);
    });

    const users = await db.query('SELECT id, email, role FROM users');
    console.log('\n--- USERS ---');
    users.rows.forEach(u => {
      console.log(`ID: ${u.id} | Email: ${u.email} | Role: ${u.role}`);
    });

    const applications = await db.query('SELECT id, candidate_id, job_id, status, pre_filter_status, ats_score, rejection_stage, rejection_reason, file_key, created_at FROM applications');
    console.log('\n--- APPLICATIONS ---');
    applications.rows.forEach(app => {
      console.log(`ID: ${app.id} | Candidate: ${app.candidate_id} | Job: ${app.job_id} | Status: ${app.status} | Pre-Filter: ${app.pre_filter_status} | ATS: ${app.ats_score} | Rej Stage: ${app.rejection_stage} | Rej Reason: ${app.rejection_reason} | File Key: ${app.file_key} | Created At: ${app.created_at.toISOString()}`);
    });

    const atsScores = await db.query('SELECT id, application_id, ats_score, matched_keywords FROM ats_scores');
    console.log('\n--- ATS SCORES ---');
    atsScores.rows.forEach(score => {
      console.log(`ID: ${score.id} | App: ${score.application_id} | ATS Score: ${score.ats_score} | Keywords: ${score.matched_keywords}`);
    });

    const extracted = await db.query('SELECT id, application_id, name, email FROM extracted_profiles');
    console.log('\n--- EXTRACTED PROFILES ---');
    extracted.rows.forEach(profile => {
      console.log(`ID: ${profile.id} | App: ${profile.application_id} | Name: ${profile.name} | Email: ${profile.email}`);
    });

    const auditLogs = await db.query('SELECT agent_name, action, output_summary, timestamp FROM audit_log ORDER BY timestamp DESC LIMIT 20');
    console.log('\n--- AUDIT LOGS (last 20) ---');
    auditLogs.rows.forEach(log => {
      console.log(`${log.timestamp.toISOString()} | Agent: ${log.agent_name} | Action: ${log.action} | Summary: ${log.output_summary}`);
    });
  } catch (e) {
    console.error(e);
  } finally {
    db.pool.end();
  }
}

run();

