import { Redis } from 'ioredis';

let _redis = null;

export function getRedisConnection() {
  if (!_redis) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    _redis = new Redis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
    });
    _redis.on('error', (err) => {
      console.error('[S2G Redis]', err.message);
    });
  }
  return _redis;
}
