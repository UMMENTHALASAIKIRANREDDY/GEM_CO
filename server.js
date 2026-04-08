import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { EventEmitter } from 'events';

import { getAuthUrl, acquireTokenByCode, isAuthenticated, getDelegatedToken, clearMsToken } from './src/auth/microsoft.js';
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, getGoogleOAuth2Client, clearGoogleToken } from './src/auth/googleOAuth.js';
import { google } from 'googleapis';
import { VaultReader } from './src/modules/vaultReader.js';
import { VaultExporter } from './src/modules/vaultExporter.js';
import { AssetScanner } from './src/modules/assetScanner.js';
import { ResponseGenerator } from './src/modules/responseGenerator.js';
import { PagesCreator } from './src/modules/pagesCreator.js';
import { ReportWriter } from './src/modules/reportWriter.js';
import { CheckpointManager } from './src/utils/checkpoint.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';
import { connectMongo, getDb } from './src/db/mongo.js';
import session from 'express-session';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const migrationEvents = new EventEmitter();
const logBuffer = []; // replay buffer for late SSE clients

// Store tenant ID for auth flow
let currentTenantId = null;

// ─── Ensure runtime dirs exist ────────────────────────────────────────────────
const uploadsDir   = path.join(__dirname, 'uploads');
const reportsDir   = path.join(__dirname, 'uploads', 'reports');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });

// ─── MongoDB helpers ─────────────────────────────────────────────────────────
import { getLogger } from './src/utils/logger.js';
const dbLog = getLogger('db:ops');
function db() { return getDb(); }

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'gemco-session-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ─── App Auth (login gate) ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.appUser) return next();
  res.status(401).json({ error: 'Not logged in' });
}

// Serve login page for unauthenticated users at root
app.get('/', (req, res) => {
  if (req.session?.appUser) {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'ui', 'login.html'));
  }
});

// Static files (CSS, JS, images) — always accessible
app.use(express.static(path.join(__dirname, 'ui')));

// Login / logout / me
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await db().collection('appUsers').findOne({ email: email.toLowerCase().trim() });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.appUser = { _id: user._id.toString(), email: user.email, name: user.name, role: user.role };
  res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
});

app.get('/api/me', (req, res) => {
  if (req.session?.appUser) return res.json(req.session.appUser);
  res.status(401).json({ error: 'Not logged in' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── User Workspace (cross-device state) ─────────────────────────────────────
app.get('/api/workspace', async (req, res) => {
  const userId = req.session.appUser._id;
  const doc = await db().collection('userWorkspace').findOne({ userId });
  res.json(doc || null);
});

app.put('/api/workspace', async (req, res) => {
  const userId = req.session.appUser._id;
  const { step, uploadData, config, mappings, selectedUsers, options,
          migDone, stats, currentBatchId, lastRunWasDry } = req.body;
  await db().collection('userWorkspace').updateOne(
    { userId },
    { $set: { userId, step, uploadData, config, mappings, selectedUsers, options,
               migDone, stats, currentBatchId, lastRunWasDry, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});

// Admin: manage app users
app.get('/api/users', requireAuth, async (req, res) => {
  if (req.session.appUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const users = await db().collection('appUsers').find({}, { projection: { password: 0 } }).toArray();
  res.json(users);
});

app.post('/api/users', requireAuth, async (req, res) => {
  if (req.session.appUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { email, name, password, role = 'user' } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, name, password required' });
  const hashed = await bcrypt.hash(password, 10);
  try {
    await db().collection('appUsers').insertOne({ email: email.toLowerCase().trim(), password: hashed, name, role, createdAt: new Date() });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files are accepted'));
  }
});

// ─── Protect all API routes (except auth-related) ───────────────────────────
const PUBLIC_PATHS = ['/api/login', '/api/me', '/api/logout'];
app.use('/api', (req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
  next();
});
app.use('/auth', (req, res, next) => {
  if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
  next();
});

// ─── OAuth: Sign in with Microsoft ────────────────────────────────────────────

// Step 1: Redirect admin to Microsoft login
app.get('/auth/login', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    if (!tenantId) return res.status(400).send('tenant_id query parameter required');
    currentTenantId = tenantId;
    const authUrl = await getAuthUrl(tenantId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// Step 2: Microsoft redirects here after admin signs in
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      return res.send(`<html><body><h2>Auth failed</h2><p>${error_description || error}</p><script>window.close();</script></body></html>`);
    }
    if (!code) return res.status(400).send('No authorization code received');

    const msResult = await acquireTokenByCode(currentTenantId, code);

    // Record login in MongoDB
    try {
      const msEmail = msResult?.account?.username || 'unknown';
      await db().collection('users').updateOne(
        { email: msEmail, provider: 'microsoft' },
        { $set: { displayName: msResult?.account?.name || '', tenantId: currentTenantId, lastLogin: new Date() } },
        { upsert: true }
      );
      dbLog.info(`users.upsert — ${msEmail} (microsoft)`);
    } catch (e) { dbLog.warn(`users.upsert failed: ${e.message}`); }

    // Close the popup and notify the parent window
    res.send(`
      <html><body>
        <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">✓ Signed in successfully!</h2>
        <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
        <script>
          if (window.opener) { window.opener.postMessage({ type: 'auth-success' }, '*'); }
          setTimeout(() => window.close(), 1500);
        </script>
      </body></html>
    `);
  } catch (err) {
    res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`);
  }
});

// Step 3: UI polls this to check auth status
app.get('/auth/status', (_req, res) => {
  res.json({ authenticated: isAuthenticated() });
});

// ─── OAuth: Sign in with Google ──────────────────────────────────────────────

app.get('/auth/google/login', (_req, res) => {
  try {
    const authUrl = getGoogleAuthUrl();
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Google auth error: ${err.message}`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) {
      return res.send(`<html><body><h2>Auth failed</h2><p>${error}</p><script>window.close();</script></body></html>`);
    }
    if (!code) return res.status(400).send('No authorization code received');

    await acquireGoogleTokenByCode(code);

    // Record Google login in MongoDB
    try {
      const auth = getGoogleOAuth2Client();
      const oauth2 = google.oauth2({ version: 'v2', auth });
      const { data: profile } = await oauth2.userinfo.get();
      await db().collection('users').updateOne(
        { email: profile.email, provider: 'google' },
        { $set: { displayName: profile.name || '', lastLogin: new Date() } },
        { upsert: true }
      );
      dbLog.info(`users.upsert — ${profile.email} (google)`);
    } catch (e) { dbLog.warn(`users.upsert failed: ${e.message}`); }

    res.send(`
      <html><body>
        <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">✓ Google signed in!</h2>
        <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
        <script>
          if (window.opener) { window.opener.postMessage({ type: 'google-auth-success' }, '*'); }
          setTimeout(() => window.close(), 1500);
        </script>
      </body></html>
    `);
  } catch (err) {
    res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`);
  }
});

app.get('/auth/google/status', (_req, res) => {
  res.json({ authenticated: isGoogleAuthenticated() });
});

app.post('/auth/google/logout', (_req, res) => {
  clearGoogleToken();
  res.json({ ok: true });
});

app.post('/auth/logout', (_req, res) => {
  clearMsToken();
  res.json({ ok: true });
});

// ─── Google Users (Admin SDK) ────────────────────────────────────────────────

app.get('/api/google/users', async (_req, res) => {
  try {
    const auth = getGoogleOAuth2Client();
    const admin = google.admin({ version: 'directory_v1', auth });
    const users = [];
    let pageToken = undefined;

    do {
      const resp = await admin.users.list({
        customer: 'my_customer',
        maxResults: 200,
        orderBy: 'email',
        pageToken,
      });
      if (resp.data.users) {
        users.push(...resp.data.users.map(u => ({
          email: u.primaryEmail,
          name: u.name?.fullName || u.primaryEmail,
        })));
      }
      pageToken = resp.data.nextPageToken;
    } while (pageToken);

    // Persist to cloudMembers
    try {
      if (users.length > 0) {
        const ops = users.map(u => ({
          updateOne: {
            filter: { email: u.email, source: 'google' },
            update: { $set: { displayName: u.name, discoveredAt: new Date() } },
            upsert: true
          }
        }));
        await db().collection('cloudMembers').bulkWrite(ops, { ordered: false });
        dbLog.info(`cloudMembers.bulkWrite — ${users.length} google users`);
      }
    } catch (e) { dbLog.warn(`cloudMembers.bulkWrite failed: ${e.message}`); }

    res.json({ total: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Vault Export ─────────────────────────────────────────────────────

// Active export tracking
let activeExport = null;

app.post('/api/google/vault-export', async (req, res) => {
  try {
    const { user_emails } = req.body;
    if (!user_emails || user_emails.length === 0) {
      return res.status(400).json({ error: 'user_emails array required' });
    }

    const auth = getGoogleOAuth2Client();
    const exporter = new VaultExporter(auth);

    const matter = await exporter.createMatter(`GEM_CO Export ${new Date().toISOString()}`);
    const exportData = await exporter.createExport(matter.matterId, user_emails);

    activeExport = {
      matterId: matter.matterId,
      exportId: exportData.id,
      status: 'IN_PROGRESS',
      userEmails: user_emails,
      exporter,
    };

    // Persist to vaultExports
    await db().collection('vaultExports').updateOne(
      { exportId: exportData.id },
      { $set: { matterId: matter.matterId, userEmails: user_emails, status: 'IN_PROGRESS', requestedAt: new Date() } },
      { upsert: true }
    );
    dbLog.info(`vaultExports.upsert — export ${exportData.id} (${user_emails.length} users)`);

    res.json({ matter_id: matter.matterId, export_id: exportData.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/vault-export/status', async (_req, res) => {
  try {
    if (!activeExport) {
      return res.status(404).json({ error: 'No active export' });
    }

    const { exporter, matterId, exportId } = activeExport;
    
    console.log(`[${new Date().toISOString()}] UI polling export status for ${exportId}...`);
    
    const exportRes = await exporter.vault.matters.exports.get({ matterId, exportId });
    const status = exportRes.data.status;
    const stats = exportRes.data.stats || {};
    
    console.log(`[${new Date().toISOString()}] Export status: ${status}, exported=${stats.exportedArtifactCount || 0}, total=${stats.totalArtifactCount || 0}`);
    
    activeExport.status = status;

    if (status === 'COMPLETED') {
      console.log(`[${new Date().toISOString()}] Export completed! Starting download...`);
      
      // Download and extract
      const destDir = path.join(__dirname, 'uploads', `vault_export_${Date.now()}`);
      await exporter.downloadExport(matterId, exportId, destDir);
      await exporter.closeMatter(matterId);

      console.log(`[${new Date().toISOString()}] Download complete, extracting zips and parsing XML files...`);

      // Extract any zip files from the Vault export
      const zipFiles = fs.readdirSync(destDir).filter(f => f.toLowerCase().endsWith('.zip'));
      for (const zf of zipFiles) {
        const zipPath = path.join(destDir, zf);
        try {
          new AdmZip(zipPath).extractAllTo(destDir, true);
          console.log(`[${new Date().toISOString()}] Extracted: ${zf}`);
        } catch (e) {
          console.log(`[${new Date().toISOString()}] Could not extract ${zf}: ${e.message}`);
        }
      }

      // Parse with VaultReader — same as /api/upload
      const xmlFiles = fs.readdirSync(destDir).filter(f => f.toLowerCase().endsWith('.xml'));
      if (xmlFiles.length === 0) {
        console.log(`[${new Date().toISOString()}] ERROR: No XML files found in export`);
        return res.json({ status, error: 'Export completed but no XML files found.' });
      }

      const reader = new VaultReader(destDir);
      const users = await reader.discoverUsers();

      console.log(`[${new Date().toISOString()}] Parsed ${users.length} users from export`);

      // Update vaultExports in MongoDB
      await db().collection('vaultExports').updateOne(
        { exportId },
        { $set: { status: 'COMPLETED', completedAt: new Date() } }
      );
      dbLog.info(`vaultExports.update — export ${exportId} COMPLETED`);

      activeExport = null;

      return res.json({
        status,
        upload_id: path.basename(destDir),
        extract_path: destDir,
        total_users: users.length,
        total_conversations: users.reduce((s, u) => s + u.conversationCount, 0),
        users: users.map(u => ({
          email: u.email,
          display_name: u.displayName,
          conversation_count: u.conversationCount,
        })),
      });
    }

    if (status === 'FAILED') {
      console.log(`[${new Date().toISOString()}] Export FAILED`);
      await db().collection('vaultExports').updateOne(
        { exportId },
        { $set: { status: 'FAILED', completedAt: new Date(), error: 'Vault export failed' } }
      );
      dbLog.info(`vaultExports.update — export ${exportId} FAILED`);
      activeExport = null;
      return res.json({ status, error: 'Vault export failed' });
    }

    res.json({ status });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking export status:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── MS Users list (for CSV download) ────────────────────────────────────────
app.get('/api/ms/users', async (req, res) => {
  try {
    if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    const token = getDelegatedToken();
    let users = [];
    let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName&$top=999';
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data.error?.message || 'Graph API error' });
      users = users.concat(data.value || []);
      url = data['@odata.nextLink'] || null;
    }

    // Persist to cloudMembers
    try {
      if (users.length > 0) {
        const ops = users.map(u => ({
          updateOne: {
            filter: { email: u.mail || u.userPrincipalName, source: 'microsoft' },
            update: { $set: { displayName: u.displayName, tenantId: req.query.tenant_id || null, discoveredAt: new Date() } },
            upsert: true
          }
        }));
        await db().collection('cloudMembers').bulkWrite(ops, { ordered: false });
        dbLog.info(`cloudMembers.bulkWrite — ${users.length} microsoft users`);
      }
    } catch (e) { dbLog.warn(`cloudMembers.bulkWrite failed: ${e.message}`); }

    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload ZIP ───────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('vault_zip'), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const extractTo = path.join(__dirname, 'uploads', `extracted_${req.file.filename}`);

    fs.mkdirSync(extractTo, { recursive: true });
    new AdmZip(zipPath).extractAllTo(extractTo, true);

    const xmlFiles = fs.readdirSync(extractTo)
      .filter(f => f.toLowerCase().endsWith('.xml'));

    if (xmlFiles.length === 0) {
      return res.status(400).json({
        error: 'No XML files found in ZIP. Vault export should contain .xml files named after user emails.',
        files_found: fs.readdirSync(extractTo).slice(0, 20)
      });
    }

    const reader = new VaultReader(extractTo);
    const users = await reader.discoverUsers();

    if (users.length === 0) {
      return res.status(400).json({ error: 'No users found in Vault export XML files.' });
    }

    const usersArr = users.map(u => ({
      email: u.email,
      displayName: u.displayName,
      conversationCount: u.conversationCount
    }));

    const uploadDoc = {
      _id: req.file.filename,
      originalName: req.file.originalname || 'vault_export.zip',
      uploadTime: new Date(),
      extractPath: extractTo,
      totalUsers: users.length,
      totalConversations: users.reduce((s, u) => s + u.conversationCount, 0),
      users: usersArr,
      appUserId: req.session.appUser?._id || null,
    };
    await db().collection('uploads').updateOne(
      { _id: uploadDoc._id },
      { $set: uploadDoc },
      { upsert: true }
    );
    dbLog.info(`uploads.upsert — ${uploadDoc.originalName} (${uploadDoc.totalUsers} users, ${uploadDoc.totalConversations} conversations)`);

    res.json({
      id: uploadDoc._id,
      original_name: uploadDoc.originalName,
      upload_time: uploadDoc.uploadTime.toISOString(),
      extract_path: extractTo,
      total_users: uploadDoc.totalUsers,
      total_conversations: uploadDoc.totalConversations,
      users: usersArr.map(u => ({
        email: u.email,
        display_name: u.displayName,
        conversation_count: u.conversationCount
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload Management ────────────────────────────────────────────────────────
app.get('/api/uploads', async (req, res) => {
  const appUserId = req.session.appUser?._id || null;
  const uploads = await db().collection('uploads').find({ appUserId }).sort({ uploadTime: -1 }).toArray();
  res.json({
    uploads: uploads.map(u => ({
      id: u._id,
      original_name: u.originalName,
      upload_time: u.uploadTime,
      extract_path: u.extractPath,
      total_users: u.totalUsers,
      total_conversations: u.totalConversations,
      users: (u.users || []).map(x => ({ email: x.email, display_name: x.displayName, conversation_count: x.conversationCount }))
    }))
  });
});

app.delete('/api/uploads/:id', async (req, res) => {
  const { id } = req.params;
  const entry = await db().collection('uploads').findOne({ _id: id });
  if (!entry) return res.status(404).json({ error: 'Upload not found' });
  try { fs.rmSync(entry.extractPath, { recursive: true, force: true }); } catch {}
  await db().collection('uploads').deleteOne({ _id: id });
  dbLog.info(`uploads.delete — ${id}`);
  res.json({ ok: true });
});

// ─── Report Downloads ─────────────────────────────────────────────────────────

// List all batch reports (without full report body for performance)
app.get('/api/reports', async (req, res) => {
  const appUserId = req.session.appUser?._id || null;
  const reports = await db().collection('reportsWorkspace')
    .find({ appUserId }, { projection: { report: 0 } })
    .sort({ startTime: -1 })
    .toArray();
  res.json(reports);
});

// Aggregate stats across all completed batches
app.get('/api/reports/aggregate', async (req, res) => {
  const appUserId = req.session.appUser?._id || null;
  const pipeline = [
    { $match: { status: 'completed', appUserId } },
    { $group: {
      _id: null,
      totalBatches: { $sum: 1 },
      totalUsers: { $sum: '$totalUsers' },
      totalPages: { $sum: '$migratedConversations' },
      totalErrors: { $sum: { $ifNull: ['$report.summary.total_errors', 0] } },
      liveBatches: { $sum: { $cond: [{ $ne: ['$dryRun', true] }, 1, 0] } },
      dryRunBatches: { $sum: { $cond: [{ $eq: ['$dryRun', true] }, 1, 0] } }
    }}
  ];
  const [agg] = await db().collection('reportsWorkspace').aggregate(pipeline).toArray();
  const result = agg || { totalBatches: 0, totalUsers: 0, totalPages: 0, totalErrors: 0, liveBatches: 0, dryRunBatches: 0 };
  delete result._id;
  res.json(result);
});

// Previously migrated users for a given uploadId (for duplicate-migration warnings)
app.get('/api/batches/migrated-users', async (req, res) => {
  const { uploadId } = req.query;
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
  const appUserId = req.session.appUser?._id || null;
  const batches = await db().collection('reportsWorkspace')
    .find({ uploadId, appUserId, status: 'completed', dryRun: { $ne: true } }, { projection: { 'report.users.email': 1 } })
    .toArray();
  const migrated = new Set();
  batches.forEach(b => (b.report?.users || []).forEach(u => migrated.add(u.email)));
  res.json({ migrated_users: [...migrated] });
});

// Server-side CSV download for a batch
app.get('/api/reports/:id/csv', async (req, res) => {
  const doc = await db().collection('reportsWorkspace').findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Batch not found' });
  const users = doc.report?.users || [];
  const rows = ['Email,Status,Pages Created,Conversations,Errors,Error Message'];
  users.forEach(u => {
    if (u.errors?.length > 0) {
      u.errors.forEach(e => rows.push([u.email, u.status, u.pages_created, u.conversations_processed, u.error_count, e.error_message || ''].map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',')));
    } else {
      rows.push([u.email, u.status, u.pages_created, u.conversations_processed, u.error_count, ''].map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(','));
    }
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="batch_${req.params.id}.csv"`);
  res.send(rows.join('\n'));
});

// Get a specific batch report — JSON inline; ?download=true forces download, ?summary=true returns lightweight metadata
app.get('/api/reports/:id', async (req, res) => {
  const { id } = req.params;
  // Legacy alias
  if (id === 'migration') {
    const latest = await db().collection('reportsWorkspace').findOne({}, { sort: { startTime: -1 } });
    if (!latest) return res.status(404).json({ error: 'No report yet' });
    return res.json(latest.report || latest);
  }
  const doc = await db().collection('reportsWorkspace').findOne({ _id: id });
  if (!doc) return res.status(404).json({ error: 'Batch report not found' });
  if (req.query.download === 'true') {
    res.setHeader('Content-Disposition', `attachment; filename="migration_report_${id}.json"`);
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.query.summary === 'true') {
    const { report, ...meta } = doc;
    return res.json({ ...meta, summary: report?.summary || null });
  }
  res.json(doc.report || doc);
});

// ─── User Mappings ───────────────────────────────────────────────────────────
app.get('/api/user-mappings/latest', async (_req, res) => {
  const doc = await db().collection('userMappings').findOne({ batchId: 'latest' });
  res.json(doc || null);
});

app.post('/api/user-mappings', async (req, res) => {
  const { customerName, mappings, selectedUsers } = req.body;
  await db().collection('userMappings').updateOne(
    { batchId: 'latest' },
    { $set: { customerName, mappings, selectedUsers, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  dbLog.info(`userMappings.upsert — ${Object.keys(mappings || {}).length} mappings, ${(selectedUsers || []).length} selected`);
  res.json({ ok: true });
});

// ─── Migration Logs (historical) ────────────────────────────────────────────
app.get('/api/migration-logs/:batchId', async (req, res) => {
  const logs = await db().collection('migrationLogs')
    .find({ batchId: req.params.batchId })
    .sort({ ts: 1 })
    .toArray();
  res.json(logs);
});

// ─── SSE — live log stream ────────────────────────────────────────────────────
app.get('/api/migration-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Replay all buffered logs to late-joining clients
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const onLog = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  migrationEvents.on('log', onLog);
  req.on('close', () => migrationEvents.off('log', onLog));
});

let currentBatchId = null;

function emit(type, message, extra = {}) {
  const entry = { type, message, ts: new Date().toISOString(), ...extra };
  logBuffer.push(entry);
  migrationEvents.emit('log', entry);
  // Persist to MongoDB (fire-and-forget)
  if (currentBatchId) {
    db().collection('migrationLogs').insertOne({
      batchId: currentBatchId, type, message, ts: new Date(), extra
    }).catch(() => {});
  }
}

// ─── Start Migration ──────────────────────────────────────────────────────────
app.post('/api/migrate', async (req, res) => {
  const {
    extract_path,
    tenant_id,
    customer_name = 'Gemini',
    user_mappings = {},
    dry_run = false,
    skip_followups = false,
    skip_ai_response = false,
    from_date = null,
    to_date = null,
    upload_id = null
  } = req.body;

  if (!extract_path || !tenant_id) {
    return res.status(400).json({ error: 'extract_path and tenant_id are required' });
  }

  if (!dry_run && !isAuthenticated()) {
    return res.status(401).json({ error: 'Admin not signed in. Click "Sign in with Microsoft" first.' });
  }

  const batch_id = Date.now().toString();
  const appUserId = req.session.appUser?._id || null;
  res.json({ started: true, batch_id });
  runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId });
});

async function withConcurrency(items, limit, fn) {
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    executing.push(p);
    const clean = () => executing.splice(executing.indexOf(p), 1);
    p.then(clean, clean);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(executing);
}

async function runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId }) {
  logBuffer.length = 0; // clear previous run's logs
  const batchId = batch_id || Date.now().toString();
  currentBatchId = batchId;
  const startTime = new Date();

  // Save user mappings snapshot for this batch
  await db().collection('userMappings').updateOne(
    { batchId },
    { $set: { customerName: customer_name, mappings: user_mappings, createdAt: startTime, appUserId } },
    { upsert: true }
  );
  dbLog.info(`userMappings.upsert — batch ${batchId} (${Object.keys(user_mappings).length} mappings)`);

  // Create reportsWorkspace doc (include uploadId + appUserId for per-user filtering)
  await db().collection('reportsWorkspace').updateOne(
    { _id: batchId },
    { $set: { customerName: customer_name, tenantId: tenant_id, startTime, status: 'running', dryRun: dry_run, uploadId: upload_id, appUserId } },
    { upsert: true }
  );
  dbLog.info(`reportsWorkspace.insert — batch ${batchId} status=running`);

  await new Promise(r => setTimeout(r, 200));
  emit('info', '━━━ Migration started ━━━');
  if (skip_ai_response) emit('info', 'Azure OpenAI disabled — migrating original Gemini responses only');

  try {
    const reader = new VaultReader(extract_path);
    const allUsers = await reader.discoverUsers();
    // Filter to only selected users (those present in user_mappings)
    const users = Object.keys(user_mappings).length > 0
      ? allUsers.filter(u => Object.prototype.hasOwnProperty.call(user_mappings, u.email))
      : allUsers;

    emit('info', `Discovered ${allUsers.length} users — migrating ${users.length} selected`);

    if (dry_run) {
      for (const u of users) {
        const m365Email = user_mappings[u.email] || u.email;
        emit('user', `${u.email} → ${m365Email} (${u.conversationCount} conversations)`);
      }
      const total = users.reduce((s, u) => s + u.conversationCount, 0);
      await db().collection('reportsWorkspace').updateOne(
        { _id: batchId },
        { $set: {
          status: 'completed', endTime: new Date(), dryRun: true,
          totalUsers: users.length, totalConversations: total,
          migratedUsers: 0, migratedConversations: 0, failedUsers: 0,
          report: { summary: { total_users: users.length, total_conversations: total, total_pages_created: 0, total_errors: 0 } }
        }}
      );
      emit('done', `DRY RUN complete — ${users.length} users, ${total} conversations. No API calls made.`, { batch_id: batchId });
      currentBatchId = null;
      return;
    }

    // Module 2 — Asset Scanner
    const scanner = new AssetScanner();
    const visualReports = {};
    for (const u of users) {
      const convs = await reader.loadUserConversations(u.email, from_date, to_date);
      visualReports[u.email] = scanner.scan(u.email, convs);
      if (visualReports[u.email].length > 0) {
        emit('warn', `${u.email}: ${visualReports[u.email].length} conversations flagged for visual assets`);
      }
    }

    const report = new ReportWriter();
    const generator = new ResponseGenerator();
    const creator = new PagesCreator(tenant_id, customer_name);
    const checkpoint = new CheckpointManager(batchId);

    await withConcurrency(users, 5, async (u) => {
      const googleEmail = u.email;
      const m365Email = user_mappings[googleEmail] || googleEmail;

      emit('info', `Processing: ${googleEmail} → ${m365Email}`);

      let conversations = null;
      const errors = [];
      let pagesCreated = 0;

      try {
        conversations = await reader.loadUserConversations(googleEmail, from_date, to_date);
        emit('info', `  Loaded ${conversations.length} conversations for ${googleEmail}`);

        for (const conv of conversations) {
          try {
            let convWithResponses;
            if (skip_ai_response) {
              convWithResponses = conv; // use original conversations without AI responses
            } else {
              convWithResponses = await generator.generate(conv, skip_followups);
            }
            await creator.createPage(m365Email, convWithResponses, visualReports[googleEmail] || []);
            pagesCreated++;
            emit('success', `  Page created: ${conv.title?.slice(0, 60)}`);
          } catch (err) {
            errors.push({ conversation: conv.title, error: err.message });
            emit('error', `  Failed: ${conv.title?.slice(0, 40)} — ${err.message}`);
          }
        }

        report.addUserResult({
          email: m365Email,
          conversations: conversations.length,
          pagesCreated,
          visualAssetsFlagged: (visualReports[googleEmail] || []).length,
          errors
        });

        await checkpoint.markComplete(googleEmail);
        emit('success', `  Done: ${pagesCreated}/${conversations.length} pages created for ${m365Email}`);
      } catch (err) {
        emit('error', `Fatal error for ${googleEmail}: ${err.message}`);
        report.addUserResult({ email: m365Email, conversations: 0, pagesCreated: 0, visualAssetsFlagged: 0, errors: [{ error: err.message }] });
      } finally {
        conversations = null;
      }
    });

    // Write report to file (legacy) and MongoDB
    const reportPath = path.join(uploadsDir, 'migration_report.json');
    report.write(reportPath);
    const fullReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    const reportUpdate = {
      status: 'completed',
      endTime: new Date(),
      totalUsers: fullReport.summary?.total_users || users.length,
      migratedUsers: fullReport.summary?.total_users || 0,
      failedUsers: fullReport.summary?.total_errors > 0 ? 1 : 0,
      totalConversations: fullReport.summary?.total_conversations || 0,
      migratedConversations: fullReport.summary?.total_pages_created || 0,
      report: fullReport,
    };

    // Auto-deploy Copilot Declarative Agent after migration
    if (!dry_run) {
      emit('info', '━━━ Deploying Copilot Agent ━━━');
      try {
        const targetEmails = users.map(u => user_mappings[u.email] || u.email);
        const deployer = new AgentDeployer(customer_name, tenant_id);
        const appInfo = await deployer.deployAgent(targetEmails);
        emit('success', `Agent "${customer_name} Conversation Agent" published & installed for ${appInfo.installed}/${appInfo.totalUsers} mapped users`);
        if (appInfo.failedEmails?.length > 0) {
          emit('warn', `Could not auto-install for: ${appInfo.failedEmails.join(', ')} — install manually from Teams Admin Center → Manage Apps`);
        }
        // Persist agent deployment
        reportUpdate.agentDeployment = { installed: appInfo.installed, failed: appInfo.failed, failedEmails: appInfo.failedEmails, totalUsers: appInfo.totalUsers };
        await db().collection('agentDeployments').insertOne({
          batchId, agentName: `${customer_name} Conversation Agent`,
          catalogId: appInfo.id, installed: targetEmails.filter(e => !appInfo.failedEmails?.includes(e)),
          failed: appInfo.failedEmails || [], totalUsers: appInfo.totalUsers, deployedAt: new Date()
        });
        dbLog.info(`agentDeployments.insert — batch ${batchId} (${appInfo.installed}/${appInfo.totalUsers} installed)`);
      } catch (err) {
        emit('warn', `Agent deployment failed (can be done manually): ${err.message}`);
      }
    }

    await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: reportUpdate });
    dbLog.info(`reportsWorkspace.update — batch ${batchId} status=completed (${reportUpdate.migratedConversations} pages, ${reportUpdate.totalUsers} users)`);
    emit('done', `━━━ Migration complete! Reports saved. ━━━`, { batch_id: batchId });
    currentBatchId = null;
  } catch (err) {
    emit('error', `Migration failed: ${err.message}`);
    await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: err.message } }).catch(() => {});
    dbLog.info(`reportsWorkspace.update — batch ${batchId} status=failed`);
    currentBatchId = null;
  }
}

// ─── Retry Failed Conversations ───────────────────────────────────────────────
app.post('/api/migrate/retry', async (req, res) => {
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ error: 'batchId required' });
  if (!isAuthenticated()) return res.status(401).json({ error: 'Not signed in. Click "Sign in with Microsoft" first.' });

  const batchDoc = await db().collection('reportsWorkspace').findOne({ _id: batchId });
  if (!batchDoc) return res.status(404).json({ error: 'Batch not found' });

  const mappingDoc = await db().collection('userMappings').findOne({ batchId });
  // Get most recent upload that matches this batch's extract path, or fall back to latest
  const uploadDoc = await db().collection('uploads').findOne({}, { sort: { uploadTime: -1 } });

  // Build retryTargets: { m365Email → [failedConversationTitles] }
  const retryTargets = {};
  for (const u of batchDoc.report?.users || []) {
    if (u.errors?.length > 0) {
      retryTargets[u.email] = u.errors.map(e => e.conversation);
    }
  }

  if (Object.keys(retryTargets).length === 0) {
    return res.json({ started: false, message: 'No failed conversations to retry' });
  }

  const retryBatchId = `${batchId}_retry_${Date.now()}`;
  res.json({ started: true, batch_id: retryBatchId, targets: retryTargets });

  runRetry({
    batchId,
    retryBatchId,
    extractPath: uploadDoc?.extractPath,
    tenantId: batchDoc.tenantId,
    customerName: batchDoc.customerName,
    userMappings: mappingDoc?.mappings || {},
    retryTargets,
  });
});

async function runRetry({ batchId, retryBatchId, extractPath, tenantId, customerName, userMappings, retryTargets }) {
  logBuffer.length = 0;
  currentBatchId = retryBatchId;

  const totalFailed = Object.values(retryTargets).flat().length;
  emit('info', `━━━ Retrying ${totalFailed} failed conversation(s) ━━━`);

  const reader = new VaultReader(extractPath);
  const generator = new ResponseGenerator();
  const creator = new PagesCreator(tenantId, customerName);
  const report = new ReportWriter();

  // Reverse mapping: m365Email → googleEmail
  const reverseMap = Object.fromEntries(
    Object.entries(userMappings).map(([g, m]) => [m, g])
  );

  for (const [m365Email, failedTitles] of Object.entries(retryTargets)) {
    const googleEmail = reverseMap[m365Email] || m365Email;
    const titleSet = new Set(failedTitles);
    const errors = [];
    let pagesCreated = 0;

    emit('info', `Retrying ${failedTitles.length} conversation(s) for ${m365Email}`);

    try {
      const allConversations = await reader.loadUserConversations(googleEmail, null, null);
      const toRetry = allConversations.filter(c => titleSet.has(c.title));

      if (toRetry.length === 0) {
        emit('warn', `  No matching conversations found for ${m365Email} — skipping`);
        continue;
      }

      for (const conv of toRetry) {
        try {
          const convWithResponses = await generator.generate(conv, false);
          await creator.createPage(m365Email, convWithResponses, []);
          pagesCreated++;
          emit('success', `  Retried: ${conv.title?.slice(0, 60)}`);
        } catch (err) {
          errors.push({ conversation: conv.title, error: err.message });
          emit('error', `  Still failing: ${conv.title?.slice(0, 40)} — ${err.message}`);
        }
      }

      report.addUserResult({ email: m365Email, conversations: toRetry.length, pagesCreated, visualAssetsFlagged: 0, errors });
      emit('success', `  Done: ${pagesCreated}/${toRetry.length} retried for ${m365Email}`);
    } catch (err) {
      emit('error', `Fatal for ${m365Email}: ${err.message}`);
    }
  }

  // Patch original reportsWorkspace with retry results
  const retryReport = report.getReport();
  await db().collection('reportsWorkspace').updateOne(
    { _id: batchId },
    { $set: { 'report.retry': retryReport, retryAt: new Date() } }
  ).catch(() => {});

  const retried = retryReport.summary.total_pages_created;
  const stillFailing = retryReport.summary.total_errors;
  emit('done', `━━━ Retry complete — ${retried} recovered, ${stillFailing} still failing ━━━`, { batch_id: retryBatchId });
  currentBatchId = null;
}

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`\nGemini → Copilot Migration UI`);
    console.log(`Open: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
