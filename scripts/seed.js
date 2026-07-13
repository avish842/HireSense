require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://autohire_user:autohire_password@localhost:5432/autohire_db' });

const generatePDF = (filename, content) => {
  return new Promise((resolve) => {
    const resumesDir = path.join(__dirname, 'resumes');
    if (!fs.existsSync(resumesDir)) fs.mkdirSync(resumesDir);
    const filepath = path.join(resumesDir, filename);
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);
    doc.text(content);
    doc.end();
    stream.on('finish', () => resolve(filepath));
  });
};

const run = async () => {
  try {
    const hash = await bcrypt.hash('password123', 12);

    // Users
    console.log('Seeding users...');
    const admin = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('admin@autohire.com', $1, 'ADMIN') ON CONFLICT DO NOTHING RETURNING id`, [hash]);
    
    const rec1 = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('recruiter1@autohire.com', $1, 'RECRUITER') ON CONFLICT DO NOTHING RETURNING id`, [hash]);
    const rec2 = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('recruiter2@autohire.com', $1, 'RECRUITER') ON CONFLICT DO NOTHING RETURNING id`, [hash]);
    
    for (let i=1; i<=5; i++) {
      await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('candidate${i}@autohire.com', $1, 'CANDIDATE') ON CONFLICT DO NOTHING`, [hash]);
    }
    
    let recruiterId = rec1.rows.length ? rec1.rows[0].id : (await pool.query(`SELECT id FROM users WHERE email='recruiter1@autohire.com'`)).rows[0].id;

    // Jobs
    console.log('Seeding jobs...');
    await pool.query(`
      INSERT INTO jobs (title, description, required_skills, required_keywords, min_skill_hit_ratio, ats_threshold, score_threshold, created_by)
      VALUES 
      ('Senior Node.js Developer', 'We need an expert in Node.js, Express, Microservices, and Kafka.', '["Node.js", "Express", "Microservices", "Kafka"]'::jsonb, '["API", "Backend", "Scalable"]'::jsonb, 0.5, 60, 75, $1),
      ('Frontend React Engineer', 'Looking for a Vite + React SPA expert. Experience with WebSockets and Recharts required.', '["React", "Vite", "WebSockets", "Recharts"]'::jsonb, '["SPA", "Frontend", "UI"]'::jsonb, 0.4, 50, 70, $1)
    `, [recruiterId]);

    // Generate PDFs
    console.log('Generating sample PDFs...');
    await generatePDF('strong_match.pdf', `
John Doe - Senior Backend Engineer
john@example.com

Experience:
- 6 years of experience building scalable backend APIs.
- Expert in Node.js and Express framework.
- Built event-driven architectures using Kafka and Microservices.
- Managed database migrations.

Skills: Node.js, Express, Microservices, Kafka, API, Backend, Scalable.
Education: BS Computer Science.
    `);

    await generatePDF('borderline.pdf', `
Jane Smith - Software Engineer
jane@example.com

Experience:
- 3 years of experience in web development.
- Familiar with Node.js and basic Express.
- Interested in learning Microservices.
- No direct Kafka experience.

Skills: Node.js, JavaScript, HTML, CSS.
Education: BA English.
    `);

    await generatePDF('clear_reject.pdf', `
Bob Builder - Construction Manager
bob@example.com

Experience:
- 10 years of experience managing construction sites.
- Expert in concrete pouring and team leadership.

Skills: Construction, Management, Concrete.
Education: High School Diploma.
    `);

    console.log('Done! Generated PDFs at scripts/resumes/');
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
};

run();
