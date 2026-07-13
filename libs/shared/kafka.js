const { Kafka } = require('kafkajs');
const { redisClient } = require('./redis');
const logger = require('./logger');
const { generateIdempotencyKey } = require('./utils');

const kafka = new Kafka({
  clientId: 'autohire',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
});

const producer = kafka.producer();

const connectProducer = async () => {
  await producer.connect();
  logger.info('Kafka producer connected');
};

const publishEvent = async (topic, key, value) => {
  await producer.send({
    topic,
    messages: [
      { key, value: JSON.stringify(value) }
    ]
  });
  logger.info(`Published event to ${topic}`, { topic, key });
};

const checkIdempotency = async (key) => {
  const exists = await redisClient.get(`idempotency:${key}`);
  if (exists) {
    return false; // already processed
  }
  return true; // not processed
};

const markProcessed = async (key) => {
  await redisClient.set(`idempotency:${key}`, '1', {
    EX: 86400 // 24hr TTL
  });
};

const createConsumer = async (groupId, topics, handler) => {
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const value = JSON.parse(message.value.toString());
      
      // Consumers should implement checking themselves via the exposed checkIdempotency
      // or we can handle standard payloads here if they follow { candidate_id, job_id, ... }
      
      try {
        await handler(topic, value);
      } catch (err) {
        logger.error(`Error processing message`, { topic, error: err.message });
        throw err;
      }
    }
  });

  return consumer;
};

module.exports = {
  connectProducer,
  publishEvent,
  createConsumer,
  checkIdempotency,
  markProcessed,
  kafka
};
