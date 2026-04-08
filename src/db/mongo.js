import { MongoClient } from 'mongodb';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('db:mongo');

let _client = null;
let _db = null;

/**
 * Connect to MongoDB and ensure all collections + indexes exist.
 * Call once on startup before app.listen().
 */
export async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in .env');

  _client = new MongoClient(uri);
  await _client.connect();
  _db = _client.db(process.env.MONGO_DATABASE || 'gemco');
  logger.info('MongoDB connected');

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

  // 1. users
  if (!existing.has('users')) await _db.createCollection('users');
  await _db.collection('users').createIndex({ email: 1, provider: 1 }, { unique: true });

  // 2. cloudMembers
  if (!existing.has('cloudMembers')) await _db.createCollection('cloudMembers');
  await _db.collection('cloudMembers').createIndex({ email: 1, source: 1 }, { unique: true });

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
  await _db.collection('migrationLogs').createIndex({ batchId: 1, ts: 1 });

  // 8. vaultExports
  if (!existing.has('vaultExports')) await _db.createCollection('vaultExports');
  await _db.collection('vaultExports').createIndex({ exportId: 1 }, { unique: true });

  // 9. agentDeployments
  if (!existing.has('agentDeployments')) await _db.createCollection('agentDeployments');
  await _db.collection('agentDeployments').createIndex({ batchId: 1 });

  logger.info('All 9 collections verified with indexes');
}
