/**
 * Legacy shim — keeps existing `import { connectMongo, getDb } from './src/db/mongo.js'` working.
 * Internally delegates to the unified core/db factory and runs ensureCollections on startup.
 */

import { connectDb, getDb as coreGetDb } from '../core/db.js';
import bcrypt from 'bcryptjs';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('db:mongo');

const G2C_DB = process.env.G2C_DB || 'gemco';

/**
 * Connect to the gemco database and ensure all collections + indexes exist.
 * Call once on startup before app.listen().
 */
export async function connectMongo(retries = 5, delayMs = 3000) {
  await connectDb(G2C_DB, retries, delayMs);
  try {
    await ensureCollections();
  } catch (e) {
    // Collections likely already exist — non-fatal on transient DB errors
    logger.warn(`ensureCollections non-fatal error: ${e.message}`);
  }
}

/**
 * Return the gemco database instance. Throws if not connected.
 * Kept as a zero-argument function so all existing `db().collection(...)` calls work unchanged.
 */
export function getDb() {
  return coreGetDb(G2C_DB);
}

/**
 * Create collections and indexes if they don't exist.
 */
async function ensureCollections() {
  const _db = getDb();
  const existing = new Set(await _db.listCollections().toArray().then(cs => cs.map(c => c.name)));

  // 1. authSessions — OAuth tokens per user+provider+accountId (multi-account)
  if (!existing.has('authSessions')) await _db.createCollection('authSessions');
  try { await _db.collection('authSessions').dropIndex('appUserId_1_provider_1'); } catch {}
  await _db.collection('authSessions').createIndex(
    { appUserId: 1, provider: 1, accountId: 1 },
    { unique: true, partialFilterExpression: { accountId: { $type: 'string' } } }
  );

  // 2. cloudMembers
  if (!existing.has('cloudMembers')) await _db.createCollection('cloudMembers');
  try { await _db.collection('cloudMembers').dropIndex('email_1_source_1'); } catch {}
  try { await _db.collection('cloudMembers').dropIndex('appUserId_1_googleEmail_1_msEmail_1_email_1_source_1'); } catch {}
  try { await _db.collection('cloudMembers').dropIndex('appUserId_1_email_1_source_1'); } catch {}
  // Deduplicate: keep only the most recently discovered doc per (appUserId, email, source)
  try {
    const dupes = await _db.collection('cloudMembers').aggregate([
      { $group: { _id: { appUserId: '$appUserId', email: '$email', source: '$source' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    for (const d of dupes) {
      const [, ...toDelete] = d.ids; // keep first, delete rest
      await _db.collection('cloudMembers').deleteMany({ _id: { $in: toDelete } });
    }
  } catch {}
  await _db.collection('cloudMembers').createIndex({ appUserId: 1, email: 1, source: 1 }, { unique: true });

  // 3. uploads
  if (!existing.has('uploads')) await _db.createCollection('uploads');

  // 4. userMappings — one mapping doc per migDir+user
  if (!existing.has('userMappings')) await _db.createCollection('userMappings');
  try { await _db.collection('userMappings').dropIndex('batchId_1'); } catch (_) {}
  try { await _db.collection('userMappings').dropIndex('direction_1_appUserId_1'); } catch (_) {}
  await _db.collection('userMappings').createIndex(
    { appUserId: 1, migDir: 1 },
    { unique: true, background: true }
  );

  // 5. migrationWorkspaces — one doc per migration run (all directions)
  if (!existing.has('migrationWorkspaces')) await _db.createCollection('migrationWorkspaces');
  await _db.collection('migrationWorkspaces').createIndex({ appUserId: 1, startTime: -1 });

  // 5b. migrationJobs — one doc per user per run (live runs only)
  if (!existing.has('migrationJobs')) await _db.createCollection('migrationJobs');
  await _db.collection('migrationJobs').createIndex({ workspaceId: 1, appUserId: 1 });
  await _db.collection('migrationJobs').createIndex({ jobId: 1 }, { unique: true });

  // 6. checkpoints
  if (!existing.has('checkpoints')) await _db.createCollection('checkpoints');
  await _db.collection('checkpoints').createIndex({ batchId: 1 }, { unique: true });

  // 7. migrationLogs
  if (!existing.has('migrationLogs')) await _db.createCollection('migrationLogs');
  await _db.collection('migrationLogs').createIndex({ appUserId: 1, batchId: 1, ts: 1 });

  // 8. vaultExports
  if (!existing.has('vaultExports')) await _db.createCollection('vaultExports');
  await _db.collection('vaultExports').createIndex({ appUserId: 1, googleEmail: 1, exportId: 1 }, { unique: true });

  // 9. agentDeployments
  if (!existing.has('agentDeployments')) await _db.createCollection('agentDeployments');
  await _db.collection('agentDeployments').createIndex({ appUserId: 1, batchId: 1 });

  // 10. userWorkspace
  if (!existing.has('userWorkspace')) await _db.createCollection('userWorkspace');
  try { await _db.collection('userWorkspace').dropIndex('userId_1'); } catch {}
  await _db.collection('userWorkspace').createIndex({ userId: 1, googleEmail: 1, msEmail: 1 }, { unique: true });

  // 11. appUsers
  if (!existing.has('appUsers')) await _db.createCollection('appUsers');
  await _db.collection('appUsers').createIndex({ email: 1 }, { unique: true });

  // Seed default users if empty
  const userCount = await _db.collection('appUsers').countDocuments();
  if (userCount === 0) {
    const defaultUsers = [
      { email: 'admin@cloudfuze.com', password: await bcrypt.hash('CloudFuze@2026', 10), name: 'Admin User', role: 'admin', createdAt: new Date() },
      { email: 'laxman@cloudfuze.com', password: await bcrypt.hash('GemCo@2026', 10), name: 'Laxman Kadari', role: 'admin', createdAt: new Date() },
      { email: 'demo@cloudfuze.com', password: await bcrypt.hash('Demo@2026', 10), name: 'Demo User', role: 'user', createdAt: new Date() },
    ];
    await _db.collection('appUsers').insertMany(defaultUsers);
    logger.info('Seeded 3 default app users');
  }

  // 12. cl2gUploads — Claude export ZIP uploads for CL2G migrations
  if (!existing.has('cl2gUploads')) await _db.createCollection('cl2gUploads');
  await _db.collection('cl2gUploads').createIndex({ appUserId: 1, uploadTime: -1 });

  // 13. cl2cUploads — Claude export ZIP uploads for CL2C migrations
  if (!existing.has('cl2cUploads')) await _db.createCollection('cl2cUploads');
  await _db.collection('cl2cUploads').createIndex({ appUserId: 1, uploadTime: -1 });

  // 14. chatHistory — persists agent chat messages per user for cross-device restore
  if (!existing.has('chatHistory')) await _db.createCollection('chatHistory');
  // Drop old unique index if it exists, then create correct non-unique index
  try { await _db.collection('chatHistory').dropIndex('appUserId_1'); } catch (_) {}
  await _db.collection('chatHistory').createIndex({ appUserId: 1, timestamp: -1 });

  // 15. agentAuditLog — structured per-session agent trace for the monitor UI
  if (!existing.has('agentAuditLog')) await _db.createCollection('agentAuditLog');
  await _db.collection('agentAuditLog').createIndex({ sessionId: 1, ts: 1 });
  await _db.collection('agentAuditLog').createIndex({ ts: -1 });

  logger.info('All 15 collections verified with indexes (multi-tenant scoped)');
}
