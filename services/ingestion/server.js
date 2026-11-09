require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { Client } = require('minio');
const { logger, db, redisClient, publishEvent, connectRedis, connectProducer, verifyToken } = require('@hiresense/shared');

const app = express();
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
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'autohire_minio',
  secretKey: process.env.MINIO_SECRET_KEY || 'autohire_minio_secret'
});

const BUCKET_NAME = 'resumes';
const ENCRYPTION_KEY = Buffer.from(process.env.FILE_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex'); // 32 bytes

// Rate Limiter: Token Bucket
const checkRateLimit = async (userId) => {
  const limit = 10;
  const windowInSeconds = 3600; // 1 hour
  const key = `rate_limit:${userId}`;
  
  const current = await redisClient.get(key);
  if (current && parseInt(current) >= limit) {
    return false;
  }
  
  const multi = redisClient.multi();
  multi.incr(key);
  if (!current) {
    multi.expire(key, windowInSeconds);
  }
  await multi.exec();
  return true;
};

app.post('/ingestion/upload', verifyToken, upload.single('resume'), async (req, res) => {
  try {
    const { candidate_id, job_id } = req.body;
    if (!candidate_id || !job_id) return res.status(400).json({ error: 'Missing candidate_id or job_id' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const allowed = await checkRateLimit(candidate_id);
    if (!allowed) return res.status(429).json({ error: 'Rate limit exceeded (10 uploads/hour)' });

    // Encrypt File using AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(req.file.buffer);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // The stored object will be: IV (12 bytes) + AuthTag (16 bytes) + CipherText
    const fileData = Buffer.concat([iv, authTag, encrypted]);
    const file_key = `${job_id}/${candidate_id}-${Date.now()}.pdf.enc`;

    const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
    if (!bucketExists) {
      await minioClient.makeBucket(BUCKET_NAME);
    }

    await minioClient.putObject(BUCKET_NAME, file_key, fileData);

    // Clear old pipeline data for re-applications to ensure clean state
    const appRes = await db.query(
      `SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2`,
      [candidate_id, job_id]
    );
    if (appRes.rows.length > 0) {
      const appId = appRes.rows[0].id;
      await db.query(`DELETE FROM interviews WHERE application_id = $1`, [appId]);
      await db.query(`DELETE FROM extracted_profiles WHERE application_id = $1`, [appId]);
      await db.query(`DELETE FROM ats_scores WHERE application_id = $1`, [appId]);
    }

    // Initial Database Entry
    await db.query(
      `INSERT INTO applications (candidate_id, job_id, file_key, status, pre_filter_status, pre_filter_hit_ratio, ats_score, ats_threshold_used, rejection_reason, rejection_stage, final_score) 
       VALUES ($1, $2, $3, 'UPLOADED', NULL, NULL, NULL, NULL, NULL, 'NONE', NULL)
       ON CONFLICT (candidate_id, job_id) DO UPDATE SET 
         file_key = EXCLUDED.file_key, 
         status = 'UPLOADED',
         pre_filter_status = NULL,
         pre_filter_hit_ratio = NULL,
         ats_score = NULL,
         ats_threshold_used = NULL,
         rejection_reason = NULL,
         rejection_stage = 'NONE',
         final_score = NULL`,
      [candidate_id, job_id, file_key]
    );

    // Publish Event
    const payload = {
      candidate_id,
      job_id,
      file_key,
      upload_timestamp: new Date().toISOString()
    };
    
    await publishEvent('resume.uploaded', job_id, payload);

    res.status(200).json({ message: 'Resume uploaded successfully', file_key });
  } catch (err) {
    logger.error('Upload error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

const start = async () => {
  await connectRedis();
  await connectProducer();
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    logger.info(`Ingestion service listening on port ${PORT}`);
  });
};

start().catch(err => logger.error('Startup error', err));
