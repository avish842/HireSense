require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const db = require('../libs/shared/db');

async function run() {
  try {
    const apps = await db.query('SELECT * FROM applications');
    console.log('--- APPLICATIONS ---');
    apps.rows.forEach(a => {
      console.log(`ID: ${a.id}`);
      console.log(`Candidate ID: ${a.candidate_id}`);
      console.log(`Job ID: ${a.job_id}`);
      console.log(`Status: ${a.status}`);
      console.log(`Pre-filter Status: ${a.pre_filter_status}`);
      console.log(`Pre-filter Hit Ratio: ${a.pre_filter_hit_ratio}`);
      console.log(`ATS Score: ${a.ats_score}`);
      console.log(`Rejection Reason: ${a.rejection_reason}`);
      console.log('------------');
    });

    const logs = await db.query('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10');
    console.log('\n--- AUDIT LOGS (Last 10) ---');
    logs.rows.forEach(l => {
      console.log(`[${l.timestamp.toISOString()}] ${l.agent_name} -> Action: ${l.action} | Output: ${l.output_summary}`);
    });
  } catch (e) {
    console.error(e);
  } finally {
    db.pool.end();
  }
}

run();
