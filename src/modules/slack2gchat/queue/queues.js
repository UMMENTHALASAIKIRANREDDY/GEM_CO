import { Queue } from 'bullmq';
import { getRedisConnection } from './bullConnection.js';

const PREFIX = process.env.S2G_QUEUE_PREFIX || 's2g';

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

let _queues = null;

export function getQueues() {
  if (_queues) return _queues;
  const conn = { connection: getRedisConnection() };

  _queues = {
    parse:    new Queue(`${PREFIX}-parse`,    { ...conn, defaultJobOptions }),
    space:    new Queue(`${PREFIX}-space`,    { ...conn, defaultJobOptions }),
    messages: new Queue(`${PREFIX}-messages`, { ...conn, defaultJobOptions }),
    complete: new Queue(`${PREFIX}-complete`, { ...conn, defaultJobOptions }),
    finalize: new Queue(`${PREFIX}-finalize`, { ...conn, defaultJobOptions }),
  };

  return _queues;
}
