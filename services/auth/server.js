require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { logger, db, verifyToken, requireRole } = require('@hiresense/shared');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost') || origin.endsWith('.ngrok-free.app') || origin.endsWith('.ngrok-free.dev') || origin === process.env.FRONTEND_URL) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'supersecretrefresh';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'RECRUITER', 'CANDIDATE'])
});

app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, role } = registerSchema.parse(req.body);
    const hash = await bcrypt.hash(password, 12);
    
    const result = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role`,
      [email, hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('Registration error', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const accessToken = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user.id, role: user.role }, REFRESH_SECRET, { expiresIn: '7d' });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/refresh', (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  jwt.verify(token, REFRESH_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid refresh token' });

    const newAccessToken = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '15m' });
    const newRefreshToken = jwt.sign({ id: user.id, role: user.role }, REFRESH_SECRET, { expiresIn: '7d' });

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ accessToken: newAccessToken });
  });
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('refreshToken');
  res.json({ message: 'Logged out' });
});

app.get('/auth/jobs', verifyToken, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM jobs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    logger.error('Error fetching jobs', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/jobs', verifyToken, requireRole('RECRUITER', 'ADMIN'), async (req, res) => {
  try {
    const { title, description, required_skills, required_keywords, min_skill_hit_ratio, ats_threshold, score_threshold, created_by } = req.body;
    const result = await db.query(
      `INSERT INTO jobs (title, description, required_skills, required_keywords, min_skill_hit_ratio, ats_threshold, score_threshold, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        title,
        description,
        JSON.stringify(required_skills || []),
        JSON.stringify(required_keywords || []),
        min_skill_hit_ratio ? parseFloat(min_skill_hit_ratio) : 0.3,
        ats_threshold ? parseInt(ats_threshold) : 50,
        score_threshold ? parseInt(score_threshold) : 70,
        created_by
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('Error creating job', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.get('/auth/users', verifyToken, requireRole('ADMIN'), async (req, res) => {
  try {
    const result = await db.query('SELECT id, email, role FROM users ORDER BY email ASC');
    res.json(result.rows);
  } catch (err) {
    logger.error('Error fetching users', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/applications', verifyToken, requireRole('RECRUITER', 'ADMIN'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        a.id, a.candidate_id, a.job_id, a.status, a.pre_filter_status, 
        a.pre_filter_hit_ratio, a.ats_score, a.rejection_reason, 
        a.rejection_stage, a.final_score, a.created_at,
        u.email as candidate_email, j.title as job_title,
        i.meeting_link, i.scheduled_at, i.interviewer_notes
      FROM applications a
      JOIN users u ON a.candidate_id = u.id
      JOIN jobs j ON a.job_id = j.id
      LEFT JOIN interviews i ON a.id = i.application_id
      ORDER BY a.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error('Error fetching applications', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Auth service listening on port ${PORT}`);
});
