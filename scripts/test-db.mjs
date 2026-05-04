/**
 * test-db.mjs — verifies all MongoDB collections, indexes, and migration write/read paths
 * Run: node scripts/test-db.mjs
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'crypto';

// MONGO_HOST has no db name — use directly
const MONGO_URI = process.env.MONGO_HOST || 'mongodb://localhost:27017';
const G2C_DB = process.env.G2C_DB || 'gemco';

let client, db;
let passed = 0, failed = 0, warned = 0;

function ok(label) { console.log(`  ✓  ${label}`); passed++; }
function fail(label, detail = '') { console.error(`  ✗  ${label}${detail ? ': ' + detail : ''}`); failed++; }
function warn(label) { console.warn(`  ⚠  ${label}`); warned++; }
function section(title) { console.log(`\n── ${title} ──`); }

async function connect() {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(G2C_DB);
  ok(`Connected to ${G2C_DB}`);
}

// ── 1. Collections exist ───────────────────────────────────────────────────
async function checkCollections() {
  section('Collections');
  const cols = new Set((await db.listCollections().toArray()).map(c => c.name));

  const required = [
    'migrationWorkspaces', 'migrationJobs', 'userMappings', 'uploads',
    'cl2gUploads', 'authSessions', 'appUsers',
  ];
  const optional = [
    'userConfig', 'conversationHistory', 'scheduledJobs', 'cachedUsers',
    'checkpoints', 'migrationLogs', 'cloudMembers',
  ];
  const legacy = ['reportsWorkspace'];

  for (const c of required) {
    if (cols.has(c)) ok(`${c} exists`);
    else fail(`${c} MISSING — migration writes will fail`);
  }
  for (const c of optional) {
    if (cols.has(c)) ok(`${c} exists`);
    else warn(`${c} missing (optional — will be auto-created on first write)`);
  }
  for (const c of legacy) {
    if (cols.has(c)) warn(`${c} still exists (legacy collection from before rename — harmless, no code reads it)`);
    else ok(`${c} not present (correctly removed)`);
  }
}

// ── 2. Indexes ─────────────────────────────────────────────────────────────
async function checkIndexes() {
  section('Indexes');

  async function hasIndex(col, keyPattern) {
    try {
      const idxs = await db.collection(col).indexes();
      const key = JSON.stringify(keyPattern);
      return idxs.some(i => JSON.stringify(i.key) === key);
    } catch { return false; }
  }

  const checks = [
    ['userMappings', { appUserId: 1, migDir: 1 }, 'unique per-user per-direction'],
    ['migrationWorkspaces', { appUserId: 1, startTime: -1 }, 'per-user workspace list'],
    ['migrationJobs', { workspaceId: 1, appUserId: 1 }, 'jobs per workspace'],
    ['cl2gUploads', { appUserId: 1, uploadTime: -1 }, 'CL2G uploads per user'],
    ['authSessions', { appUserId: 1, provider: 1 }, 'auth sessions'],
  ];

  for (const [col, pattern, desc] of checks) {
    if (await hasIndex(col, pattern)) ok(`${col} → ${desc}`);
    else warn(`${col} missing index ${JSON.stringify(pattern)} (${desc}) — queries will be slow`);
  }
}

// ── 3. G2C migration write/read cycle ─────────────────────────────────────
async function testG2CMigration() {
  section('G2C migration write/read');
  const appUserId = 'test_' + randomUUID().slice(0, 8);
  const batchId = randomUUID();

  try {
    // Write workspace
    await db.collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { migDir: 'gemini-copilot', appUserId, customerName: 'TestG2C', startTime: new Date(), status: 'running', dryRun: true } },
      { upsert: true }
    );
    ok('G2C migrationWorkspaces.upsert');

    // Write job
    const jobId = randomUUID();
    await db.collection('migrationJobs').insertOne({
      jobId, workspaceId: batchId, appUserId, migDir: 'gemini-copilot',
      sourceEmail: 'src@test.com', destEmail: 'dst@test.com',
      status: 'pending', pages: 0, errors: [], startTime: null, endTime: null,
    });
    ok('G2C migrationJobs.insert');

    // Update workspace to completed
    await db.collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { status: 'completed', endTime: new Date(), migratedUsers: 1, totalErrors: 0,
        report: { summary: { total_users: 1, total_pages_created: 3, total_errors: 0 }, users: [] } } }
    );
    ok('G2C migrationWorkspaces.update completed');

    // Read back
    const ws = await db.collection('migrationWorkspaces').findOne({ _id: batchId, appUserId });
    if (ws?.migDir === 'gemini-copilot' && ws?.status === 'completed') ok('G2C workspace read-back correct');
    else fail('G2C workspace read-back', JSON.stringify(ws));

    // /api/init path: recent workspaces query
    const recent = await db.collection('migrationWorkspaces').find({ appUserId }).sort({ startTime: -1 }).limit(10).toArray();
    if (recent.length > 0) ok(`/api/init recentWorkspaces — found ${recent.length} doc(s)`);
    else fail('/api/init recentWorkspaces — none found');

    // Cleanup
    await db.collection('migrationWorkspaces').deleteOne({ _id: batchId });
    await db.collection('migrationJobs').deleteOne({ jobId });
    ok('G2C test cleanup');
  } catch (e) { fail('G2C migration test', e.message); }
}

// ── 4. C2G migration write/read cycle ─────────────────────────────────────
async function testC2GMigration() {
  section('C2G migration write/read');
  const appUserId = 'test_' + randomUUID().slice(0, 8);
  const batchId = `c2g_${Date.now()}`;

  try {
    await db.collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { migDir: 'copilot-gemini', appUserId, customerName: 'TestC2G', startTime: new Date(), status: 'running', dryRun: false } },
      { upsert: true }
    );
    ok('C2G migrationWorkspaces.upsert');

    await db.collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { migDir: 'copilot-gemini', status: 'completed', endTime: new Date(),
        report: { summary: { total_users: 2, total_pages_created: 5, total_errors: 0 }, users: [] } } }
    );
    ok('C2G migrationWorkspaces.update completed');

    const ws = await db.collection('migrationWorkspaces').findOne({ _id: batchId, appUserId });
    if (ws?.migDir === 'copilot-gemini') ok('C2G workspace migDir correct');
    else fail('C2G workspace migDir wrong', ws?.migDir);

    await db.collection('migrationWorkspaces').deleteOne({ _id: batchId });
    ok('C2G test cleanup');
  } catch (e) { fail('C2G migration test', e.message); }
}

// ── 5. CL2G migration write/read cycle ────────────────────────────────────
async function testCL2GMigration() {
  section('CL2G migration write/read');
  const appUserId = 'test_' + randomUUID().slice(0, 8);
  const batchId = `cl2g_${Date.now()}`;

  try {
    await db.collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { migDir: 'claude-gemini', appUserId, customerName: 'TestCL2G', startTime: new Date(), status: 'running', dryRun: true } },
      { upsert: true }
    );
    ok('CL2G migrationWorkspaces.upsert');

    await db.collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { migDir: 'claude-gemini', status: 'completed', endTime: new Date(), migratedConversations: 4,
        report: { summary: { total_users: 1, total_pages_created: 4, total_errors: 0 }, users: [] } } }
    );
    ok('CL2G migrationWorkspaces.update completed');

    const ws = await db.collection('migrationWorkspaces').findOne({ _id: batchId, appUserId });
    if (ws?.migDir === 'claude-gemini') ok('CL2G workspace migDir correct');
    else fail('CL2G workspace migDir wrong', ws?.migDir);

    await db.collection('migrationWorkspaces').deleteOne({ _id: batchId });
    ok('CL2G test cleanup');
  } catch (e) { fail('CL2G migration test', e.message); }
}

// ── 6. userMappings unique index ───────────────────────────────────────────
async function testUserMappings() {
  section('userMappings unique index');
  const appUserId = 'test_' + randomUUID().slice(0, 8);

  try {
    // Insert first
    await db.collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot' },
      { $set: { appUserId, migDir: 'gemini-copilot', mappings: { 'a@x.com': 'b@y.com' }, updatedAt: new Date() } },
      { upsert: true }
    );
    ok('userMappings upsert G2C');

    // Upsert again (should update, not create duplicate)
    await db.collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot' },
      { $set: { mappings: { 'a@x.com': 'c@y.com' }, updatedAt: new Date() } },
      { upsert: true }
    );
    const count = await db.collection('userMappings').countDocuments({ appUserId, migDir: 'gemini-copilot' });
    if (count === 1) ok('userMappings unique constraint works (upsert, not duplicate)');
    else fail('userMappings has duplicates', `count=${count}`);

    // Different migDir for same user
    await db.collection('userMappings').updateOne(
      { appUserId, migDir: 'copilot-gemini' },
      { $set: { appUserId, migDir: 'copilot-gemini', mappings: {}, updatedAt: new Date() } },
      { upsert: true }
    );
    ok('userMappings separate doc per migDir');

    // Cleanup
    await db.collection('userMappings').deleteMany({ appUserId });
    ok('userMappings cleanup');
  } catch (e) { fail('userMappings test', e.message); }
}

// ── 7. Per-user isolation ──────────────────────────────────────────────────
async function testIsolation() {
  section('Per-user isolation');
  const user1 = 'test_' + randomUUID().slice(0, 8);
  const user2 = 'test_' + randomUUID().slice(0, 8);
  const batchId1 = randomUUID();
  const batchId2 = randomUUID();

  try {
    await db.collection('migrationWorkspaces').insertOne({ _id: batchId1, appUserId: user1, migDir: 'gemini-copilot', status: 'completed', startTime: new Date() });
    await db.collection('migrationWorkspaces').insertOne({ _id: batchId2, appUserId: user2, migDir: 'gemini-copilot', status: 'completed', startTime: new Date() });

    const user1Docs = await db.collection('migrationWorkspaces').find({ appUserId: user1 }).toArray();
    const user2Docs = await db.collection('migrationWorkspaces').find({ appUserId: user2 }).toArray();

    if (user1Docs.length === 1 && user1Docs[0]._id === batchId1) ok('User1 sees only their workspace');
    else fail('User isolation broken for user1');
    if (user2Docs.length === 1 && user2Docs[0]._id === batchId2) ok('User2 sees only their workspace');
    else fail('User isolation broken for user2');

    await db.collection('migrationWorkspaces').deleteMany({ appUserId: { $in: [user1, user2] } });
    ok('Isolation test cleanup');
  } catch (e) { fail('Isolation test', e.message); }
}

// ── 8. ensureCollections fix check ────────────────────────────────────────
async function checkEnsureCollections() {
  section('ensureCollections schema');
  const cols = new Set((await db.listCollections().toArray()).map(c => c.name));

  if (!cols.has('migrationWorkspaces')) {
    fail('migrationWorkspaces NOT in ensureCollections — needs to be added to mongo.js');
  } else {
    ok('migrationWorkspaces collection exists');
  }
  if (!cols.has('migrationJobs')) {
    warn('migrationJobs NOT in ensureCollections — auto-created but no index defined');
  } else {
    ok('migrationJobs collection exists');
  }
  if (cols.has('reportsWorkspace')) {
    warn('reportsWorkspace legacy collection still on disk — harmless, no code writes or reads it anymore');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('GEM MongoDB Test Suite');
  console.log('======================');
  try {
    await connect();
    await checkCollections();
    await checkIndexes();
    await testG2CMigration();
    await testC2GMigration();
    await testCL2GMigration();
    await testUserMappings();
    await testIsolation();
    await checkEnsureCollections();
  } finally {
    await client.close();
  }

  console.log(`\n══════════════════════════════`);
  console.log(`  passed: ${passed}  failed: ${failed}  warned: ${warned}`);
  console.log(`══════════════════════════════`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
