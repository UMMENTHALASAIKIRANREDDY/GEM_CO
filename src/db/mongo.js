import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('db:mongo');

let _client = null;
let _db = null;

/**
 * Connect to MongoDB and ensure all collections + indexes exist.
 * Call once on startup before app.listen().
 */
export async function connectMongo(retries = 5, delayMs = 3000) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in .env');

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      _client = new MongoClient(uri);
      await _client.connect();
      _db = _client.db(process.env.MONGO_DATABASE || 'gemco');
      logger.info('MongoDB connected');
      break;
    } catch (err) {
      logger.warn(`MongoDB connect attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  await ensureCollections();
}

/**
 * Return the gemco database instance. Throws if not connected.
 */
export function getDb() {
  if (!_db) throw new Error('MongoDB not connected — call connectMongo() first');
  return _db;
}

/**
 * Create collections and indexes if they don't exist.
 */
async function ensureCollections() {
  const existing = new Set(await _db.listCollections().toArray().then(cs => cs.map(c => c.name)));

  // 1. authSessions — OAuth tokens per user+provider
  // Fields: appUserId, email, provider, displayName, tenantId, refreshToken, accessToken, tokenExpiry, msalCache, connectedAt, lastRefreshed
  if (!existing.has('authSessions')) await _db.createCollection('authSessions');
  await _db.collection('authSessions').createIndex({ appUserId: 1, provider: 1 }, { unique: true });

  // 2. cloudMembers
  if (!existing.has('cloudMembers')) await _db.createCollection('cloudMembers');
  // Drop stale indexes from pre-multitenant schema
  try { await _db.collection('cloudMembers').dropIndex('email_1_source_1'); } catch {}
  await _db.collection('cloudMembers').createIndex({ appUserId: 1, googleEmail: 1, msEmail: 1, email: 1, source: 1 }, { unique: true });

  // 3. uploads
  if (!existing.has('uploads')) await _db.createCollection('uploads');

  // 4. userMappings
  if (!existing.has('userMappings')) await _db.createCollection('userMappings');
  await _db.collection('userMappings').createIndex({ batchId: 1 }, { unique: true });

  // 5. reportsWorkspace
  if (!existing.has('reportsWorkspace')) await _db.createCollection('reportsWorkspace');
  await _db.collection('reportsWorkspace').createIndex({ startTime: -1 });

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

  // 10. userWorkspace (per-user UI state — cross-device persistence)
  if (!existing.has('userWorkspace')) await _db.createCollection('userWorkspace');
  // Drop stale single-field index from pre-multitenant schema
  try { await _db.collection('userWorkspace').dropIndex('userId_1'); } catch {}
  await _db.collection('userWorkspace').createIndex({ userId: 1, googleEmail: 1, msEmail: 1 }, { unique: true });

  // 11. appUsers (login credentials)
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

  logger.info('All 11 collections verified with indexes (multi-tenant scoped)');
}
