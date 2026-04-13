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
import { getDriveService, getAdminDirectoryClient, getAdminReportsClient, getVaultAuthClient, validateServiceAccount } from './src/auth/google.js';
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
    const auth = getAdminReportsClient(googleEmail);
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
    const drive = getDriveService(googleEmail);
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
    const { DriveFileMatcher } = await import('./src/modules/driveFileMatcher.js');
    const matcher = new DriveFileMatcher(getDriveService(googleEmail), ownerEmail, appUserId);
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
  const sa = validateServiceAccount();
  res.json({
    authenticated: isGoogleAuthenticated(appUserId),
    serviceAccount: sa.ok,
    serviceAccountError: sa.ok ? undefined : sa.error,
  });
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
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const googleClient = getAdminDirectoryClient(googleEmail);
    const reportsClient = getAdminReportsClient(googleEmail);
    const result = await checkPermissions(googleClient, reportsClient);
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
    const admin = getAdminDirectoryClient(googleEmail);
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
    const auth = getVaultAuthClient(googleEmail);
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
  const wsFilter = getWorkspaceFilter(req);
  if (!wsFilter) return res.json({ uploads: [] });
  // Match current workspace OR legacy uploads (no googleEmail/msEmail fields) for this appUser
  const uploads = await db().collection('uploads').find({ $or: [wsFilter, { appUserId: wsFilter.appUserId, googleEmail: { $exists: false } }] }).sort({ uploadTime: -1 }).toArray();
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

// ─── SSE — live log stream ────────────────────────────────────────────────────
app.get('/api/migration-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const appUserId = req.session?.appUser?._id?.toString() || null;

  // Replay buffered logs for THIS user only
  const userBuffer = logBuffers.get(appUserId) || [];
  for (const entry of userBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // Only forward live logs that belong to this user
  const onLog = (data) => {
    if (data._appUserId === appUserId || !data._appUserId) {
      const { _appUserId, ...clean } = data;
      res.write(`data: ${JSON.stringify(clean)}\n\n`);
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
          googleClient = getAdminReportsClient(googleEmail);
          fileCorrelator = new FileCorrelator(googleClient, googleEmail); // resolution only — no upload
          driveMatcher = new DriveFileMatcher(getDriveService(googleEmail), googleEmail, appUserId);
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
                      // Reuse cached result if same file already uploaded in this conversation
                      if (uploadCache.has(f.driveFileId)) {
                        const cached = uploadCache.get(f.driveFileId);
                        return { ...rest, ...(typeof cached === 'string' ? { oneDriveUrl: cached } : { oneDriveUrl: null, uploadError: cached?.error }) };
                      }
                      const result = await driveMatcher.uploadToOneDrive(f._meta, m365Email);
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
  await restoreGoogleSessions();
  await restoreMsSessions();
  app.listen(PORT, () => {
    console.log(`\nGemini → Copilot Migration UI`);
    console.log(`Open: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
