import { getS2GDb } from '../../db/ensureCollections.js';

export async function saveChannelMap(batchId, channels) {
  const db = getS2GDb();
  if (!channels.length) return;
  const ops = channels.map(c => ({
    updateOne: {
      filter: { batchId, slackChannelId: c.slackChannelId },
      update: { $set: { batchId, ...c, importCompleted: false, createdAt: new Date() } },
      upsert: true,
    },
  }));
  await db.collection('channelMap').bulkWrite(ops, { ordered: false });
}

export async function getChannelMap(batchId, filter = {}) {
  const db = getS2GDb();
  return db.collection('channelMap').find({ batchId, ...filter }).toArray();
}

export async function setSpaceName(batchId, slackChannelId, gchatSpaceName) {
  const db = getS2GDb();
  await db.collection('channelMap').updateOne(
    { batchId, slackChannelId },
    { $set: { gchatSpaceName, spaceCreatedAt: new Date() } }
  );
}

export async function markImportComplete(batchId, slackChannelId) {
  const db = getS2GDb();
  await db.collection('channelMap').updateOne(
    { batchId, slackChannelId },
    { $set: { importCompleted: true, completedAt: new Date() } }
  );
}

export async function markChannelSkipped(batchId, slackChannelId, reason) {
  const db = getS2GDb();
  await db.collection('channelMap').updateOne(
    { batchId, slackChannelId },
    { $set: { skipped: true, skipReason: reason } }
  );
}
