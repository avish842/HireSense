require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const db = require('../libs/shared/db');

async function run() {
  try {
    const jobs = await db.query('SELECT * FROM jobs');
    console.log('--- ALL JOBS ---');
    jobs.rows.forEach(j => {
      console.log(`ID: ${j.id}`);
      console.log(`Title: ${j.title}`);
      console.log(`Required Skills: ${JSON.stringify(j.required_skills)}`);
      console.log(`Min Skill Hit Ratio: ${j.min_skill_hit_ratio}`);
      console.log('------------');
    });
  } catch (e) {
    console.error(e);
  } finally {
    db.pool.end();
  }
}

run();
