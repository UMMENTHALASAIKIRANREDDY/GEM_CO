import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { EventEmitter } from 'events';

import { getAuthUrl, acquireTokenByCode, isAuthenticated, getValidToken, clearMsToken, restoreMsSessions } from './src/auth/microsoft.js';
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, getGoogleOAuth2Client, clearGoogleToken, restoreGoogleSessions } from './src/auth/googleOAuth.js';
import { getDriveService } from './src/auth/google.js';
import { google } from 'googleapis';
import { VaultReader } from './src/modules/vaultReader.js';
import { VaultExporter } from './src/modules/vaultExporter.js';
import { AssetScanner } from './src/modules/assetScanner.js';
import { ResponseGenerator } from './src/modules/responseGenerator.js';
import { PagesCreator } from './src/modules/pagesCreator.js';
import { DriveFileMatcher } from './src/modules/driveFileMatcher.js';
import { FileCorrelator } from './src/modules/fileCorrelator.js';
import { AuditLogClient } from './src/modules/auditLogClient.js';
import { checkPermissions } from './src/modules/permissionsChecker.js';
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
const logBuffers = new Map(); // appUserId → log entries array

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

function getWorkspaceContext(req) {
  const appUserId = req.session.appUser?._id?.toString() || null;
  const googleEmail = req.session.googleEmail || null;
  const msEmail = req.session.msEmail || null;
  return { appUserId, googleEmail, msEmail };
}

/**
 * Returns the full workspace filter for DB queries.
 * Returns null if Google or MS is not connected (data should not be shown).
 */
function getWorkspaceFilter(req) {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  if (!appUserId || !googleEmail || !msEmail) return null;
  return { appUserId, googleEmail, msEmail };
}

/**
 * Middleware: require Google to be signed in.
 * Google is required for all file/vault operations — files come from Drive.
 */
function requireGoogleAuth(req, res, next) {
  const { appUserId, googleEmail } = getWorkspaceContext(req);
  if (!appUserId || !isGoogleAuthenticated(appUserId) || !googleEmail) {
    return res.status(401).json({ error: 'Google account not connected. Please sign in with Google first.' });
  }
  next();
}

/**
 * Middleware: require Microsoft to be signed in.
 */
function requireMsAuth(req, res, next) {
  const { appUserId, msEmail } = getWorkspaceContext(req);
  if (!appUserId || !isAuthenticated(appUserId) || !msEmail) {
    return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
  }
  next();
}

/**
 * Middleware: require both Google AND Microsoft to be signed in (workspace ready).
 */
function requireWorkspace(req, res, next) {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  if (!appUserId || !isGoogleAuthenticated(appUserId) || !googleEmail) {
    return res.status(401).json({ error: 'Google account not connected. Please sign in with Google first.' });
  }
  if (!isAuthenticated(appUserId) || !msEmail) {
    return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
  }
  next();
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

// App config (public — no auth needed)
app.get('/api/app-config', (req, res) => {
  res.json({ showReset: process.env.SHOW_RESET_BUTTON === 'true' });
});

// Login / logout / me
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await db().collection('appUsers').findOne({ email: email.toLowerCase().trim() });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const appUserId = user._id.toString();
  req.session.appUser = { _id: appUserId, email: user.email, name: user.name, role: user.role };

  // Restore cloud account emails from DB so workspace context is immediately available
  try {
    const googleSession = await db().collection('authSessions').findOne({ appUserId, provider: 'google' });
    const msSession = await db().collection('authSessions').findOne({ appUserId, provider: 'microsoft' });
    if (googleSession?.email) req.session.googleEmail = googleSession.email;
    if (msSession?.email) req.session.msEmail = msSession.email;
  } catch {}

  res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
});

// GET /api/diagnose-audit?email=user@domain.com&start=ISO&end=ISO
// Diagnoses Reports API — tries userKey=email and userKey='all'
app.get('/api/diagnose-audit', async (req, res) => {
  const { email, start, end } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const startTime = start ? new Date(start) : new Date(Date.now() - 3 * 60 * 60 * 1000);
  const endTime   = end   ? new Date(end)   : new Date();
  try {
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
    const client = new AuditLogClient(auth);
    const result = await client.testQuery(email, startTime, endTime);
    res.json({ email, startTime, endTime, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/test/drive-transfer
// Body: { fileId, fileName, mimeType, ownerEmail, targetEmail }
// Tests Drive export → OneDrive upload in isolation without a full migration
app.get('/api/test/drive-files', async (req, res) => {
  const { ownerEmail } = req.query;
  try {
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const { google } = await import('googleapis');
    const auth = getGoogleOAuth2Client(appUserId);
    const drive = google.drive({ version: 'v3', auth });
    const r = await drive.files.list({
      q: `'${ownerEmail}' in owners and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 30, orderBy: 'modifiedTime desc',
    });
    res.json({ files: r.data.files || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/test/drive-transfer', async (req, res) => {
  const { fileId, fileName, mimeType, ownerEmail, targetEmail } = req.body;
  if (!fileId || !fileName || !ownerEmail || !targetEmail) {
    return res.status(400).json({ error: 'fileId, fileName, ownerEmail, targetEmail are required' });
  }
  try {
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const googleClient = getGoogleOAuth2Client(appUserId);
    const { DriveFileMatcher } = await import('./src/modules/driveFileMatcher.js');
    const matcher = new DriveFileMatcher(googleClient, ownerEmail, appUserId);
    const driveFile = { id: fileId, name: fileName, mimeType: mimeType || 'application/vnd.google-apps.document' };
    const result = await matcher.uploadToOneDrive(driveFile, targetEmail);
    if (result && !result.error) {
      res.json({ success: true, oneDriveUrl: result, uploadedAs: fileName });
    } else {
      res.json({ success: false, error: result?.error || 'Upload returned null' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
  const { appUserId: userId, googleEmail, msEmail } = getWorkspaceContext(req);
  const doc = await db().collection('userWorkspace').findOne({ userId, googleEmail, msEmail });
  res.json(doc || null);
});

app.put('/api/workspace', async (req, res) => {
  const { appUserId: userId, googleEmail, msEmail } = getWorkspaceContext(req);
  const { step, uploadData, config, mappings, selectedUsers, options,
          migDone, stats, currentBatchId, lastRunWasDry } = req.body;
  await db().collection('userWorkspace').updateOne(
    { userId, googleEmail, msEmail },
    { $set: { userId, googleEmail, msEmail, step, uploadData, config, mappings, selectedUsers, options,
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
    const appUserId = req.session.appUser?._id?.toString();
    const authUrl = await getAuthUrl(tenantId, appUserId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// Step 2: Microsoft redirects here after admin signs in
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error, error_description, state } = req.query;
    if (error) {
      return res.send(`<html><body><h2>Auth failed</h2><p>${error_description || error}</p><script>window.close();</script></body></html>`);
    }
    if (!code) return res.status(400).send('No authorization code received');

    const msResult = await acquireTokenByCode(code, state);

    // Store msEmail in session and force save before closing popup
    const msEmail = msResult.email || msResult?.account?.username || null;
    if (msEmail) {
      req.session.msEmail = msEmail;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }

    dbLog.info(`authSessions.upsert — ${msEmail} (microsoft)`);

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
app.get('/auth/status', (req, res) => {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  res.json({
    authenticated: isAuthenticated(appUserId),
    googleConnected: isGoogleAuthenticated(appUserId),
    msConnected: isAuthenticated(appUserId),
    googleEmail: googleEmail || null,
    msEmail: msEmail || null,
    workspaceReady: !!(googleEmail && msEmail),
  });
});

// ─── OAuth: Sign in with Google ──────────────────────────────────────────────

app.get('/auth/google/login', (req, res) => {
  try {
    const appUserId = req.session.appUser?._id?.toString();
    const authUrl = getGoogleAuthUrl(appUserId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Google auth error: ${err.message}`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) {
      return res.send(`<html><body><h2>Auth failed</h2><p>${error}</p><script>window.close();</script></body></html>`);
    }
    if (!code) return res.status(400).send('No authorization code received');

    const { email } = await acquireGoogleTokenByCode(code, state);

    // Store googleEmail in session and force save before closing popup
    if (email) {
      req.session.googleEmail = email;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }
    dbLog.info(`authSessions.upsert — ${email} (google)`);

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

app.get('/auth/google/status', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  res.json({ authenticated: isGoogleAuthenticated(appUserId) });
});

app.post('/auth/google/logout', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearGoogleToken(appUserId);
  delete req.session.googleEmail;
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearMsToken(appUserId);
  delete req.session.msEmail;
  res.json({ ok: true });
});

// ─── Permissions Check ───────────────────────────────────────────────────────

app.get('/api/check-permissions', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    const googleClient = getGoogleOAuth2Client(appUserId);
    const result = await checkPermissions(googleClient);
    res.json(result);
  } catch (err) {
    // Not authenticated with Google yet
    res.status(401).json({
      drive: false,
      reports: false,
      directory: false,
      errors: { auth: err.message },
    });
  }
});

// ─── Google Users (Admin SDK) ────────────────────────────────────────────────

app.get('/api/google/users', requireGoogleAuth, async (req, res) => {
  try {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
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
            filter: { email: u.email, source: 'google', appUserId, googleEmail, msEmail },
            update: { $set: { appUserId, googleEmail, msEmail, displayName: u.name, discoveredAt: new Date() } },
            upsert: true
          }
        }));
        await db().collection('cloudMembers').bulkWrite(ops, { ordered: false });
        dbLog.info(`cloudMembers.bulkWrite — ${users.length} google users`);
      }
    } catch (e) { dbLog.warn(`cloudMembers.bulkWrite failed: ${e.message}`); }

    res.json({ total: users.length, users });
  } catch (err) {
    console.error('[google/users]', err.message);
    // If Admin SDK fails (insufficient permissions), fall back to cloudMembers cache
    try {
      const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
      const cached = await db().collection('cloudMembers').find({ source: 'google', appUserId }).toArray();
      if (cached.length > 0) {
        return res.json({ total: cached.length, users: cached.map(u => ({ email: u.email, name: u.displayName || u.email })), cached: true, warning: err.message });
      }
    } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Vault Export ─────────────────────────────────────────────────────

// Active export tracking
let activeExport = null;

app.post('/api/google/vault-export', requireGoogleAuth, async (req, res) => {
  try {
    const { user_emails } = req.body;
    if (!user_emails || user_emails.length === 0) {
      return res.status(400).json({ error: 'user_emails array required' });
    }

    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
    const exporter = new VaultExporter(auth);

    const matter = await exporter.createMatter(`GEM_CO Export ${new Date().toISOString()}`);
    const exportData = await exporter.createExport(matter.matterId, user_emails);

    const { msEmail } = getWorkspaceContext(req);
    activeExport = {
      matterId: matter.matterId,
      exportId: exportData.id,
      status: 'IN_PROGRESS',
      userEmails: user_emails,
      exporter,
      appUserId,
      googleEmail,
      msEmail,
    };

    // Persist to vaultExports
    await db().collection('vaultExports').updateOne(
      { appUserId, googleEmail, exportId: exportData.id },
      { $set: { appUserId, googleEmail, matterId: matter.matterId, userEmails: user_emails, status: 'IN_PROGRESS', requestedAt: new Date() } },
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

      // Save to uploads collection so it appears in Previous Uploads list
      const uploadId = path.basename(destDir);
      const usersArr = users.map(u => ({ email: u.email, displayName: u.displayName, conversationCount: u.conversationCount }));
      const uploadDoc = {
        _id: uploadId,
        originalName: `vault_export_${new Date().toISOString().slice(0,10)}.zip`,
        uploadTime: new Date(),
        extractPath: destDir,
        totalUsers: users.length,
        totalConversations: users.reduce((s, u) => s + u.conversationCount, 0),
        users: usersArr,
        appUserId: activeExport.appUserId,
        googleEmail: activeExport.googleEmail,
        msEmail: activeExport.msEmail,
      };
      await db().collection('uploads').updateOne({ _id: uploadId }, { $set: uploadDoc }, { upsert: true });
      dbLog.info(`uploads.upsert (vault export) — ${uploadDoc.totalUsers} users`);

      activeExport = null;

      return res.json({
        status,
        id: uploadId,
        original_name: uploadDoc.originalName,
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
app.get('/api/ms/users', requireMsAuth, async (req, res) => {
  try {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    if (!isAuthenticated(appUserId)) return res.status(401).json({ error: 'Not authenticated' });
    const token = await getValidToken(appUserId);
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
            filter: { email: u.mail || u.userPrincipalName, source: 'microsoft', appUserId, googleEmail, msEmail },
            update: { $set: { appUserId, googleEmail, msEmail, displayName: u.displayName, tenantId: req.query.tenant_id || null, discoveredAt: new Date() } },
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
app.post('/api/upload', requireGoogleAuth, upload.single('vault_zip'), async (req, res) => {
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

    const { appUserId: _appUserId, googleEmail: _googleEmail, msEmail: _msEmail } = getWorkspaceContext(req);
    const uploadDoc = {
      _id: req.file.filename,
      originalName: req.file.originalname || 'vault_export.zip',
      uploadTime: new Date(),
      extractPath: extractTo,
      totalUsers: users.length,
      totalConversations: users.reduce((s, u) => s + u.conversationCount, 0),
      users: usersArr,
      appUserId: _appUserId,
      googleEmail: _googleEmail,
      msEmail: _msEmail,
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
  const { appUserId, googleEmail } = getWorkspaceContext(req);
  if (!appUserId || !googleEmail) return res.json({ uploads: [] });
  // Show all uploads for this user+google account regardless of MS connection
  const uploads = await db().collection('uploads').find({ appUserId, $or: [{ googleEmail }, { googleEmail: { $exists: false } }] }).sort({ uploadTime: -1 }).toArray();
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
  const wsFilter = getWorkspaceFilter(req);
  if (!wsFilter) return res.json([]);
  // Match current workspace OR legacy reports (no googleEmail/msEmail fields) for this appUser
  const reports = await db().collection('reportsWorkspace')
    .find({ $or: [wsFilter, { appUserId: wsFilter.appUserId, googleEmail: { $exists: false } }] }, { projection: { report: 0 } })
    .sort({ startTime: -1 })
    .toArray();
  res.json(reports);
});

// Aggregate stats across all completed batches
app.get('/api/reports/aggregate', async (req, res) => {
  const wsFilter = getWorkspaceFilter(req);
  if (!wsFilter) return res.json({ totalBatches: 0, totalUsers: 0, totalPages: 0, totalErrors: 0, liveBatches: 0 });
  const pipeline = [
    { $match: { status: 'completed', $or: [wsFilter, { appUserId: wsFilter.appUserId, googleEmail: { $exists: false } }] } },
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
  const isC2G = doc.direction === 'c2g';
  const customerName = doc.customerName || 'Gemini';
  const destFor = (email, destEmail) => isC2G ? (destEmail || '') : `${email}/OneDrive/Notebooks/${customerName}/${customerName} Conversations`;
  const header = isC2G ? 'Source Email,Destination Email,Status,Files Uploaded,Conversations,Errors,Error Message' : 'Email,Destination Path,Status,Pages Created,Conversations,Errors,Error Message';
  const rows = [header];
  users.forEach(u => {
    const dest = destFor(u.email, u.destEmail);
    if (u.errors?.length > 0) {
      u.errors.forEach(e => rows.push([u.email, dest, u.status, u.pages_created, u.conversations_processed, u.error_count, e.error_message || ''].map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',')));
    } else {
      rows.push([u.email, dest, u.status, u.pages_created, u.conversations_processed, u.error_count, ''].map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(','));
    }
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="batch_${req.params.id}.csv"`);
  res.send(rows.join('\n'));
});

// Get categorized errors for a batch — used by smart retry panel
app.get('/api/reports/:id/errors', async (req, res) => {
  const doc = await db().collection('reportsWorkspace').findOne({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Batch not found' });
  const errors = [];
  for (const u of doc.report?.users || []) {
    for (const e of u.errors || []) {
      errors.push({ email: u.email, conversation: e.conversation, error: e.error_message || e.error || '' });
    }
  }
  res.json({ errors });
});

// Get a specific batch report — JSON inline; ?download=true forces download, ?summary=true returns lightweight metadata
app.get('/api/reports/:id', async (req, res) => {
  const { id } = req.params;
  // Legacy alias
  if (id === 'migration') {
    const latest = await db().collection('reportsWorkspace').findOne({}, { sort: { startTime: -1 } });
    if (!latest) return res.status(404).json({ error: 'No report yet' });
    const payload = latest.report || {};
    return res.json({ ...payload, customerName: latest.customerName, tenantId: latest.tenantId, batchId: latest._id });
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
  // Merge outer metadata (customerName, tenantId, batchId) into the report payload
  // so the client has access to the File Name used for this batch.
  const payload = doc.report || {};
  res.json({ ...payload, customerName: doc.customerName, tenantId: doc.tenantId, batchId: doc._id });
});

// ─── User Mappings ───────────────────────────────────────────────────────────
app.get('/api/user-mappings/latest', async (req, res) => {
  const wsFilter = getWorkspaceFilter(req);
  if (!wsFilter) return res.json(null);
  const doc = await db().collection('userMappings').findOne({ batchId: 'latest', ...wsFilter });
  res.json(doc || null);
});

app.post('/api/user-mappings', async (req, res) => {
  const { customerName, mappings, selectedUsers } = req.body;
  const { googleEmail, msEmail } = getWorkspaceContext(req);
  await db().collection('userMappings').updateOne(
    { batchId: 'latest', googleEmail, msEmail },
    { $set: { customerName, mappings, selectedUsers, googleEmail, msEmail, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  dbLog.info(`userMappings.upsert — ${Object.keys(mappings || {}).length} mappings, ${(selectedUsers || []).length} selected`);
  res.json({ ok: true });
});

// ─── Migration Logs (historical) ────────────────────────────────────────────
app.get('/api/migration-logs/:batchId', async (req, res) => {
  const wsFilter = getWorkspaceFilter(req);
  const filter = { batchId: req.params.batchId };
  if (wsFilter) filter.appUserId = wsFilter.appUserId;
  const logs = await db().collection('migrationLogs')
    .find(filter)
    .sort({ ts: 1 })
    .toArray();
  res.json(logs);
});

// ════════════════════════════════════════════════════════════════════
// ─── COPILOT → GEMINI (C2G) ROUTES ──────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// C2G SSE log emitter (separate from G→C)
const c2gLogEmitter = new EventEmitter();
c2gLogEmitter.setMaxListeners(50);

function c2gLog(type, message) {
  c2gLogEmitter.emit('log', { type, message, ts: new Date().toISOString() });
}

// GET /api/c2g/migrate-log — SSE stream for C2G migration
app.get('/api/c2g/migrate-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const handler = d => send(d);
  c2gLogEmitter.on('log', handler);
  req.on('close', () => c2gLogEmitter.off('log', handler));
});

// POST /api/c2g/migrate — run Copilot→Gemini migration
app.post('/api/c2g/migrate', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    const { pairs, folderName, dryRun, fromDate, toDate } = req.body;
    if (!pairs?.length) return res.status(400).json({ error: 'No user pairs provided' });
    const isDryRun = dryRun === true;
    const c2gFolderName = folderName || 'CopilotChats';

    res.json({ started: true });

    // Run migration async — stream progress via SSE
    const batchId = `c2g_${Date.now()}`;
    const { googleEmail, msEmail } = getWorkspaceContext(req);
    const startTime = new Date();

    setImmediate(async () => {
      let files = 0, errors = 0;

      // Create report doc in DB (same schema as G2C)
      try {
        await db().collection('reportsWorkspace').updateOne(
          { _id: batchId },
          { $set: { customerName: c2gFolderName, tenantId: process.env.SOURCE_AZURE_TENANT_ID || '', startTime, status: 'running', dryRun: isDryRun, direction: 'c2g', appUserId, googleEmail, msEmail } },
          { upsert: true }
        );
        dbLog.info(`reportsWorkspace.insert — C2G batch ${batchId} status=running (dryRun=${isDryRun})`);
      } catch (dbErr) { console.error('[C2G] DB insert error:', dbErr.message); }

      try {
        let migModule, svcModule;
        try {
          migModule = await import('./src/modules/c2g/migration/migrate.js');
          svcModule = await import('./src/modules/c2g/copilotService.js');
        } catch(importErr) {
          console.error('[C2G] Import error:', importErr);
          c2gLog('error', `Failed to load C2G module: ${importErr.message}`);
          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: importErr.message } }).catch(() => {});
          c2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
          return;
        }
        const { runMigration: runC2G } = migModule;
        const { createSourceGraphClient, listDirectoryUsers } = svcModule;

        if (currentTenantId) {
          if (!process.env.SOURCE_AZURE_TENANT_ID) process.env.SOURCE_AZURE_TENANT_ID = currentTenantId;
          if (!process.env.AZURE_TENANT_ID) process.env.AZURE_TENANT_ID = currentTenantId;
        }

        c2gLog('info', 'Resolving user IDs from Microsoft directory...');
        let allMsUsers = [];
        try {
          const { accessToken } = await createSourceGraphClient();
          allMsUsers = await listDirectoryUsers(accessToken);
        } catch (appTokenErr) {
          const msToken = isAuthenticated(appUserId) ? await getValidToken(appUserId).catch(() => null) : null;
          if (msToken) {
            let url = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999';
            while (url) {
              const r = await fetch(url, { headers: { Authorization: `Bearer ${msToken}` } });
              const d = await r.json();
              allMsUsers = allMsUsers.concat(d.value || []);
              url = d['@odata.nextLink'] || null;
            }
          } else {
            c2gLog('error', `Cannot fetch MS users: ${appTokenErr.message}. Connect Microsoft account first.`);
            await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: appTokenErr.message } }).catch(() => {});
            c2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }
        }

        c2gLog('info', `Found ${allMsUsers.length} users in directory`);

        const userMap = {};
        allMsUsers.forEach(u => { userMap[(u.mail || u.userPrincipalName || '').toLowerCase()] = u; });

        const migPairs = pairs.map(p => {
          const u = userMap[p.sourceEmail.toLowerCase()];
          return { sourceUserId: u?.id, sourceDisplayName: u?.displayName || p.sourceEmail, destUserEmail: p.destEmail, sourceEmail: p.sourceEmail };
        }).filter(p => p.sourceUserId);

        if (!migPairs.length) {
          c2gLog('error', 'No valid user pairs found. Check that the M365 emails exist in the tenant.');
          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: 'No valid user pairs', totalUsers: 0 } }).catch(() => {});
          c2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
          return;
        }

        // Update report with user count
        await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { totalUsers: migPairs.length } }).catch(() => {});

        c2gLog('info', `Starting C2G ${isDryRun ? 'dry run' : 'migration'} for ${migPairs.length} user pair(s)...`);
        if (isDryRun) {
          // Dry run: fetch interactions count but don't upload
          const { getCopilotInteractionsForUser } = svcModule;
          const reportUsers = [];
          for (const p of migPairs) {
            try {
              const { accessToken: at } = await createSourceGraphClient();
              const interactions = await getCopilotInteractionsForUser(at, p.sourceUserId, {});
              const sessions = new Map();
              for (const item of interactions) { const sid = item.sessionId || 'unknown'; if (!sessions.has(sid)) sessions.set(sid, []); sessions.get(sid).push(item); }
              c2gLog('info', `${p.sourceDisplayName} → ${p.destUserEmail}: ${interactions.length} interactions, ${sessions.size} conversations`);
              reportUsers.push({ email: p.sourceEmail, destEmail: p.destUserEmail, displayName: p.sourceDisplayName, status: 'success', pages_created: sessions.size, conversations_processed: sessions.size, error_count: 0, errors: [] });
              files += sessions.size;
            } catch (e) {
              c2gLog('warn', `${p.sourceDisplayName}: ${e.message}`);
              reportUsers.push({ email: p.sourceEmail, destEmail: p.destUserEmail, displayName: p.sourceDisplayName, status: 'failed', pages_created: 0, conversations_processed: 0, error_count: 1, errors: [{ error_message: e.message }] });
              errors++;
            }
          }
          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: {
            status: 'completed', endTime: new Date(), dryRun: true, totalUsers: migPairs.length,
            migratedConversations: files, migratedUsers: reportUsers.filter(u => u.status === 'success').length,
            failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors,
            report: { summary: { total_users: migPairs.length, total_pages_created: files, total_errors: errors }, users: reportUsers }
          } }).catch(() => {});
          c2gLog('done', JSON.stringify({ files, errors, users: migPairs.length, batchId }));
          return;
        }

        // Pass folder name and date filters to migrator
        const migOpts = { folderName: c2gFolderName };
        if (fromDate) migOpts.fromDate = fromDate;
        if (toDate) migOpts.toDate = toDate;
        const { migrateUserPair } = migModule;
        const results = [];
        const reportUsers = [];

        c2gLog('info', `Starting C2G migration for ${migPairs.length} user pair(s)...`);
        c2gLog('total', JSON.stringify({ total: migPairs.length }));

        for (const pair of migPairs) {
          c2gLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destUserEmail}`);

          const r = await migrateUserPair(
            { sourceUserId: pair.sourceUserId, sourceDisplayName: pair.sourceDisplayName, destUserEmail: pair.destUserEmail },
            migOpts
          );
          results.push(r);

          const userReport = {
            email: r.sourceEmail || pair.sourceEmail || pair.sourceDisplayName,
            destEmail: r.destUserEmail,
            displayName: r.sourceDisplayName,
            status: r.errors?.length ? (r.filesUploaded > 0 ? 'partial' : 'failed') : 'success',
            pages_created: r.filesUploaded || 0,
            conversations_processed: r.conversationsCount || 0,
            error_count: (r.errors || []).length,
            errors: (r.errors || []).map(e => ({ error_message: e })),
            files: r.files || [],
          };
          reportUsers.push(userReport);

          if (r.errors?.length) {
            console.error(`[C2G] ${r.sourceDisplayName} errors:`, r.errors.join(' | '));
            r.errors.forEach(err => {
              let friendly = err;
              if (err.includes('invalid_grant') || err.includes('Invalid email or User ID')) {
                friendly = `Google rejected destination "${r.destUserEmail}". Verify the email exists in Google Workspace and the service account has Domain-Wide Delegation.`;
              } else if (err.includes('Service account key file not found')) {
                friendly = `Service account JSON file is missing. Check GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env.`;
              } else if (err.includes('Copilot license')) {
                friendly = `${r.sourceDisplayName} does not have a Microsoft 365 Copilot license assigned.`;
              } else if (err.includes('No Copilot conversations')) {
                friendly = `${r.sourceDisplayName} has no Copilot chat history to migrate.`;
              }
              c2gLog('warn', friendly);
            });
          }
          files += r.filesUploaded || 0;
          errors += (r.errors || []).length;
          c2gLog(r.errors?.length ? 'warn' : 'success', `${r.sourceDisplayName} → ${r.destUserEmail}: ${r.filesUploaded || 0} files uploaded, ${(r.errors||[]).length} error(s)`);
          c2gLog('progress', JSON.stringify({ files, errors, users: results.length, total: migPairs.length }));
        }

        // Save completed report to DB
        const reportUpdate = {
          status: errors > 0 && files === 0 ? 'failed' : 'completed',
          endTime: new Date(),
          totalUsers: migPairs.length,
          migratedConversations: files,
          migratedUsers: reportUsers.filter(u => u.status === 'success' || u.status === 'partial').length,
          failedUsers: reportUsers.filter(u => u.status === 'failed').length,
          totalErrors: errors,
          report: {
            summary: { total_users: migPairs.length, total_pages_created: files, total_errors: errors, total_conversations: reportUsers.reduce((s, u) => s + u.conversations_processed, 0) },
            users: reportUsers,
          },
        };
        await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: reportUpdate }).catch(() => {});
        dbLog.info(`reportsWorkspace.update — C2G batch ${batchId} status=${reportUpdate.status} (${files} files, ${migPairs.length} users)`);

        c2gLog('done', JSON.stringify({ files, errors, users: migPairs.length, batchId }));
      } catch (e) {
        console.error('[C2G] Unhandled error:', e);
        c2gLog('error', e.message || String(e));
        await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: e.message } }).catch(() => {});
        c2gLog('done', JSON.stringify({ files, errors, users: 0, batchId }));
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE — live log stream ────────────────────────────────────────────────────
app.get('/api/migration-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering

  const appUserId = req.session?.appUser?._id?.toString() || null;

  // Replay buffered logs for THIS user only
  const userBuffer = logBuffers.get(appUserId) || [];
  for (const entry of userBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  if (typeof res.flush === 'function') res.flush();

  // Only forward live logs that belong to this user
  const onLog = (data) => {
    if (data._appUserId === appUserId || !data._appUserId) {
      const { _appUserId, ...clean } = data;
      res.write(`data: ${JSON.stringify(clean)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };
  migrationEvents.on('log', onLog);
  req.on('close', () => migrationEvents.off('log', onLog));
});

let currentBatchId = null;
let _currentAppUserId = null;

function emit(type, message, extra = {}) {
  const entry = { type, message, ts: new Date().toISOString(), ...extra };
  // Buffer per user
  if (!logBuffers.has(_currentAppUserId)) logBuffers.set(_currentAppUserId, []);
  logBuffers.get(_currentAppUserId).push(entry);
  // Emit with appUserId tag for SSE filtering
  migrationEvents.emit('log', { ...entry, _appUserId: _currentAppUserId });
  // Persist to MongoDB (fire-and-forget)
  if (currentBatchId) {
    db().collection('migrationLogs').insertOne({
      batchId: currentBatchId, appUserId: _currentAppUserId, type, message, ts: new Date(), extra
    }).catch(() => {});
  }
}

// ─── Start Migration ──────────────────────────────────────────────────────────
app.post('/api/migrate', requireWorkspace, async (req, res) => {
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

  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  if (!dry_run && !isAuthenticated(appUserId)) {
    return res.status(401).json({ error: 'Admin not signed in. Click "Sign in with Microsoft" first.' });
  }

  const batch_id = Date.now().toString();
  res.json({ started: true, batch_id });
  runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId, googleEmail, msEmail });
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

async function runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId, googleEmail, msEmail }) {
  logBuffers.set(appUserId, []); // clear previous run's logs for this user
  const batchId = batch_id || Date.now().toString();
  currentBatchId = batchId;
  _currentAppUserId = appUserId;
  const startTime = new Date();

  // Save user mappings snapshot for this batch
  await db().collection('userMappings').updateOne(
    { batchId },
    { $set: { customerName: customer_name, mappings: user_mappings, createdAt: startTime, appUserId, googleEmail, msEmail } },
    { upsert: true }
  );
  dbLog.info(`userMappings.upsert — batch ${batchId} (${Object.keys(user_mappings).length} mappings)`);

  // Create reportsWorkspace doc (include uploadId + appUserId for per-user filtering)
  await db().collection('reportsWorkspace').updateOne(
    { _id: batchId },
    { $set: { customerName: customer_name, tenantId: tenant_id, startTime, status: 'running', dryRun: dry_run, uploadId: upload_id, appUserId, googleEmail, msEmail } },
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
      _currentAppUserId = null;
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
    const creator = new PagesCreator(tenant_id, customer_name, appUserId);
    const checkpoint = new CheckpointManager(batchId);

    // Live progress counters — written to DB after each user
    let progressUsers = 0, progressPages = 0, progressErrors = 0;

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

        // Drive file resolution: try FileCorrelator (audit log) first, fall back to DriveFileMatcher
        let googleClient = null;
        let fileCorrelator = null;
        let driveMatcher = null;
        try {
          googleClient = getGoogleOAuth2Client(appUserId);
          fileCorrelator = new FileCorrelator(googleClient, googleEmail); // resolution only — no upload
          driveMatcher = new DriveFileMatcher(googleClient, googleEmail, appUserId);
          emit('info', `  Drive file resolution enabled for ${googleEmail}`);
        } catch (_) {
          emit('warn', `  Drive file resolution skipped for ${googleEmail} — Google not authenticated`);
        }

        // Pre-enrich all conversations via audit log before the per-conversation loop
        let enrichedConversations = conversations;
        if (fileCorrelator) {
          try {
            enrichedConversations = await fileCorrelator.enrichConversations(conversations);
            const enrichedCount = enrichedConversations.filter(
              c => c.turns?.some(t => t.driveFiles?.length > 0)
            ).length;
            if (enrichedCount > 0) {
              emit('info', `  Audit log enriched ${enrichedCount} conversation(s) for ${googleEmail}`);
            }
          } catch (err) {
            emit('warn', `  Audit log enrichment failed for ${googleEmail}: ${err.message} — file correlation skipped`);
            enrichedConversations = conversations;
          }
        }

        for (const conv of enrichedConversations) {
          try {
            let convWithResponses;
            if (skip_ai_response) {
              convWithResponses = conv;
            } else {
              convWithResponses = await generator.generate(conv, skip_followups);
            }

            // Resolve Drive files for turns that reference uploaded files
            if (driveMatcher) {
              let totalDriveFiles = 0;
              // Deduplicate uploads per conversation: same driveFileId → upload once, reuse URL
              const uploadCache = new Map(); // driveFileId → oneDriveUrl or error
              const resolvedTurns = await Promise.all(
                (convWithResponses.turns || []).map(async (turn) => {
                  if (!turn.hasFileRef) return turn;

                  // FileCorrelator resolved files — upload now with fresh token
                  if (turn.driveFiles && turn.driveFiles.length > 0) {
                    const uploaded = await Promise.all(turn.driveFiles.map(async (f) => {
                      const { _meta, ...rest } = f;
                      // Reuse cached result — store the Promise immediately so concurrent turns
                      // referencing the same file wait on a single upload instead of racing
                      if (uploadCache.has(f.driveFileId)) {
                        const cached = await uploadCache.get(f.driveFileId);
                        return { ...rest, ...(typeof cached === 'string' ? { oneDriveUrl: cached } : { oneDriveUrl: null, uploadError: cached?.error }) };
                      }
                      const uploadPromise = driveMatcher.uploadToOneDrive(f._meta, m365Email);
                      uploadCache.set(f.driveFileId, uploadPromise);
                      const result = await uploadPromise;
                      uploadCache.set(f.driveFileId, result);
                      if (result && typeof result === 'string') {
                        totalDriveFiles++;
                        emit('success', `    Drive file migrated: "${f.fileName}" → OneDrive`);
                        return { ...rest, oneDriveUrl: result };
                      } else {
                        emit('warn', `    Drive file found but upload failed: "${f.fileName}" — ${result?.error || 'unknown'}`);
                        return { ...rest, oneDriveUrl: null, uploadError: result?.error };
                      }
                    }));
                    return { ...turn, driveFiles: uploaded };
                  }

                  // No files resolved from audit log for this turn — skip
                  return turn;
                })
              );
              if (totalDriveFiles > 0) {
                emit('info', `  ${totalDriveFiles} Drive file(s) resolved for "${conv.title?.slice(0, 50)}"`);
              }
              convWithResponses = { ...convWithResponses, turns: resolvedTurns };
            }

            await creator.createPage(m365Email, convWithResponses, visualReports[googleEmail] || []);
            pagesCreated++;
            emit('success', `  Page created: ${conv.title?.slice(0, 60)}`);
          } catch (err) {
            errors.push({ conversation: conv.title, error: err.message });
            dbLog.error(`Page creation failed for "${conv.title}" → ${err.message}`);
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
        progressErrors++;
      } finally {
        progressUsers++;
        progressPages += pagesCreated;
        conversations = null;
        // Write live progress to DB so Reports panel can poll it
        db().collection('reportsWorkspace').updateOne(
          { _id: batchId },
          { $set: { progressUsers, progressPages, progressErrors, totalUsers: users.length } }
        ).catch(() => {});
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
      flaggedAssets: fullReport.summary?.total_flagged || Object.values(visualReports || {}).reduce((s, v) => s + (v?.length || 0), 0),
      report: fullReport,
    };

    // Auto-deploy Copilot Declarative Agent after migration
    if (!dry_run) {
      emit('info', '━━━ Deploying Copilot Agent ━━━');
      try {
        const deployer = new AgentDeployer(customer_name, tenant_id, {}, appUserId);
        const appInfo = await deployer.deployAgent();
        if (appInfo.alreadyExisted) {
          emit('info', `Agent "Gemini Conversation Agent" already exists in catalog — skipping publish`);
        } else {
          emit('success', `Agent "Gemini Conversation Agent" published to Teams catalog (id: ${appInfo.id})`);
        }
        emit('info', appInfo.installInstructions);
        // Persist agent deployment
        reportUpdate.agentDeployment = { catalogId: appInfo.id, alreadyExisted: appInfo.alreadyExisted };
        await db().collection('agentDeployments').updateOne(
          { appUserId, msEmail, agentName: 'Gemini Conversation Agent' },
          { $set: { batchId, catalogId: appInfo.id, deployedAt: new Date() } },
          { upsert: true }
        );
        dbLog.info(`agentDeployments.upsert — "Gemini Conversation Agent" (catalog id: ${appInfo.id})`);
      } catch (err) {
        emit('warn', `Agent deployment failed (can be done manually): ${err.message}`);
      }
    }

    await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: reportUpdate });
    dbLog.info(`reportsWorkspace.update — batch ${batchId} status=completed (${reportUpdate.migratedConversations} pages, ${reportUpdate.totalUsers} users)`);
    emit('done', `━━━ Migration complete! Reports saved. ━━━`, { batch_id: batchId });
    currentBatchId = null;
    _currentAppUserId = null;
  } catch (err) {
    emit('error', `Migration failed: ${err.message}`);
    await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: err.message } }).catch(() => {});
    dbLog.info(`reportsWorkspace.update — batch ${batchId} status=failed`);
    currentBatchId = null;
    _currentAppUserId = null;
  }
}

// ─── Retry Failed Conversations ───────────────────────────────────────────────
app.post('/api/migrate/retry', requireWorkspace, async (req, res) => {
  const { batchId, customer_name } = req.body;
  if (!batchId) return res.status(400).json({ error: 'batchId required' });
  const { appUserId } = getWorkspaceContext(req);
  if (!isAuthenticated(appUserId)) return res.status(401).json({ error: 'Not signed in. Click "Sign in with Microsoft" first.' });

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

  // Allow caller to override the customer_name (file path) for path-fix retries
  const effectiveCustomerName = customer_name || batchDoc.customerName;

  const retryBatchId = `${batchId}_retry_${Date.now()}`;
  res.json({ started: true, batch_id: retryBatchId, targets: retryTargets });

  runRetry({
    batchId,
    retryBatchId,
    extractPath: uploadDoc?.extractPath,
    tenantId: batchDoc.tenantId,
    customerName: effectiveCustomerName,
    userMappings: mappingDoc?.mappings || {},
    retryTargets,
    appUserId,
  });
});

async function runRetry({ batchId, retryBatchId, extractPath, tenantId, customerName, userMappings, retryTargets, appUserId }) {
  logBuffers.set(appUserId, []);
  currentBatchId = retryBatchId;
  _currentAppUserId = appUserId;

  const totalFailed = Object.values(retryTargets).flat().length;
  emit('info', `━━━ Retrying ${totalFailed} failed conversation(s) ━━━`);

  const reader = new VaultReader(extractPath);
  const generator = new ResponseGenerator();
  const creator = new PagesCreator(tenantId, customerName, appUserId);
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
  _currentAppUserId = null;
}

// ─── Migration Agent Chat ─────────────────────────────────────────────────────
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate_to_step',
      description: 'Navigate the user to a specific migration step in the UI',
      parameters: {
        type: 'object',
        properties: {
          step_index: { type: 'number', description: '0=Connect Clouds, 1=Import Data, 2=Map Users, 3=Options, 4=Migrate, 5=Complete' },
          reason: { type: 'string', description: 'Brief reason for navigating' }
        },
        required: ['step_index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_migration',
      description: 'Start a migration run. Only call when user explicitly asks to start or run migration.',
      parameters: {
        type: 'object',
        properties: { dry_run: { type: 'boolean', description: 'true = preview only (recommended first), false = live migration' } },
        required: ['dry_run']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed',
      description: 'Retry failed migration items from the last batch',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_reports',
      description: 'Open the migration reports panel',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_mapping',
      description: 'Open the user mapping grid in the left panel so user can review/edit Google-to-M365 email mappings',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_migration_status',
      description: 'Get current migration progress, stats, and state details',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'explain_log',
      description: 'Explain what a migration log line means and suggest action',
      parameters: {
        type: 'object',
        properties: { log_line: { type: 'string', description: 'The exact log message text' } },
        required: ['log_line']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_status_card',
      description: 'Display a visual status card with migration stats. Use when summarizing migration results or answering questions about counts.',
      parameters: {
        type: 'object',
        properties: {
          users:  { type: 'number', description: 'Users processed' },
          files:  { type: 'number', description: 'Files/pages migrated' },
          errors: { type: 'number', description: 'Error count' },
          label:  { type: 'string', description: 'Card title, e.g. "Migration Results"' }
        },
        required: ['users', 'files', 'errors']
      }
    }
  }
];

const STEP_NAMES = ['Connect Clouds', 'Import Data', 'Map Users', 'Options', 'Migration in Progress', 'Migration Complete'];

function getContextualReplies({migDir,migDone,live,googleAuthed,msAuthed,uploadData,mappings_count,stats,lastRunWasDry}={}) {
  if(!googleAuthed||!msAuthed) return ['Connect Google Workspace','Connect Microsoft 365','How does this work?'];
  if(!migDir) return ['Migrate Gemini → Copilot','Migrate Copilot → Gemini','What\'s the difference?'];
  if(migDir==='gemini-copilot'){
    if(!uploadData) return ['Upload Vault ZIP','Export from Google Drive','What format do I need?'];
    if(!mappings_count) return ['Auto-map users','Map manually','What is user mapping?'];
    if(!migDone&&!live) return ['Start dry run','Start live migration','What does dry run do?'];
    if(live) return ['Check migration status','What\'s happening?'];
    if(migDone&&(stats?.errors||0)>0) return ['Retry failed','Download report','What failed and why?'];
    if(migDone) return ['Download report','Start another','Change direction'];
  }
  if(migDir==='copilot-gemini'){
    if(!mappings_count) return ['Map C2G users','How does C2G migration work?'];
    if(!migDone&&!live) return ['Start dry run','Start live migration'];
    if(live) return ['Check migration status'];
    if(migDone&&(stats?.errors||0)>0) return ['What errors occurred?','Download report'];
    if(migDone) return ['Download report','Start another','Change direction'];
  }
  return ['What can you do?','Show migration status'];
}

async function callAI(messages, tools) {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const openaiKey = process.env.OPENAI_API_KEY;

  if (azureEndpoint && azureKey) {
    const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    const body = { messages, max_tokens: 900, temperature: 0.4 };
    if (tools) body.tools = tools;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': azureKey },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Azure OpenAI error ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  if (openaiKey) {
    const body = { model: 'gpt-4o', messages, max_tokens: 700, temperature: 0.35 };
    if (tools) body.tools = tools;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
    return await r.json();
  }

  throw new Error('No AI provider configured. Set AZURE_OPENAI_API_KEY or OPENAI_API_KEY in .env');
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, history = [], migrationState = {}, migrationLogs = [], isSystemTrigger = false } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const {
    step = 0, migDir = null, live = false, migDone = false, stats = {}, lastRunWasDry = false,
    uploadData = null, googleAuthed = false, msAuthed = false,
    mappings_count = 0, selected_users_count = 0, options = {}
  } = migrationState;

  const logsSection = migrationLogs.length > 0
    ? `\nRecent migration log (${migrationLogs.length} entries):\n${migrationLogs.join('\n')}\n`
    : '';

  const systemPrompt = `You are the CloudFuze Migration Agent — a knowledgeable, conversational co-pilot for migrating conversations between Google Workspace and Microsoft 365 in both directions.

Current migration state:
- Direction: ${migDir === 'gemini-copilot' ? 'Google Gemini → Microsoft Copilot' : migDir === 'copilot-gemini' ? 'Microsoft Copilot → Google Drive' : 'not selected'}
- Step: ${step} — ${STEP_NAMES[step] || 'Unknown'}
- Google Workspace connected: ${googleAuthed}
- Microsoft 365 connected: ${msAuthed}
- Vault data loaded: ${uploadData ? `yes (${uploadData.total_users} users, ${uploadData.total_conversations || '?'} conversations)` : 'no'}
- User mappings configured: ${mappings_count} (${selected_users_count} selected)
- Dry run mode: ${options.dryRun ? 'yes' : 'no'}
- Migration running: ${live}
- Migration done: ${migDone}
- Last run: ${lastRunWasDry ? 'dry run' : 'live'}
- Stats: ${stats.users || 0} users · ${stats.pages || 0} pages/files migrated · ${stats.errors || 0} errors
${logsSection}
Use the state and logs above to give specific, relevant answers. When the user asks about progress, results, or errors — answer from the actual data above, citing real numbers.

Formatting: use markdown freely — **bold** for key numbers and values, - bullet lists for steps or options, ## headers only for longer structured answers. Match length to need.

Personality: direct, warm, expert. Like a senior engineer helping a colleague. Never narrate what step the user is on — offer to help them move forward instead. Ask one focused question when you notice something worth exploring.

You CAN take real actions via tools: navigate steps, start migration, retry, show reports, show mapping, show_status_card.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-12),
    { role: 'user', content: message }
  ];

  try {
    let response = await callAI(messages, AGENT_TOOLS);
    let choice = response.choices?.[0];
    let actionToExecute = null;
    let navigateToStep = null;
    let statusCardData = null;

    // Handle tool calls
    if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls) {
      const toolResults = [];
      for (const tc of choice.message.tool_calls) {
        let result = '';
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          switch (tc.function.name) {
            case 'navigate_to_step': {
              const idx = Math.max(0, Math.min(5, args.step_index));
              navigateToStep = idx;
              result = JSON.stringify({ execute: 'navigate', step: idx, name: STEP_NAMES[idx] });
              break;
            }
            case 'start_migration': {
              actionToExecute = args.dry_run ? 'start_migration_dry' : 'start_migration_live';
              result = JSON.stringify({ execute: actionToExecute, dry_run: args.dry_run });
              break;
            }
            case 'retry_failed': {
              actionToExecute = 'retry_failed';
              result = JSON.stringify({ execute: 'retry_failed' });
              break;
            }
            case 'show_reports': {
              actionToExecute = 'show_reports';
              result = JSON.stringify({ execute: 'show_reports' });
              break;
            }
            case 'show_mapping': {
              actionToExecute = 'show_mapping';
              result = JSON.stringify({ execute: 'show_mapping' });
              break;
            }
            case 'get_migration_status': {
              const logSummary = migrationLogs.length > 0 ? ` Recent logs: ${migrationLogs.slice(-20).join(' | ')}` : '';
              result = `Step ${step} (${STEP_NAMES[step]}). Direction: ${migDir||'none'}. Running: ${live}. Done: ${migDone}. Users: ${stats.users || 0}, Pages/Files: ${stats.pages || 0}, Errors: ${stats.errors || 0}.${logSummary}`;
              break;
            }
            case 'explain_log': {
              const line = args.log_line || '';
              const isErr = /error|fail|exception/i.test(line);
              const isWarn = /warn|skip|flag/i.test(line);
              const isSuc = /success|created|complete/i.test(line);
              result = isErr ? `This is an error: the migration engine encountered a problem processing this item. If this repeats, use Retry Failed.`
                : isWarn ? `This is a warning: something was skipped or needs attention but migration continued.`
                : isSuc ? `This is a success message: the item was migrated successfully.`
                : `This is an informational log from the migration engine showing normal progress.`;
              break;
            }
            case 'show_status_card': {
              actionToExecute = actionToExecute || null;
              statusCardData = { users: args.users || 0, files: args.files || 0, errors: args.errors || 0, label: args.label || 'Migration Results' };
              result = `Status card shown: ${args.users||0} users, ${args.files||0} files, ${args.errors||0} errors.`;
              break;
            }
            default:
              result = 'Unknown tool.';
          }
        } catch (e) { result = 'Tool execution error.'; }
        toolResults.push({ tool_call_id: tc.id, role: 'tool', content: result });
      }

      const followUpMessages = [...messages, choice.message, ...toolResults];
      response = await callAI(followUpMessages);
      choice = response.choices?.[0];
    }

    const reply = choice?.message?.content || "I couldn't generate a response. Please try again.";
    const quickReplies = [];

    // Auto-inject widget based on current migration state + agent action
    let widget = null;
    const navStep = navigateToStep !== null ? navigateToStep : step;
    if (!googleAuthed || !msAuthed) {
      widget = { type: 'auth' };
    } else if (navStep === 1 && !uploadData) {
      widget = { type: 'upload' };
    } else if ((navStep === 3 || actionToExecute === 'start_migration_dry' || actionToExecute === 'start_migration_live') && !options.hasFilePath) {
      widget = { type: 'options' };
    }

    const payload = { reply, quickReplies };
    if (actionToExecute) payload.action = actionToExecute;
    if (navigateToStep !== null) payload.navigate = navigateToStep;
    if (widget) payload.widget = widget;
    if (statusCardData) payload.statusCard = statusCardData;

    res.json(payload);
  } catch (err) {
    console.error('[/api/chat]', err.message);
    res.status(500).json({ error: err.message, reply: `I'm having trouble connecting right now. Please try again in a moment.` });
  }
});

// ─── Auth Disconnect endpoints ────────────────────────────────────────────────
app.post('/api/auth/google/disconnect', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearGoogleToken(appUserId);
  delete req.session.googleEmail;
  res.json({ success: true });
});

app.post('/api/auth/ms/disconnect', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearMsToken(appUserId);
  delete req.session.msEmail;
  res.json({ success: true });
});

connectMongo().then(async () => {
  // Connect Mongoose to cogem DB (C2G migration state)
  try {
    const origUri = process.env.MONGO_URI;
    process.env.MONGO_URI = process.env.MONGO_URI_COGEM || origUri;
    const { connectDB } = await import('./src/db/cogemConnection.js');
    await connectDB();
    process.env.MONGO_URI = origUri;
  } catch (e) {
    console.warn('[cogem] Copilot DB connect failed (non-fatal):', e.message);
  }
  await restoreGoogleSessions();
  await restoreMsSessions();
  app.listen(PORT, () => {
    console.log(`\nCloudFuze Migration`);
    console.log(`Open: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
