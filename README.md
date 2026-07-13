# AutoHire

Production-grade autonomous AI recruitment pipeline.

## Architecture

```mermaid
graph TD;
  User-->|Upload PDF| IngestionService
  IngestionService-->|MinIO| Storage
  IngestionService-->|resume.uploaded| PreFilterWorker
  PreFilterWorker-->|resume.prefilter.passed| ATSScorer
  PreFilterWorker-->|resume.rejected| RejectionEmail
  ATSScorer-->|candidate.extracted| ExtractionWorker
  ATSScorer-->|resume.rejected| RejectionEmail
  ExtractionWorker-->|candidate.extracted.complete| ScoringAgent
  ExtractionWorker-->|resume.extraction.dlq| DLQMonitor
  ScoringAgent-->|candidate.scored| SchedulerAgent
  SchedulerAgent-->|interview.scheduled| NotificationService
```

## Setup Guide
1. Create a `.env` file at the root:
   ```env
   GROQ_API_KEY=your_groq_key
   MAILTRAP_HOST=sandbox.smtp.mailtrap.io
   MAILTRAP_PORT=2525
   MAILTRAP_USER=your_user
   MAILTRAP_PASS=your_pass
   FILE_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   DATABASE_URL=postgres://autohire_user:autohire_password@localhost:5432/autohire_db
   REDIS_URL=redis://localhost:6379
   KAFKA_BROKERS=localhost:9092
   ```
2. Run infrastructure: `npm run start:infra`
3. Install dependencies: `npm install`
4. Run DB Migrations (apply `schema.sql`)
5. Seed data: `node scripts/seed.js`
6. Start Microservices in different terminals:
   - `cd services/auth && npm start`
   - `cd services/ingestion && npm start`
   - `cd services/pre-filter && npm start`
   - `cd services/ats-scorer && npm start`
   - `cd services/extraction && npm start`
   - `cd services/scoring && npm start`
   - `cd services/scheduler && npm start`
   - `cd services/notification && npm start`
7. Start Frontend: `cd frontend && npm run dev`
