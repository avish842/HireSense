const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', { error: err.message });
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
