require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const nodemailer = require('nodemailer');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { logger, redisClient, connectRedis } = require('@autohire/shared');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || origin.startsWith('http://localhost') || origin.endsWith('.ngrok-free.app') || origin.endsWith('.ngrok-free.dev') || origin === process.env.FRONTEND_URL) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});

const fs = require('fs');
const path = require('path');

const transporter = nodemailer.createTransport({
  host: process.env.MAILTRAP_HOST,
  port: process.env.MAILTRAP_PORT,
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_PASS
  }
});

const logEmailToFile = async (to, subject, text, icalContent, status = 'SENT') => {
  const logPath = 'c:/Users/decen/.gemini/antigravity/scratch/autohire/emails.log';
  const timestamp = new Date().toISOString();
  const separator = '='.repeat(80);
  const logEntry = `
${separator}
[${timestamp}] [STATUS: ${status}]
TO: ${to}
SUBJECT: ${subject}
BODY:
${text}
${icalContent ? `\nCALENDAR EVENT (.ics):\n${icalContent}\n` : ''}
${separator}\n`;

  try {
    await fs.promises.appendFile(logPath, logEntry, 'utf8');
    logger.info(`Email logged to emails.log (status: ${status})`, { to, subject });
  } catch (err) {
    logger.error('Failed to write to emails.log', { error: err.message });
  }
};

const sendOrSimulateEmail = async (to, subject, text, html, icalEventContent) => {
  const isPlaceholder = !process.env.MAILTRAP_USER || 
                        process.env.MAILTRAP_USER === 'your_user' || 
                        !process.env.MAILTRAP_PASS || 
                        process.env.MAILTRAP_PASS === 'your_pass';

  if (isPlaceholder) {
    logger.info(`Simulating email dispatch (SMTP credentials are placeholders)`, { to, subject });
    await logEmailToFile(to, subject, text, icalEventContent, 'SIMULATED');
    
    // Broadcast websocket alert to the dashboard
    io.emit('dashboard_update', {
      type: 'EMAIL_SENT',
      message: `[Email Sim] Sent '${subject}' notification to ${to}`
    });
    return;
  }

  try {
    const mailOptions = {
      from: '"AutoHire" <no-reply@autohire.com>',
      to,
      subject,
      text,
      html
    };

    if (icalEventContent) {
      mailOptions.icalEvent = {
        method: 'REQUEST',
        content: icalEventContent
      };
    }

    await transporter.sendMail(mailOptions);
    logger.info('Email sent successfully via Mailtrap SMTP', { to, subject });
    await logEmailToFile(to, subject, text, icalEventContent, 'SENT');

    // Broadcast websocket alert to the dashboard
    io.emit('dashboard_update', {
      type: 'EMAIL_SENT',
      message: `[Email SMTP] Dispatched '${subject}' notification to ${to}`
    });
  } catch (err) {
    logger.error('Failed to send email via SMTP, falling back to local simulation', { error: err.message, to, subject });
    await logEmailToFile(to, subject, text, icalEventContent, `SIMULATED_ON_FAILURE (${err.message})`);

    // Broadcast websocket alert to the dashboard with failure detail
    io.emit('dashboard_update', {
      type: 'EMAIL_SENT',
      message: `[Email Failure Fallback] Dispatched '${subject}' notification to ${to} (SMTP error: ${err.message})`
    });
  }
};

const emailWorker = new Worker('emailQueue', async job => {
  const { name, data } = job;
  
  if (name === 'rejection_skill_mismatch') {
    const text = `Thank you for applying. After review, we found your profile does not match the requirements for this role at this time.`;
    await sendOrSimulateEmail(data.email, 'Update on your application', text, `<p>${text}</p>`);
  } 
  else if (name === 'rejection_ats') {
    const { ats_score, matched_keywords, missing_keywords, improvement_suggestions } = data.ats_data;
    const text = `Thank you for applying. After review, we found your profile does not match the requirements for this role at this time.
    
ATS Score: ${ats_score}/100
Matched Keywords: ${(matched_keywords || []).join(', ')}
Missing Keywords: ${(missing_keywords || []).join(', ')}
Improvement Suggestions: ${(improvement_suggestions || []).join(', ')}
    `;
    const html = `
      <p>Thank you for applying. After review, we found your profile does not match the requirements for this role at this time.</p>
      <h3>ATS Feedback</h3>
      <ul>
        <li><strong>ATS Score:</strong> ${ats_score}/100</li>
        <li><strong>Matched Keywords:</strong> ${(matched_keywords || []).join(', ')}</li>
        <li><strong>Missing Keywords:</strong> ${(missing_keywords || []).join(', ')}</li>
      </ul>
      <h4>Improvement Suggestions:</h4>
      <ul>
        ${(improvement_suggestions || []).map(s => `<li>${s}</li>`).join('')}
      </ul>
    `;
    await sendOrSimulateEmail(data.email, 'Your application update + feedback to strengthen your resume', text, html);
  }
  else if (name === 'interview_scheduled') {
    const text = `Congratulations! You have been selected for an interview.
Date: ${data.scheduled_at}
Meeting Link: ${data.meeting_link}
    `;
    const ical = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//AutoHire//EN
BEGIN:VEVENT
UID:${data.candidate_id}@autohire.com
DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z
DTSTART:${new Date(data.scheduled_at).toISOString().replace(/[-:]/g, '').split('.')[0]}Z
DTEND:${new Date(new Date(data.scheduled_at).getTime() + 60*60*1000).toISOString().replace(/[-:]/g, '').split('.')[0]}Z
SUMMARY:AutoHire Interview
DESCRIPTION:Join here: ${data.meeting_link}
END:VEVENT
END:VCALENDAR`;

    await sendOrSimulateEmail(
      data.email, 
      'Interview Scheduled', 
      text, 
      `<p>${text.replace(/\n/g, '<br/>')}</p>`, 
      ical
    );
  }
}, { 
  connection: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379') },
  settings: {
    backoffStrategies: {
      exponential: function (attemptsMade, err) {
        return Math.round(Math.pow(2, attemptsMade) * 1000);
      }
    }
  }
});

emailWorker.on('failed', (job, err) => {
  logger.error(`Email job ${job.id} failed`, { error: err.message });
});

io.on('connection', (socket) => {
  logger.info('Frontend client connected to WebSocket');
  
  socket.on('subscribe', (job_id) => {
    socket.join(`job_${job_id}`);
    logger.info(`Socket subscribed to job_${job_id}`);
  });

  socket.on('disconnect', () => {
    logger.info('Frontend client disconnected');
  });
});

const start = async () => {
  await connectRedis();

  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  await subscriber.subscribe('dashboard_updates', (message) => {
    const data = JSON.parse(message);
    io.emit('dashboard_update', data);
    
    if (data.job_id) {
      io.to(`job_${data.job_id}`).emit('job_update', data);
    }
  });

  const PORT = process.env.PORT || 3005;
  httpServer.listen(PORT, () => {
    logger.info(`Notification service listening on port ${PORT}`);
  });
};

start().catch(err => logger.error('Startup error', err));
