/**
 * conversationStore — DB-backed staging area for migration conversations.
 *
 * Every migration direction (G2C, C2G, CL2G, CL2C, G2G, C2C) writes parsed
 * source conversations to this collection BEFORE writing to the destination.
 * The destination writer then reads from here and updates status as each
 * conversation lands. This decouples ingest from delivery, enables resume
 * on crash, and bounds memory regardless of customer size.
 *
 * Lifecycle: rows persist until the customer takes an explicit action —
 * disconnecting a cloud, removing admin consent for a tenant, or deleting
 * the uploaded source ZIP. No time-based TTL.
 *
 * NOTHING in this file mutates existing migration flows. Phase 1 only
 * provides the helpers + index creation + cleanup hooks. Phases 2-6 wire
 * each direction to actually use the store.
 */

import { getDb } from '../../db/mongo.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:conversationStore');

const COLLECTION = 'conversationStore';

/**
 * One conversation document. Shape is identical regardless of sourceType —
 * the variable parts of the payload live inside `payload`.
 *
 * Pass arrays of these to `insertConversations()` — internally uses
 * upsert by (batchId, sessionId) so retries are idempotent.
 */
export const CONVERSATION_STATUS = {
  FETCHED: 'fetched',
  MIGRATING: 'migrating',
  MIGRATED: 'migrated',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

export const SOURCE_TYPE = {
  GRAPH: 'graph',    // C2G + C2C — fetched from Microsoft Graph
  VAULT: 'vault',    // G2C + G2G — parsed from Google Vault ZIP
  CLAUDE: 'claude',  // CL2G + CL2C — parsed from Claude export ZIP
};

/**
 * Ensure the collection + indexes exist. Idempotent. Called from connectMongo
 * on server startup.
 */
export async function ensureConversationStoreIndexes() {
  const db = getDb();
  const existing = new Set(await db.listCollections().toArray().then(cs => cs.map(c => c.name)));
  if (!existing.has(COLLECTION)) {
    await db.createCollection(COLLECTION);
    logger.info(`Created collection ${COLLECTION}`);
  }
  const coll = db.collection(COLLECTION);

  // Primary index for migration-phase reads (pull next conversation to migrate)
  await coll.createIndex({ batchId: 1, status: 1 }, { background: true });

  // Idempotency — one conversation per (batchId, sessionId)
  await coll.createIndex({ batchId: 1, sessionId: 1 }, { unique: true, background: true });

  // Cleanup matchers — each is wired to a specific disconnect endpoint.
  await coll.createIndex({ appUserId: 1, sourceTenantId: 1 }, { background: true });
  await coll.createIndex({ appUserId: 1, sourceAccountId: 1 }, { background: true });
  await coll.createIndex({ appUserId: 1, uploadId: 1 }, { background: true });
  await coll.createIndex({ appUserId: 1, destAccountId: 1 }, { background: true });
  await coll.createIndex({ appUserId: 1, destTenantId: 1 }, { background: true });

  // Per-user query within a batch
  await coll.createIndex({ batchId: 1, sourceEmail: 1 }, { background: true });

  // Resume after crash — find orphaned in-flight rows
  await coll.createIndex({ status: 1, fetchedAt: 1 }, { background: true });

  logger.info(`${COLLECTION} indexes verified`);
}

/**
 * Insert (or upsert) a batch of conversation documents.
 * Each doc must include: batchId, appUserId, migDir, sourceType, sessionId.
 * Other fields are optional but recommended.
 *
 * Upsert by (batchId, sessionId) — safe to call multiple times during retries.
 *
 * @param {Array<Object>} docs
 * @returns {Promise<{ inserted: number, modified: number }>}
 */
export async function insertConversations(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return { inserted: 0, modified: 0 };
  const db = getDb();
  const now = new Date();
  const ops = docs.map(d => ({
    updateOne: {
      filter: { batchId: d.batchId, sessionId: d.sessionId },
      update: {
        $set: {
          ...d,
          status: d.status || CONVERSATION_STATUS.FETCHED,
        },
        $setOnInsert: {
          fetchedAt: now,
          attempts: 0,
        },
      },
      upsert: true,
    },
  }));
  const result = await db.collection(COLLECTION).bulkWrite(ops, { ordered: false });
  return {
    inserted: result.upsertedCount || 0,
    modified: result.modifiedCount || 0,
  };
}

/**
 * Async iterator over conversations matching a filter. Use for migration phase.
 *
 *   for await (const conv of iterConversations({ batchId, status: 'fetched' })) {
 *     await processOne(conv);
 *   }
 *
 * Cursor-based — only one document in memory at a time.
 */
export async function* iterConversations(filter, { sort = { sessionId: 1 }, projection } = {}) {
  const db = getDb();
  const cursor = db.collection(COLLECTION).find(filter, { projection }).sort(sort);
  try {
    while (await cursor.hasNext()) {
      yield await cursor.next();
    }
  } finally {
    await cursor.close().catch(() => {});
  }
}

/**
 * Update the status of one conversation. On failure, increments `attempts`
 * and stores `lastError`.
 */
export async function markStatus(_id, status, options = {}) {
  const db = getDb();
  const set = { status };
  if (status === CONVERSATION_STATUS.MIGRATED) set.migratedAt = new Date();
  if (options.error) set.lastError = String(options.error).slice(0, 1000);
  if (options.destPageId) set.destPageId = options.destPageId;
  if (options.destFileId) set.destFileId = options.destFileId;

  const update = { $set: set };
  if (status === CONVERSATION_STATUS.FAILED || status === CONVERSATION_STATUS.MIGRATING) {
    update.$inc = { attempts: 1 };
  }
  await db.collection(COLLECTION).updateOne({ _id }, update);
}

/**
 * Count by status for a batch — used by progress reporters.
 */
export async function countByStatus(batchId) {
  const db = getDb();
  const agg = await db.collection(COLLECTION).aggregate([
    { $match: { batchId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  const out = { fetched: 0, migrating: 0, migrated: 0, failed: 0, skipped: 0, total: 0 };
  for (const row of agg) {
    out[row._id] = row.count;
    out.total += row.count;
  }
  return out;
}

/**
 * Cleanup helpers — called from existing disconnect endpoints.
 * All take {appUserId, ...identifier} filters so cleanup is per-customer
 * scoped (never cross-customer).
 */

/** Wipe everything for a specific MS tenant (source OR destination side) */
export async function deleteByTenant(appUserId, tenantId) {
  if (!appUserId || !tenantId) return 0;
  const db = getDb();
  const r = await db.collection(COLLECTION).deleteMany({
    appUserId,
    $or: [{ sourceTenantId: tenantId }, { destTenantId: tenantId }],
  });
  if (r.deletedCount > 0) {
    logger.info(`Cleanup: deleted ${r.deletedCount} rows for appUserId=${appUserId} tenantId=${tenantId}`);
  }
  return r.deletedCount;
}

/** Wipe everything for a specific Google account (source OR destination side) */
export async function deleteByGoogleAccount(appUserId, accountId) {
  if (!appUserId || !accountId) return 0;
  const db = getDb();
  const r = await db.collection(COLLECTION).deleteMany({
    appUserId,
    $or: [{ sourceAccountId: accountId }, { destAccountId: accountId }],
  });
  if (r.deletedCount > 0) {
    logger.info(`Cleanup: deleted ${r.deletedCount} rows for appUserId=${appUserId} googleAccountId=${accountId}`);
  }
  return r.deletedCount;
}

/** Wipe everything for a specific uploaded ZIP (Vault or Claude) */
export async function deleteByUpload(appUserId, uploadId) {
  if (!appUserId || !uploadId) return 0;
  const db = getDb();
  const r = await db.collection(COLLECTION).deleteMany({ appUserId, uploadId });
  if (r.deletedCount > 0) {
    logger.info(`Cleanup: deleted ${r.deletedCount} rows for appUserId=${appUserId} uploadId=${uploadId}`);
  }
  return r.deletedCount;
}

/** Wipe everything for an entire CloudFuze user (worst case — full reset) */
export async function deleteByAppUser(appUserId) {
  if (!appUserId) return 0;
  const db = getDb();
  const r = await db.collection(COLLECTION).deleteMany({ appUserId });
  if (r.deletedCount > 0) {
    logger.info(`Cleanup: deleted ${r.deletedCount} rows for appUserId=${appUserId}`);
  }
  return r.deletedCount;
}

/**
 * Wipe rows for a specific batch (e.g., user explicitly resets a migration).
 * Different from cleanup-by-cloud — this is per-batch granularity.
 */
export async function deleteByBatch(batchId) {
  if (!batchId) return 0;
  const db = getDb();
  const r = await db.collection(COLLECTION).deleteMany({ batchId });
  if (r.deletedCount > 0) {
    logger.info(`Cleanup: deleted ${r.deletedCount} rows for batchId=${batchId}`);
  }
  return r.deletedCount;
}

/**
 * Boot-time orphan-batch cleanup.
 *
 * On server start, find migrationWorkspaces stuck in 'running' status with
 * either no heartbeat or a stale heartbeat (>60s old). These batches' Node
 * processes died (deploy, crash, container kill). Mark them 'failed' so the
 * UI doesn't show "Running..." forever, and so the customer knows to retry.
 *
 * Per-conversation auto-resume requires the destination-reads-from-DB
 * refactor (Chunk 2). For now, we surface the orphan state clearly so the
 * customer can take action.
 */
export async function detectAndMarkOrphanedBatches({ cutoffMs = 60_000 } = {}) {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - cutoffMs);
    const orphans = await db.collection('migrationWorkspaces').find({
      status: 'running',
      $or: [
        { lastHeartbeat: { $lt: cutoff } },
        { lastHeartbeat: { $exists: false } },
      ],
    }).toArray();
    if (orphans.length === 0) return { found: 0 };
    for (const batch of orphans) {
      await db.collection('migrationWorkspaces').updateOne(
        { _id: batch._id },
        {
          $set: {
            status: 'failed',
            endTime: new Date(),
            error: 'Server restarted while migration was running. Conversations already migrated are preserved at the destination. Retry the migration to process the remaining users.',
            orphanedAt: new Date(),
          },
        }
      );
      logger.warn(`Boot: marked orphaned batch ${batch._id} (migDir=${batch.migDir}) as failed`);
    }
    return { found: orphans.length };
  } catch (e) {
    logger.warn(`detectAndMarkOrphanedBatches failed: ${e.message}`);
    return { found: 0, error: e.message };
  }
}

/**
 * Find orphaned batches — used by the boot-time auto-resume scanner.
 * Returns batchIds where status is still 'fetched' or 'migrating' AND the
 * batch's last heartbeat is older than the cutoff.
 *
 * Wired in Commit 6.
 */
export async function findOrphanedBatches(cutoffMs = 60_000) {
  const db = getDb();
  const cutoff = new Date(Date.now() - cutoffMs);
  // Group conversationStore by batchId; find batches with active work
  const active = await db.collection(COLLECTION).aggregate([
    { $match: { status: { $in: [CONVERSATION_STATUS.FETCHED, CONVERSATION_STATUS.MIGRATING] } } },
    { $group: { _id: '$batchId', count: { $sum: 1 } } },
  ]).toArray();
  if (active.length === 0) return [];

  const batchIds = active.map(a => a._id);
  // Cross-check workspace heartbeat
  const orphans = await db.collection('migrationWorkspaces').find({
    _id: { $in: batchIds },
    status: 'running',
    $or: [
      { lastHeartbeat: { $lt: cutoff } },
      { lastHeartbeat: { $exists: false } },
    ],
  }).toArray();
  return orphans.map(w => ({
    batchId: w._id,
    migDir: w.migDir,
    appUserId: w.appUserId,
    startTime: w.startTime,
    lastHeartbeat: w.lastHeartbeat || null,
  }));
}

/**
 * Reset 'migrating' rows back to 'fetched' (used during resume).
 * A row stuck in 'migrating' means the previous process died mid-write —
 * we don't know whether the destination wrote or not. Resetting is safe
 * because destination writers should be idempotent (upsert by sessionId).
 */
export async function resetStuckMigrating(batchId) {
  const db = getDb();
  const r = await db.collection(COLLECTION).updateMany(
    { batchId, status: CONVERSATION_STATUS.MIGRATING },
    { $set: { status: CONVERSATION_STATUS.FETCHED } }
  );
  if (r.modifiedCount > 0) {
    logger.info(`Resume: reset ${r.modifiedCount} stuck 'migrating' rows to 'fetched' for batch ${batchId}`);
  }
  return r.modifiedCount;
}

/**
 * High-level helper: persist a batch of source conversations to the store.
 * Each migration direction calls this AFTER ingest (Vault parse / Claude parse
 * / Graph fetch) and BEFORE handing conversations to the destination writer.
 *
 * The destination writer continues to work from its in-memory copy. This
 * helper is purely additive — adds DB persistence without changing the
 * existing migration flow. Failures here log a warning and continue;
 * never block a migration over a DB write hiccup.
 *
 * @param {Object} ctx — common metadata: { batchId, appUserId, migDir,
 *                       sourceType, sourceEmail, destEmail, sourceTenantId,
 *                       destTenantId, sourceAccountId, destAccountId,
 *                       uploadId, sourceUserId, sourceDisplayName }
 * @param {Array<Object>} conversations — array of conversation objects.
 *   Each MUST have: sessionId (string, unique per conversation)
 *   Recommended fields: title, createdDateTime, turns/interactions/messages
 *
 * @returns {Promise<{ ok: boolean, inserted: number, error?: string }>}
 */
export async function persistSourceConversations(ctx, conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return { ok: true, inserted: 0 };
  }
  if (!ctx?.batchId || !ctx?.appUserId || !ctx?.migDir || !ctx?.sourceType) {
    logger.warn(`persistSourceConversations: missing required ctx fields — skipping`);
    return { ok: false, inserted: 0, error: 'missing required ctx fields' };
  }
  try {
    const now = new Date();
    const docs = conversations.map(c => ({
      batchId: ctx.batchId,
      appUserId: ctx.appUserId,
      migDir: ctx.migDir,
      sourceType: ctx.sourceType,
      sessionId: c.sessionId || c.id || `${ctx.sourceEmail}::${c.title || 'untitled'}::${c.createdDateTime || now.toISOString()}`,
      sourceTenantId: ctx.sourceTenantId || null,
      sourceUserId: ctx.sourceUserId || null,
      sourceEmail: ctx.sourceEmail || null,
      sourceDisplayName: ctx.sourceDisplayName || null,
      sourceAccountId: ctx.sourceAccountId || null,
      destEmail: ctx.destEmail || null,
      destTenantId: ctx.destTenantId || null,
      destAccountId: ctx.destAccountId || null,
      uploadId: ctx.uploadId || null,
      conversationTitle: c.title || c.conversationTitle || null,
      createdDateTime: c.createdDateTime ? new Date(c.createdDateTime) : null,
      payload: c.payload || c,    // raw source data — varies by sourceType
      status: CONVERSATION_STATUS.FETCHED,
    }));
    const result = await insertConversations(docs);
    logger.info(`persistSourceConversations: batch=${ctx.batchId} dir=${ctx.migDir} user=${ctx.sourceEmail} inserted=${result.inserted} modified=${result.modified}`);
    return { ok: true, inserted: result.inserted + result.modified };
  } catch (e) {
    // Never let a DB write failure block the migration.
    logger.warn(`persistSourceConversations failed (non-fatal): ${e.message}`);
    return { ok: false, inserted: 0, error: e.message };
  }
}

/**
 * Mark a conversation as migrated after the destination writer succeeds.
 * Looks up the row by (batchId, sessionId) and updates status.
 * Idempotent — safe to call multiple times.
 */
export async function markMigratedBySession(batchId, sessionId, options = {}) {
  if (!batchId || !sessionId) return false;
  try {
    const db = getDb();
    const update = { $set: { status: CONVERSATION_STATUS.MIGRATED, migratedAt: new Date() } };
    if (options.destPageId) update.$set.destPageId = options.destPageId;
    if (options.destFileId) update.$set.destFileId = options.destFileId;
    await db.collection(COLLECTION).updateOne({ batchId, sessionId }, update);
    return true;
  } catch (e) {
    logger.warn(`markMigratedBySession failed (non-fatal): ${e.message}`);
    return false;
  }
}

/**
 * Mark all rows for a (uploadId, sourceEmail) pair as migrated.
 * Used for ZIP-source directions after a user pair completes successfully.
 */
export async function markUserPairMigrated({ appUserId, uploadId, batchId, sourceEmail, destEmail }) {
  if (!appUserId || (!uploadId && !batchId) || !sourceEmail) return 0;
  try {
    const db = getDb();
    const filter = { appUserId, sourceEmail };
    if (uploadId) filter.uploadId = uploadId;
    else if (batchId) filter.batchId = batchId;
    // Only update rows that aren't already migrated (idempotent retries)
    filter.status = { $ne: CONVERSATION_STATUS.MIGRATED };
    const r = await db.collection(COLLECTION).updateMany(filter, {
      $set: { status: CONVERSATION_STATUS.MIGRATED, migratedAt: new Date(), destEmail: destEmail || null, migratedToBatchId: batchId || null },
    });
    if (r.modifiedCount > 0) {
      logger.info(`Marked ${r.modifiedCount} conversations migrated for ${sourceEmail} → ${destEmail || '(unknown)'}`);
    }
    return r.modifiedCount;
  } catch (e) {
    logger.warn(`markUserPairMigrated failed (non-fatal): ${e.message}`);
    return 0;
  }
}

/** Mark all rows for a user pair as failed with an error message. */
export async function markUserPairFailed({ appUserId, uploadId, batchId, sourceEmail, error }) {
  if (!appUserId || (!uploadId && !batchId) || !sourceEmail) return 0;
  try {
    const db = getDb();
    const filter = { appUserId, sourceEmail };
    if (uploadId) filter.uploadId = uploadId;
    else if (batchId) filter.batchId = batchId;
    filter.status = { $nin: [CONVERSATION_STATUS.MIGRATED, CONVERSATION_STATUS.FAILED] };
    const r = await db.collection(COLLECTION).updateMany(filter, {
      $set: { status: CONVERSATION_STATUS.FAILED, lastError: String(error || '').slice(0, 1000), migratedToBatchId: batchId || null },
      $inc: { attempts: 1 },
    });
    return r.modifiedCount;
  } catch (e) {
    logger.warn(`markUserPairFailed failed (non-fatal): ${e.message}`);
    return 0;
  }
}

/**
 * Load conversations for a single user pair from conversationStore.
 *
 * Returns the conversations in the SAME SHAPE as the original source readers
 * (VaultReader.loadUserConversations / zipParser.getUserData) — because we
 * stored `payload: c` (the raw conversation object) at ingest time, we just
 * unwrap it. Each returned object has `_storeId` and `_storeSessionId`
 * appended so the caller can mark per-row status if desired.
 *
 * Returns null if no rows match (caller can fall back to disk-based read).
 *
 * @param {object} filter
 *   - appUserId (required)
 *   - sourceEmail (required, lowercased internally)
 *   - uploadId (optional — ZIP sources)
 *   - batchId (optional — Graph sources)
 *   - fromDate / toDate (optional — date filter)
 *   - includeMigrated (default false — only loads unmigrated rows for resume)
 */
export async function loadConversationsFromStore({
  appUserId, sourceEmail, uploadId, batchId, fromDate, toDate, includeMigrated = false,
}) {
  if (!appUserId || !sourceEmail) return null;
  try {
    const db = getDb();
    const query = { appUserId };
    // Case-insensitive sourceEmail match — store may have mixed case
    query.sourceEmail = { $regex: `^${sourceEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
    if (uploadId) query.uploadId = uploadId;
    else if (batchId) query.batchId = batchId;
    if (!includeMigrated) {
      query.status = { $ne: CONVERSATION_STATUS.MIGRATED };
    }
    const rows = await db.collection(COLLECTION).find(query).toArray();
    if (rows.length === 0) return null;

    // Apply date filter in-memory (createdDateTime varies in shape per source)
    let filtered = rows;
    if (fromDate || toDate) {
      const from = fromDate ? new Date(fromDate) : null;
      const to = toDate ? new Date(toDate + (toDate.length === 10 ? 'T23:59:59Z' : '')) : null;
      filtered = rows.filter(r => {
        if (!r.createdDateTime) return true; // include rows missing timestamps
        const d = new Date(r.createdDateTime);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
    }

    return filtered.map(r => {
      // Unwrap the original conversation object, attach store metadata
      const conversation = (r.payload && typeof r.payload === 'object') ? { ...r.payload } : {};
      conversation._storeId = r._id;
      conversation._storeSessionId = r.sessionId;
      return conversation;
    });
  } catch (e) {
    logger.warn(`loadConversationsFromStore failed (non-fatal): ${e.message}`);
    return null;
  }
}

/**
 * Start a heartbeat updater for a running migration batch.
 * Updates migrationWorkspaces.lastHeartbeat every 30s so the boot-time
 * orphan detector knows this batch is alive.
 *
 * Returns an interval ID — caller MUST clearInterval() on completion
 * (or in a try/finally) to avoid leaks.
 */
export function startHeartbeat(batchId, intervalMs = 30_000) {
  if (!batchId) return null;
  const update = async () => {
    try {
      const db = getDb();
      await db.collection('migrationWorkspaces').updateOne(
        { _id: batchId },
        { $set: { lastHeartbeat: new Date() } }
      );
    } catch (_) { /* ignore — non-critical */ }
  };
  update(); // immediate first heartbeat
  return setInterval(update, intervalMs);
}

export function stopHeartbeat(intervalId) {
  if (intervalId) clearInterval(intervalId);
}

/** Mark a conversation as failed with an error. Idempotent. */
export async function markFailedBySession(batchId, sessionId, error) {
  if (!batchId || !sessionId) return false;
  try {
    const db = getDb();
    await db.collection(COLLECTION).updateOne(
      { batchId, sessionId },
      {
        $set: { status: CONVERSATION_STATUS.FAILED, lastError: String(error || '').slice(0, 1000) },
        $inc: { attempts: 1 },
      }
    );
    return true;
  } catch (e) {
    logger.warn(`markFailedBySession failed (non-fatal): ${e.message}`);
    return false;
  }
}
