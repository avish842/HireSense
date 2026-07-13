require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Client } = require('minio');

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'autohire_minio',
  secretKey: process.env.MINIO_SECRET_KEY || 'autohire_minio_secret'
});

async function run() {
  try {
    const file_key = '27b3b86f-c675-4c5d-9cdd-ff4020a0455a/ae095b80-187b-4f66-9905-9b4336eb540d-1779591904089.pdf.enc';
    console.log(`Downloading: ${file_key}`);
    const dataStream = await minioClient.getObject('resumes', file_key);
    const chunks = [];
    for await (const chunk of dataStream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);
    console.log('File size:', fileBuffer.length);
    console.log('First 200 bytes as string:', fileBuffer.subarray(0, 200).toString('utf8'));
    console.log('First 200 bytes as hex:', fileBuffer.subarray(0, 200).toString('hex'));
  } catch (e) {
    console.error('Error:', e);
  }
}

run();
