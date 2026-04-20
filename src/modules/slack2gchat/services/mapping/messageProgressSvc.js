import { getS2GDb } from '../../db/ensureCollections.js';

export async function initProgress(batchId, slackChannelId, totalMessages) {
  const db = getS2GDb();
  await db.collection('messageProgress').updateOne(
    { batchId, slackChannelId },
    { $setOnInsert: {
      batchId, slackChannelId, totalMessages,
      importedCount: 0, lastFileProcessed: null, lastTs: null,
      status: 'pending', updatedAt: new Date(),
    }},
    { upsert: true }
  );
}

export async function updateProgress(batchId, slackChannelId, importedCount, lastFileProcessed, lastTs) {
  const db = getS2GDb();
  await db.collection('messageProgress').updateOne(
    { batchId, slackChannelId },
    { $set: { importedCount, lastFileProcessed, lastTs, status: 'in_progress', updatedAt: new Date() } }
  );
}

export async function markProgressDone(batchId, slackChannelId) {
  const db = getS2GDb();
  await db.collection('messageProgress').updateOne(
    { batchId, slackChannelId },
    { $set: { status: 'done', updatedAt: new Date() } }
  );
}

export async function getProgress(batchId, slackChannelId) {
  const db = getS2GDb();
  return db.collection('messageProgress').findOne({ batchId, slackChannelId });
}

export async function getJobProgress(batchId) {
  const db = getS2GDb();
  return db.collection('messageProgress').find({ batchId }).toArray();
}
