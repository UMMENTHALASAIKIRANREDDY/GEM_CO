import { getS2GDb } from '../../db/ensureCollections.js';
import { getQueues } from '../../queue/queues.js';
import { getUserMapLookup } from '../mapping/userMapService.js';
import { getChannelMap, markChannelSkipped } from '../mapping/channelMapService.js';
import { emitProgress } from '../../sse/progressEmitter.js';

/**
 * Kick off a full S2G migration for a batchId.
 * Enqueues one space-creation job per channel/DM.
 */
export async function startMigration(batchId, config = {}) {
  const db = getS2GDb();
  const queues = getQueues();

  await db.collection('jobs').updateOne(
    { _id: batchId },
    { $set: { status: 'importing', phase: 'SPACE_CREATE', updatedAt: new Date() } }
  );

  const channels = await getChannelMap(batchId, { skipped: { $ne: true }, gchatSpaceName: { $exists: false } });
  const userMapLookup = await getUserMapLookup(batchId);

  const exportPath = (await db.collection('jobs').findOne({ _id: batchId }))?.uploadPath;

  emitProgress(batchId, { type: 'start', total: channels.length });

  for (const channel of channels) {
    // For DMs: require both users to have Google mappings, else skip
    if (channel.slackType === 'dm') {
      const memberEmails = (channel.memberIds || [])
        .map(id => userMapLookup.get(id))
        .filter(Boolean);

      if (memberEmails.length < 2) {
        await markChannelSkipped(batchId, channel.slackChannelId, 'DM members not mapped to Google users');
        emitProgress(batchId, { type: 'channel_skipped', channelId: channel.slackChannelId, reason: 'DM members unmapped' });
        continue;
      }

      await queues.space.add('create-space', {
        batchId, channel, memberEmails, exportPath,
      });
    } else {
      await queues.space.add('create-space', {
        batchId, channel, memberEmails: [], exportPath,
      });
    }
  }
}

/**
 * Pause: drain the queue (stop accepting new jobs).
 */
export async function pauseMigration(batchId) {
  const db = getS2GDb();
  const queues = getQueues();
  await Promise.all([
    queues.space.pause(),
    queues.messages.pause(),
  ]);
  await db.collection('jobs').updateOne({ _id: batchId }, { $set: { status: 'paused', updatedAt: new Date() } });
}

/**
 * Resume: unpause queues.
 */
export async function resumeMigration(batchId) {
  const db = getS2GDb();
  const queues = getQueues();
  await Promise.all([
    queues.space.resume(),
    queues.messages.resume(),
  ]);
  await db.collection('jobs').updateOne({ _id: batchId }, { $set: { status: 'importing', updatedAt: new Date() } });
}

/**
 * Retry failed channels: re-enqueue from errors collection.
 */
export async function retryErrors(batchId) {
  const db = getS2GDb();
  const queues = getQueues();

  const failedChannels = await db.collection('errors')
    .distinct('slackChannelId', { batchId, retryCount: { $lt: 5 } });

  const channels = await getChannelMap(batchId, {
    slackChannelId: { $in: failedChannels },
  });

  const exportPath = (await db.collection('jobs').findOne({ _id: batchId }))?.uploadPath;
  const userMapLookup = await getUserMapLookup(batchId);

  for (const channel of channels) {
    const memberEmails = (channel.memberIds || []).map(id => userMapLookup.get(id)).filter(Boolean);
    await queues.messages.add('import-messages', {
      batchId, channel, spaceName: channel.gchatSpaceName, exportPath, memberEmails,
    });
    await db.collection('errors').updateMany(
      { batchId, slackChannelId: channel.slackChannelId },
      { $inc: { retryCount: 1 } }
    );
  }

  return failedChannels.length;
}
