import { getDb } from '../../../core/db.js';

const DB = () => getDb(process.env.S2G_DB || 'slack2gchat');

export async function ensureS2GCollections() {
  const db = DB();
  const existing = new Set(
    await db.listCollections().toArray().then(cs => cs.map(c => c.name))
  );

  if (!existing.has('jobs')) await db.createCollection('jobs');
  await db.collection('jobs').createIndex({ appUserId: 1, createdAt: -1 });
  await db.collection('jobs').createIndex({ status: 1 });

  if (!existing.has('channelMap')) await db.createCollection('channelMap');
  await db.collection('channelMap').createIndex({ batchId: 1, slackChannelId: 1 }, { unique: true });
  await db.collection('channelMap').createIndex({ batchId: 1, importCompleted: 1 });

  if (!existing.has('userMap')) await db.createCollection('userMap');
  await db.collection('userMap').createIndex({ batchId: 1, slackUserId: 1 }, { unique: true });
  await db.collection('userMap').createIndex({ batchId: 1, googleEmail: 1 });

  if (!existing.has('messageProgress')) await db.createCollection('messageProgress');
  await db.collection('messageProgress').createIndex({ batchId: 1, slackChannelId: 1 }, { unique: true });

  if (!existing.has('errors')) await db.createCollection('errors');
  await db.collection('errors').createIndex({ batchId: 1, phase: 1 });
  await db.collection('errors').createIndex({ batchId: 1, retryCount: 1 });

  console.log('[S2G] DB collections verified');
}

export function getS2GDb() {
  return DB();
}
