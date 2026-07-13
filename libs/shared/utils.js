const crypto = require('crypto');

const generateIdempotencyKey = (candidate_id, job_id, event_type) => {
  const data = `${candidate_id}${job_id}${event_type}`;
  return crypto.createHash('sha256').update(data).digest('hex');
};

module.exports = { generateIdempotencyKey };
