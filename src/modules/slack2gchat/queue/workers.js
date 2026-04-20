import { Worker } from 'bullmq';
import { getRedisConnection } from './bullConnection.js';
import { emitProgress } from '../sse/progressEmitter.js';
import { getS2GDb } from '../db/ensureCollections.js';
import { iterateChannelMessages } from '../services/slackExport/messageIterator.js';
import { importMessage } from '../services/gchat/messageImporter.js';
import { createImportSpace, completeSpaceImport } from '../services/gchat/spaceCreator.js';
import { addSpaceMembers } from '../services/gchat/membershipManager.js';
import { setSpaceName, markImportComplete, getChannelMap } from '../services/mapping/channelMapService.js';
import { getUserMapLookup } from '../services/mapping/userMapService.js';
import { initProgress, updateProgress, markProgressDone, getProgress } from '../services/mapping/messageProgressSvc.js';
import { getQueues } from './queues.js';

const PREFIX = process.env.S2G_QUEUE_PREFIX || 's2g';
const MAX_PARALLEL = parseInt(process.env.S2G_MAX_PARALLEL_CHANNELS || '5', 10);
const CHECKPOINT_EVERY = 500;

// ── space worker ─────────────────────────────────────────────────────────────
async function processSpaceJob(job) {
  const { batchId, channel, memberEmails } = job.data;

  emitProgress(batchId, { type: 'space_start', channelId: channel.slackChannelId, name: channel.slackName });

  const spaceName = await createImportSpace(channel, memberEmails);
  await setSpaceName(batchId, channel.slackChannelId, spaceName);

  emitProgress(batchId, { type: 'space_created', channelId: channel.slackChannelId, spaceName });

  // Enqueue message import job
  const queues = getQueues();
  await queues.messages.add('import-messages', { batchId, channel, spaceName });
}

// ── messages worker ───────────────────────────────────────────────────────────
async function processMessagesJob(job) {
  const { batchId, channel, spaceName } = job.data;
  const db = getS2GDb();

  const userMapLookup = await getUserMapLookup(batchId);
  const adminEmail = process.env.S2G_GCHAT_ADMIN_SUBJECT;

  // Resume from checkpoint
  const progress = await getProgress(batchId, channel.slackChannelId);
  const resumeAfterTs = progress?.lastTs || null;

  await initProgress(batchId, channel.slackChannelId, channel.messageCount || 0);

  const exportPath = progress?.exportPath || job.data.exportPath;
  const threadMap = new Map();
  let importedCount = progress?.importedCount || 0;
  let errorBuf = [];
  let lastTs = resumeAfterTs;
  let lastFile = null;

  for await (const { dayFile, messages } of iterateChannelMessages(exportPath, channel.slackName)) {
    for (const msg of messages) {
      // Skip already-imported messages on resume
      if (resumeAfterTs && parseFloat(msg.ts) <= parseFloat(resumeAfterTs)) continue;

      // Skip non-message entries (join/leave events etc.)
      if (msg.subtype && !['bot_message', 'thread_broadcast'].includes(msg.subtype)) continue;

      const result = await importMessage(spaceName, msg, userMapLookup, adminEmail, threadMap);

      if (result.success) {
        importedCount++;
        lastTs = msg.ts;
      } else {
        errorBuf.push({
          batchId, slackChannelId: channel.slackChannelId,
          slackTs: msg.ts, phase: 'messages',
          errorCode: 'IMPORT_FAILED', errorMessage: result.error,
          retryCount: 0, occurredAt: new Date(),
        });
      }

      lastFile = dayFile;

      // Checkpoint every N messages
      if (importedCount % CHECKPOINT_EVERY === 0) {
        await updateProgress(batchId, channel.slackChannelId, importedCount, dayFile, lastTs);
        emitProgress(batchId, { type: 'messages_progress', channelId: channel.slackChannelId, imported: importedCount, total: channel.messageCount || 0 });
      }

      // Flush error buffer
      if (errorBuf.length >= 1000) {
        await db.collection('errors').insertMany(errorBuf).catch(() => {});
        errorBuf = [];
      }
    }
  }

  // Final flush
  if (errorBuf.length) {
    await db.collection('errors').insertMany(errorBuf).catch(() => {});
  }

  await updateProgress(batchId, channel.slackChannelId, importedCount, lastFile, lastTs);
  emitProgress(batchId, { type: 'messages_done', channelId: channel.slackChannelId, imported: importedCount });

  // Enqueue complete job
  const queues = getQueues();
  await queues.complete.add('complete-space', { batchId, channel, spaceName });
}

// ── complete worker ───────────────────────────────────────────────────────────
async function processCompleteJob(job) {
  const { batchId, channel, spaceName } = job.data;

  await completeSpaceImport(spaceName);
  await markProgressDone(batchId, channel.slackChannelId);
  await markImportComplete(batchId, channel.slackChannelId);

  // Add members after import complete
  const userMapLookup = await getUserMapLookup(batchId);
  const memberEmails = (channel.memberIds || [])
    .map(id => userMapLookup.get(id))
    .filter(Boolean);

  if (memberEmails.length) {
    await addSpaceMembers(spaceName, memberEmails);
  }

  emitProgress(batchId, { type: 'channel_done', channelId: channel.slackChannelId, spaceName });

  // Check if all channels are done → finalize
  const db = getS2GDb();
  const pending = await db.collection('channelMap').countDocuments({ batchId, importCompleted: false, skipped: { $ne: true } });
  if (pending === 0) {
    const queues = getQueues();
    await queues.finalize.add('finalize', { batchId });
  }
}

// ── finalize worker ───────────────────────────────────────────────────────────
async function processFinalizeJob(job) {
  const { batchId } = job.data;
  const db = getS2GDb();

  const progDocs = await db.collection('messageProgress').find({ batchId }).toArray();
  const totalImported = progDocs.reduce((s, d) => s + (d.importedCount || 0), 0);
  const errCount = await db.collection('errors').countDocuments({ batchId });

  await db.collection('jobs').updateOne(
    { _id: batchId },
    { $set: { status: 'completed', completedAt: new Date(), 'stats.imported': totalImported, 'stats.failed': errCount } }
  );

  emitProgress(batchId, { type: 'done', batchId, totalImported, errors: errCount });
}

// ── start all workers ─────────────────────────────────────────────────────────
export async function startS2GWorkers() {
  const conn = { connection: getRedisConnection() };

  new Worker(`${PREFIX}-space`,    processSpaceJob,    { ...conn, concurrency: 10 });
  new Worker(`${PREFIX}-messages`, processMessagesJob, { ...conn, concurrency: MAX_PARALLEL });
  new Worker(`${PREFIX}-complete`, processCompleteJob, { ...conn, concurrency: 10 });
  new Worker(`${PREFIX}-finalize`, processFinalizeJob, { ...conn, concurrency: 1 });

  console.log('[S2G] BullMQ workers started');
}
