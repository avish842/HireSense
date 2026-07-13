const logger = require('./logger');
const db = require('./db');
const redis = require('./redis');
const kafka = require('./kafka');
const utils = require('./utils');
const auth = require('./auth');

module.exports = {
  logger,
  db,
  ...redis,
  ...kafka,
  ...utils,
  ...auth
};
