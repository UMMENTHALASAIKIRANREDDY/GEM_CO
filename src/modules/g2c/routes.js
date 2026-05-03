/**
 * G2C (Gemini → Copilot) routes.
 * All route paths preserved exactly as they were in server.js.
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { EventEmitter } from 'events';
import { google } from 'googleapis';

import { VaultReader } from './vaultReader.js';
import { VaultExporter } from './vaultExporter.js';
import { AssetScanner } from './assetScanner.js';
import { ResponseGenerator } from './responseGenerator.js';
import { PagesCreator } from './pagesCreator.js';
import { DriveFileMatcher } from './driveFileMatcher.js';
import { FileCorrelator } from './fileCorrelator.js';
import { AuditLogClient } from './auditLogClient.js';
import { checkPermissions } from './permissionsChecker.js';
import { ReportWriter } from './reportWriter.js';
import { CheckpointManager } from '../../utils/checkpoint.js';
import { AgentDeployer } from '../../agent/agentDeployer.js';
import { getLogger } from '../../utils/logger.js';
import { runAgentLoop } from '../../agent/agentLoop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Root of the project (3 levels up from src/modules/g2c/)
const ROOT_DIR = path.resolve(__dirname, '../../..');

const dbLog = getLogger('db:ops');

// ─── Agent Chat constants ─────────────────────────────────────────────────────

export function generateSuggestedChips({ step=0, migDir, googleAuthed, msAuthed, live, migDone,
  lastRunWasDry, uploadData, mappings_count, c2g_mappings_count, cl2g_mappings_count,
  c2g_done, cl2g_done, c2g_live, cl2g_live }) {
  const isRunning = live || c2g_live || cl2g_live;
  const isDone = migDone || c2g_done || cl2g_done;
  const effectiveMappings = migDir === 'copilot-gemini' ? c2g_mappings_count
    : migDir === 'claude-gemini' ? cl2g_mappings_count : mappings_count;

  // Step 0: Connect Clouds
  if (step === 0 || !migDir) {
    if (!googleAuthed && !msAuthed) return ['Connect Google', 'Connect Microsoft 365', 'What do I need?'];
    if (!googleAuthed) return ['Connect Google Workspace', 'What do I need?'];
    if (!msAuthed) return ['Connect Microsoft 365', 'Skip — do Claude→Gemini'];
    return ['Choose direction', "What's the difference?"];
  }
  // Step 1: Direction
  if (step === 1) {
    const opts = ['Claude → Gemini'];
    if (googleAuthed && msAuthed) opts.unshift('Gemini → Copilot', 'Copilot → Gemini');
    opts.push("What's the difference?");
    return opts;
  }
  // Step 2: Upload / Map (depends on direction)
  if (step === 2) {
    if (migDir === 'gemini-copilot') return ['How do I export from Google?', "What's in the ZIP?", 'Select users instead'];
    if (migDir === 'claude-gemini') return ['How do I export from Claude?', "What's in the ZIP?"];
    if (migDir === 'copilot-gemini') return effectiveMappings > 0
      ? ['Auto-map users', 'What is auto-map?', 'How mapping works']
      : ['Auto-map users', 'What is auto-map?'];
  }
  // Step 3: Map Users (G2C / CL2G)
  if (step === 3 && migDir !== 'copilot-gemini') {
    if (effectiveMappings === 0) return ['Auto-map users', 'What is auto-map?', 'Skip unmapped users'];
    return ['Auto-map users', 'All looks good', 'How many are mapped?'];
  }
  // Step 3 C2G / Step 4 G2C+CL2G: Options
  if ((step === 3 && migDir === 'copilot-gemini') || step === 4) {
    if (isRunning) return ['Check status', 'How long will this take?'];
    return ['Start Dry Run', 'What is a dry run?', 'Go straight to live', 'Change folder name'];
  }
  // Running
  if (isRunning) return ['Check status', 'How long will this take?', 'Any errors so far?'];
  // Done
  if (isDone && lastRunWasDry) return ['Go Live now', 'Show me the report', 'What changed?'];
  if (isDone) return ['What do I do next?', 'Download report', 'Start Another'];
  // Step 5+ means migration panel even if migDone not set (e.g. errors stopped it)
  if (step >= 5) return ['Check status', 'Retry failed', 'Show me the report'];
  return ['Check status'];
}

const STEP_NAMES = ['Connect Clouds', 'Import Data', 'Map Users', 'Options', 'Migration in Progress', 'Migration Complete'];

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * @param {{ db: () => import('mongodb').Db, getGoogleOAuth2Client: Function, isAuthenticated: Function, getValidToken: Function, isGoogleAuthenticated: Function }} deps
 */
export function createG2CRouter(deps) {
  const { db, getGoogleOAuth2Client, isAuthenticated, getValidToken, isGoogleAuthenticated } = deps;

  const router = express.Router();

  const uploadsDir = path.join(ROOT_DIR, 'uploads');
  const reportsDir = path.join(ROOT_DIR, 'uploads', 'reports');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  const upload = multer({
    dest: uploadsDir,
    fileFilter: (_req, file, cb) => {
      if (file.originalname.endsWith('.zip')) cb(null, true);
      else cb(new Error('Only ZIP files are accepted'));
    }
  });

  // ── SSE migration log ─────────────────────────────────────────────────────

  const migrationEvents = new EventEmitter();
  const logBuffers = new Map(); // appUserId → log entries array

  let currentBatchId = null;
  let _currentAppUserId = null;

  function emit(type, message, extra = {}) {
    const entry = { type, message, ts: new Date().toISOString(), ...extra };
    if (!logBuffers.has(_currentAppUserId)) logBuffers.set(_currentAppUserId, []);
    logBuffers.get(_currentAppUserId).push(entry);
    migrationEvents.emit('log', { ...entry, _appUserId: _currentAppUserId });
    if (currentBatchId) {
      db().collection('migrationLogs').insertOne({
        batchId: currentBatchId, appUserId: _currentAppUserId, type, message, ts: new Date(), extra
      }).catch(() => {});
    }
  }

  // GET /api/migration-log — SSE stream
  router.get('/migration-log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const appUserId = req.session?.appUser?._id?.toString() || null;
    const userBuffer = logBuffers.get(appUserId) || [];
    for (const entry of userBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    if (typeof res.flush === 'function') res.flush();

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

  // ── Auth middleware helpers ───────────────────────────────────────────────

  function requireGoogleAuth(req, res, next) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    const googleEmail = req.session.googleEmail || null;
    if (!appUserId || !isGoogleAuthenticated(appUserId) || !googleEmail) {
      return res.status(401).json({ error: 'Google account not connected. Please sign in with Google first.' });
    }
    next();
  }

  function requireMsAuth(req, res, next) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    const msEmail = req.session.msEmail || null;
    if (!appUserId || !isAuthenticated(appUserId) || !msEmail) {
      return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
    }
    next();
  }

  function requireWorkspace(req, res, next) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    const googleEmail = req.session.googleEmail || null;
    const msEmail = req.session.msEmail || null;
    if (!appUserId || !isGoogleAuthenticated(appUserId) || !googleEmail) {
      return res.status(401).json({ error: 'Google account not connected. Please sign in with Google first.' });
    }
    if (!isAuthenticated(appUserId) || !msEmail) {
      return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
    }
    next();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getWorkspaceContext(req) {
    const appUserId = req.session.appUser?._id?.toString() || null;
    const googleEmail = req.session.googleEmail || null;
    const msEmail = req.session.msEmail || null;
    return { appUserId, googleEmail, msEmail };
  }

  function getWorkspaceFilter(req) {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    if (!appUserId || !googleEmail || !msEmail) return null;
    return { appUserId, googleEmail, msEmail };
  }

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

  // ── G2C API Routes ────────────────────────────────────────────────────────

  // Diagnose audit
  router.get('/diagnose-audit', async (req, res) => {
    const { email, start, end } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const startTime = start ? new Date(start) : new Date(Date.now() - 3 * 60 * 60 * 1000);
    const endTime   = end   ? new Date(end)   : new Date();
    try {
      const { appUserId } = getWorkspaceContext(req);
      const auth = getGoogleOAuth2Client(appUserId);
      const client = new AuditLogClient(auth);
      const result = await client.testQuery(email, startTime, endTime);
      res.json({ email, startTime, endTime, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Test drive files
  router.get('/test/drive-files', async (req, res) => {
    const { ownerEmail } = req.query;
    try {
      const { appUserId } = getWorkspaceContext(req);
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

  // Test drive transfer
  router.post('/test/drive-transfer', async (req, res) => {
    const { fileId, fileName, mimeType, ownerEmail, targetEmail } = req.body;
    if (!fileId || !fileName || !ownerEmail || !targetEmail) {
      return res.status(400).json({ error: 'fileId, fileName, ownerEmail, targetEmail are required' });
    }
    try {
      const { appUserId } = getWorkspaceContext(req);
      const googleClient = getGoogleOAuth2Client(appUserId);
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

  // Check permissions
  router.get('/check-permissions', requireGoogleAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const googleClient = getGoogleOAuth2Client(appUserId);
      const result = await checkPermissions(googleClient);
      res.json(result);
    } catch (err) {
      res.status(401).json({
        drive: false, reports: false, directory: false,
        errors: { auth: err.message },
      });
    }
  });

  // Google users (Admin SDK)
  router.get('/google/users', requireGoogleAuth, async (req, res) => {
    try {
      const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
      const auth = getGoogleOAuth2Client(appUserId);
      const admin = google.admin({ version: 'directory_v1', auth });
      const users = [];
      let pageToken = undefined;
      do {
        const resp = await admin.users.list({ customer: 'my_customer', maxResults: 200, orderBy: 'email', pageToken });
        if (resp.data.users) {
          users.push(...resp.data.users.map(u => ({ email: u.primaryEmail, name: u.name?.fullName || u.primaryEmail })));
        }
        pageToken = resp.data.nextPageToken;
      } while (pageToken);

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
      try {
        const { appUserId } = getWorkspaceContext(req);
        const cached = await db().collection('cloudMembers').find({ source: 'google', appUserId }).toArray();
        if (cached.length > 0) {
          return res.json({ total: cached.length, users: cached.map(u => ({ email: u.email, name: u.displayName || u.email })), cached: true, warning: err.message });
        }
      } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  });

  // MS users list
  router.get('/ms/users', requireMsAuth, async (req, res) => {
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
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Active export tracking
  let activeExport = null;

  // Google Vault export
  router.post('/google/vault-export', requireGoogleAuth, async (req, res) => {
    try {
      const { user_emails } = req.body;
      if (!user_emails || user_emails.length === 0) return res.status(400).json({ error: 'user_emails array required' });
      const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
      const auth = getGoogleOAuth2Client(appUserId);
      const exporter = new VaultExporter(auth);
      const matter = await exporter.createMatter(`GEM_CO Export ${new Date().toISOString()}`);
      const exportData = await exporter.createExport(matter.matterId, user_emails);
      activeExport = { matterId: matter.matterId, exportId: exportData.id, status: 'IN_PROGRESS', userEmails: user_emails, exporter, appUserId, googleEmail, msEmail };
      await db().collection('vaultExports').updateOne(
        { appUserId, googleEmail, exportId: exportData.id },
        { $set: { appUserId, googleEmail, matterId: matter.matterId, userEmails: user_emails, status: 'IN_PROGRESS', requestedAt: new Date() } },
        { upsert: true }
      );
      dbLog.info(`vaultExports.upsert — export ${exportData.id} (${user_emails.length} users)`);
      res.json({ matter_id: matter.matterId, export_id: exportData.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/google/vault-export/status', async (_req, res) => {
    try {
      if (!activeExport) return res.status(404).json({ error: 'No active export' });
      const { exporter, matterId, exportId } = activeExport;
      const exportRes = await exporter.vault.matters.exports.get({ matterId, exportId });
      const status = exportRes.data.status;
      const stats = exportRes.data.stats || {};
      activeExport.status = status;

      if (status === 'COMPLETED') {
        const destDir = path.join(uploadsDir, `vault_export_${Date.now()}`);
        await exporter.downloadExport(matterId, exportId, destDir);
        await exporter.closeMatter(matterId);
        const zipFiles = fs.readdirSync(destDir).filter(f => f.toLowerCase().endsWith('.zip'));
        for (const zf of zipFiles) {
          try { new AdmZip(path.join(destDir, zf)).extractAllTo(destDir, true); } catch {}
        }
        const xmlFiles = fs.readdirSync(destDir).filter(f => f.toLowerCase().endsWith('.xml'));
        if (xmlFiles.length === 0) return res.json({ status, error: 'Export completed but no XML files found.' });
        const reader = new VaultReader(destDir);
        const users = await reader.discoverUsers();
        await db().collection('vaultExports').updateOne({ exportId }, { $set: { status: 'COMPLETED', completedAt: new Date() } });
        dbLog.info(`vaultExports.update — export ${exportId} COMPLETED`);
        const uploadId = path.basename(destDir);
        const usersArr = users.map(u => ({ email: u.email, displayName: u.displayName, conversationCount: u.conversationCount }));
        const uploadDoc = {
          _id: uploadId, originalName: `vault_export_${new Date().toISOString().slice(0, 10)}.zip`,
          uploadTime: new Date(), extractPath: destDir, totalUsers: users.length,
          totalConversations: users.reduce((s, u) => s + u.conversationCount, 0), users: usersArr,
          appUserId: activeExport.appUserId, googleEmail: activeExport.googleEmail, msEmail: activeExport.msEmail,
        };
        await db().collection('uploads').updateOne({ _id: uploadId }, { $set: uploadDoc }, { upsert: true });
        dbLog.info(`uploads.upsert (vault export) — ${uploadDoc.totalUsers} users`);
        activeExport = null;
        return res.json({
          status, id: uploadId, original_name: uploadDoc.originalName, extract_path: destDir,
          total_users: users.length, total_conversations: uploadDoc.totalConversations,
          users: users.map(u => ({ email: u.email, display_name: u.displayName, conversation_count: u.conversationCount })),
        });
      }
      if (status === 'FAILED') {
        await db().collection('vaultExports').updateOne({ exportId }, { $set: { status: 'FAILED', completedAt: new Date(), error: 'Vault export failed' } });
        activeExport = null;
        return res.json({ status, error: 'Vault export failed' });
      }
      res.json({ status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Upload ZIP
  router.post('/upload', requireGoogleAuth, upload.single('vault_zip'), async (req, res) => {
    try {
      const zipPath = req.file.path;
      const extractTo = path.join(uploadsDir, `extracted_${req.file.filename}`);
      fs.mkdirSync(extractTo, { recursive: true });
      new AdmZip(zipPath).extractAllTo(extractTo, true);
      const xmlFiles = fs.readdirSync(extractTo).filter(f => f.toLowerCase().endsWith('.xml'));
      if (xmlFiles.length === 0) {
        return res.status(400).json({ error: 'No XML files found in ZIP.', files_found: fs.readdirSync(extractTo).slice(0, 20) });
      }
      const reader = new VaultReader(extractTo);
      const users = await reader.discoverUsers();
      if (users.length === 0) return res.status(400).json({ error: 'No users found in Vault export XML files.' });
      const usersArr = users.map(u => ({ email: u.email, displayName: u.displayName, conversationCount: u.conversationCount }));
      const { appUserId: _appUserId, googleEmail: _googleEmail, msEmail: _msEmail } = getWorkspaceContext(req);
      const uploadDoc = {
        _id: req.file.filename, originalName: req.file.originalname || 'vault_export.zip',
        uploadTime: new Date(), extractPath: extractTo, totalUsers: users.length,
        totalConversations: users.reduce((s, u) => s + u.conversationCount, 0), users: usersArr,
        appUserId: _appUserId, googleEmail: _googleEmail, msEmail: _msEmail,
      };
      await db().collection('uploads').updateOne({ _id: uploadDoc._id }, { $set: uploadDoc }, { upsert: true });
      dbLog.info(`uploads.upsert — ${uploadDoc.originalName} (${uploadDoc.totalUsers} users, ${uploadDoc.totalConversations} conversations)`);
      res.json({
        id: uploadDoc._id, original_name: uploadDoc.originalName, upload_time: uploadDoc.uploadTime.toISOString(),
        extract_path: extractTo, total_users: uploadDoc.totalUsers, total_conversations: uploadDoc.totalConversations,
        users: usersArr.map(u => ({ email: u.email, display_name: u.displayName, conversation_count: u.conversationCount }))
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Upload management
  router.get('/uploads', async (req, res) => {
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    if (!appUserId || !googleEmail) return res.json({ uploads: [] });
    const uploads = await db().collection('uploads').find({ appUserId, $or: [{ googleEmail }, { googleEmail: { $exists: false } }] }).sort({ uploadTime: -1 }).toArray();
    res.json({ uploads: uploads.map(u => ({ id: u._id, original_name: u.originalName, upload_time: u.uploadTime, extract_path: u.extractPath, total_users: u.totalUsers, total_conversations: u.totalConversations, users: (u.users || []).map(x => ({ email: x.email, display_name: x.displayName, conversation_count: x.conversationCount })) })) });
  });

  router.delete('/uploads/:id', async (req, res) => {
    const { id } = req.params;
    const entry = await db().collection('uploads').findOne({ _id: id });
    if (!entry) return res.status(404).json({ error: 'Upload not found' });
    try { fs.rmSync(entry.extractPath, { recursive: true, force: true }); } catch {}
    await db().collection('uploads').deleteOne({ _id: id });
    dbLog.info(`uploads.delete — ${id}`);
    res.json({ ok: true });
  });

  // Reports
  router.get('/reports', async (req, res) => {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    if (!appUserId) return res.json([]);
    // Build an OR that matches G2C/C2G (full workspace) + CL2G (google-only, no msEmail) + legacy (no googleEmail)
    const orClauses = [];
    if (googleEmail && msEmail) orClauses.push({ appUserId, googleEmail, msEmail });
    if (googleEmail)            orClauses.push({ appUserId, googleEmail, msEmail: { $exists: false } });
    orClauses.push({ appUserId, googleEmail: { $exists: false } });
    const reports = await db().collection('reportsWorkspace')
      .find({ $or: orClauses }, { projection: { report: 0 } })
      .sort({ startTime: -1 }).toArray();
    res.json(reports);
  });

  router.get('/reports/aggregate', async (req, res) => {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    if (!appUserId) return res.json({ totalBatches: 0, totalUsers: 0, totalPages: 0, totalErrors: 0, liveBatches: 0, dryRunBatches: 0 });
    const orClauses = [];
    if (googleEmail && msEmail) orClauses.push({ appUserId, googleEmail, msEmail });
    if (googleEmail)            orClauses.push({ appUserId, googleEmail, msEmail: { $exists: false } });
    orClauses.push({ appUserId, googleEmail: { $exists: false } });
    const pipeline = [
      { $match: { status: 'completed', $or: orClauses } },
      { $group: { _id: null, totalBatches: { $sum: 1 }, totalUsers: { $sum: '$totalUsers' }, totalPages: { $sum: '$migratedConversations' }, totalErrors: { $sum: { $ifNull: ['$report.summary.total_errors', 0] } }, liveBatches: { $sum: { $cond: [{ $ne: ['$dryRun', true] }, 1, 0] } }, dryRunBatches: { $sum: { $cond: [{ $eq: ['$dryRun', true] }, 1, 0] } } } }
    ];
    const [agg] = await db().collection('reportsWorkspace').aggregate(pipeline).toArray();
    const result = agg || { totalBatches: 0, totalUsers: 0, totalPages: 0, totalErrors: 0, liveBatches: 0, dryRunBatches: 0 };
    delete result._id;
    res.json(result);
  });

  router.get('/batches/migrated-users', async (req, res) => {
    const { uploadId } = req.query;
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    const appUserId = req.session.appUser?._id || null;
    const batches = await db().collection('reportsWorkspace')
      .find({ uploadId, appUserId, status: 'completed', dryRun: { $ne: true } }, { projection: { 'report.users.email': 1 } }).toArray();
    const migrated = new Set();
    batches.forEach(b => (b.report?.users || []).forEach(u => migrated.add(u.email)));
    res.json({ migrated_users: [...migrated] });
  });

  router.get('/reports/:id/csv', async (req, res) => {
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

  router.get('/reports/:id/errors', async (req, res) => {
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

  router.get('/reports/:id', async (req, res) => {
    const { id } = req.params;
    if (id === 'migration') {
      const latest = await db().collection('reportsWorkspace').findOne({}, { sort: { startTime: -1 } });
      if (!latest) return res.status(404).json({ error: 'No report yet' });
      const payload = latest.report || {};
      return res.json({ ...payload, customerName: latest.customerName, tenantId: latest.tenantId, batchId: latest._id });
    }
    const doc = await db().collection('reportsWorkspace').findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'Batch report not found' });
    if (req.query.download === 'true') res.setHeader('Content-Disposition', `attachment; filename="migration_report_${id}.json"`);
    res.setHeader('Content-Type', 'application/json');
    if (req.query.summary === 'true') {
      const { report, ...meta } = doc;
      return res.json({ ...meta, summary: report?.summary || null });
    }
    const payload = doc.report || {};
    res.json({ ...payload, customerName: doc.customerName, tenantId: doc.tenantId, batchId: doc._id });
  });

  // User mappings
  router.get('/user-mappings/latest', async (req, res) => {
    const wsFilter = getWorkspaceFilter(req);
    if (!wsFilter) return res.json(null);
    const doc = await db().collection('userMappings').findOne({ migDir: 'gemini-copilot', batchId: 'latest', ...wsFilter });
    res.json(doc || null);
  });

  router.post('/user-mappings', async (req, res) => {
    const { customerName, mappings, selectedUsers } = req.body;
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    await db().collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot', batchId: 'latest' },
      { $set: { customerName, mappings, selectedUsers, appUserId, migDir: 'gemini-copilot', googleEmail, msEmail, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    dbLog.info(`userMappings.upsert — G2C ${Object.keys(mappings || {}).length} mappings, ${(selectedUsers || []).length} selected`);
    res.json({ ok: true });
  });

  // Migration logs (historical)
  router.get('/migration-logs/:batchId', async (req, res) => {
    const wsFilter = getWorkspaceFilter(req);
    const filter = { batchId: req.params.batchId };
    if (wsFilter) filter.appUserId = wsFilter.appUserId;
    const logs = await db().collection('migrationLogs').find(filter).sort({ ts: 1 }).toArray();
    res.json(logs);
  });

  // ── Main Migration ────────────────────────────────────────────────────────

  router.post('/migrate', requireWorkspace, async (req, res) => {
    const {
      extract_path, tenant_id, customer_name = 'Gemini', user_mappings = {},
      dry_run = false, skip_followups = false, skip_ai_response = false,
      from_date = null, to_date = null, upload_id = null
    } = req.body;

    if (!extract_path || !tenant_id) return res.status(400).json({ error: 'extract_path and tenant_id are required' });

    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    if (!dry_run && !isAuthenticated(appUserId)) {
      return res.status(401).json({ error: 'Admin not signed in. Click "Sign in with Microsoft" first.' });
    }

    const batch_id = Date.now().toString();
    res.json({ started: true, batch_id });
    runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId, googleEmail, msEmail });
  });

  async function runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId, googleEmail, msEmail }) {
    logBuffers.set(appUserId, []);
    const batchId = batch_id || Date.now().toString();
    currentBatchId = batchId;
    _currentAppUserId = appUserId;
    const startTime = new Date();

    await db().collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot', batchId },
      { $set: { customerName: customer_name, mappings: user_mappings, migDir: 'gemini-copilot', createdAt: startTime, appUserId, googleEmail, msEmail } },
      { upsert: true }
    );
    dbLog.info(`userMappings.upsert — G2C batch ${batchId} (${Object.keys(user_mappings).length} mappings)`);

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
          { $set: { status: 'completed', endTime: new Date(), dryRun: true, totalUsers: users.length, totalConversations: total, migratedUsers: 0, migratedConversations: 0, failedUsers: 0, report: { summary: { total_users: users.length, total_conversations: total, total_pages_created: 0, total_errors: 0 } } } }
        );
        emit('done', `DRY RUN complete — ${users.length} users, ${total} conversations. No API calls made.`, { batch_id: batchId });
        currentBatchId = null;
        _currentAppUserId = null;
        return;
      }

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

      let progressUsers = 0, progressPages = 0, progressErrors = 0;

      await withConcurrency(users, 5, async (u) => {
        const gEmail = u.email;
        const m365Email = user_mappings[gEmail] || gEmail;

        emit('info', `Processing: ${gEmail} → ${m365Email}`);
        let conversations = null;
        const errors = [];
        let pagesCreated = 0;

        try {
          conversations = await reader.loadUserConversations(gEmail, from_date, to_date);
          emit('info', `  Loaded ${conversations.length} conversations for ${gEmail}`);

          let googleClient = null;
          let fileCorrelator = null;
          let driveMatcher = null;
          try {
            googleClient = getGoogleOAuth2Client(appUserId);
            fileCorrelator = new FileCorrelator(googleClient, gEmail);
            driveMatcher = new DriveFileMatcher(googleClient, gEmail, appUserId);
            emit('info', `  Drive file resolution enabled for ${gEmail}`);
          } catch (_) {
            emit('warn', `  Drive file resolution skipped for ${gEmail} — Google not authenticated`);
          }

          let enrichedConversations = conversations;
          if (fileCorrelator) {
            try {
              enrichedConversations = await fileCorrelator.enrichConversations(conversations);
              const enrichedCount = enrichedConversations.filter(c => c.turns?.some(t => t.driveFiles?.length > 0)).length;
              if (enrichedCount > 0) emit('info', `  Audit log enriched ${enrichedCount} conversation(s) for ${gEmail}`);
            } catch (err) {
              emit('warn', `  Audit log enrichment failed for ${gEmail}: ${err.message} — file correlation skipped`);
              enrichedConversations = conversations;
            }
          }

          for (const conv of enrichedConversations) {
            try {
              let convWithResponses = skip_ai_response ? conv : await generator.generate(conv, skip_followups);

              if (driveMatcher) {
                let totalDriveFiles = 0;
                const uploadCache = new Map();
                const resolvedTurns = await Promise.all(
                  (convWithResponses.turns || []).map(async (turn) => {
                    if (!turn.hasFileRef) return turn;
                    if (turn.driveFiles && turn.driveFiles.length > 0) {
                      const uploaded = await Promise.all(turn.driveFiles.map(async (f) => {
                        const { _meta, ...rest } = f;
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
                    return turn;
                  })
                );
                if (totalDriveFiles > 0) emit('info', `  ${totalDriveFiles} Drive file(s) resolved for "${conv.title?.slice(0, 50)}"`);
                convWithResponses = { ...convWithResponses, turns: resolvedTurns };
              }

              await creator.createPage(m365Email, convWithResponses, visualReports[gEmail] || []);
              pagesCreated++;
              emit('success', `  Page created: ${conv.title?.slice(0, 60)}`);
            } catch (err) {
              errors.push({ conversation: conv.title, error: err.message });
              dbLog.error(`Page creation failed for "${conv.title}" → ${err.message}`);
              emit('error', `  Failed: ${conv.title?.slice(0, 40)} — ${err.message}`);
            }
          }

          report.addUserResult({ email: m365Email, conversations: conversations.length, pagesCreated, visualAssetsFlagged: (visualReports[gEmail] || []).length, errors });
          await checkpoint.markComplete(gEmail);
          emit('success', `  Done: ${pagesCreated}/${conversations.length} pages created for ${m365Email}`);
        } catch (err) {
          emit('error', `Fatal error for ${gEmail}: ${err.message}`);
          report.addUserResult({ email: m365Email, conversations: 0, pagesCreated: 0, visualAssetsFlagged: 0, errors: [{ error: err.message }] });
          progressErrors++;
        } finally {
          progressUsers++;
          progressPages += pagesCreated;
          conversations = null;
          db().collection('reportsWorkspace').updateOne(
            { _id: batchId },
            { $set: { progressUsers, progressPages, progressErrors, totalUsers: users.length } }
          ).catch(() => {});
        }
      });

      const reportPath = path.join(uploadsDir, 'migration_report.json');
      report.write(reportPath);
      const fullReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

      const reportUpdate = {
        status: 'completed', endTime: new Date(),
        totalUsers: fullReport.summary?.total_users || users.length,
        migratedUsers: fullReport.summary?.total_users || 0,
        failedUsers: fullReport.summary?.total_errors > 0 ? 1 : 0,
        totalConversations: fullReport.summary?.total_conversations || 0,
        migratedConversations: fullReport.summary?.total_pages_created || 0,
        flaggedAssets: fullReport.summary?.total_flagged || Object.values(visualReports || {}).reduce((s, v) => s + (v?.length || 0), 0),
        report: fullReport,
      };

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

  // Retry failed conversations
  router.post('/migrate/retry', requireWorkspace, async (req, res) => {
    const { batchId, customer_name } = req.body;
    if (!batchId) return res.status(400).json({ error: 'batchId required' });
    const { appUserId } = getWorkspaceContext(req);
    if (!isAuthenticated(appUserId)) return res.status(401).json({ error: 'Not signed in. Click "Sign in with Microsoft" first.' });

    const batchDoc = await db().collection('reportsWorkspace').findOne({ _id: batchId });
    if (!batchDoc) return res.status(404).json({ error: 'Batch not found' });

    const mappingDoc = await db().collection('userMappings').findOne({ appUserId, migDir: 'gemini-copilot', batchId });
    const uploadDoc = await db().collection('uploads').findOne({}, { sort: { uploadTime: -1 } });

    const retryTargets = {};
    for (const u of batchDoc.report?.users || []) {
      if (u.errors?.length > 0) retryTargets[u.email] = u.errors.map(e => e.conversation);
    }

    if (Object.keys(retryTargets).length === 0) return res.json({ started: false, message: 'No failed conversations to retry' });

    const effectiveCustomerName = customer_name || batchDoc.customerName;
    const retryBatchId = `${batchId}_retry_${Date.now()}`;
    res.json({ started: true, batch_id: retryBatchId, targets: retryTargets });

    runRetry({ batchId, retryBatchId, extractPath: uploadDoc?.extractPath, tenantId: batchDoc.tenantId, customerName: effectiveCustomerName, userMappings: mappingDoc?.mappings || {}, retryTargets, appUserId });
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
    const reverseMap = Object.fromEntries(Object.entries(userMappings).map(([g, m]) => [m, g]));

    for (const [m365Email, failedTitles] of Object.entries(retryTargets)) {
      const gEmail = reverseMap[m365Email] || m365Email;
      const titleSet = new Set(failedTitles);
      const errors = [];
      let pagesCreated = 0;

      emit('info', `Retrying ${failedTitles.length} conversation(s) for ${m365Email}`);

      try {
        const allConversations = await reader.loadUserConversations(gEmail, null, null);
        const toRetry = allConversations.filter(c => titleSet.has(c.title));
        if (toRetry.length === 0) { emit('warn', `  No matching conversations found for ${m365Email} — skipping`); continue; }

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
      } catch (err) { emit('error', `Fatal for ${m365Email}: ${err.message}`); }
    }

    const retryReport = report.getReport();
    await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { 'report.retry': retryReport, retryAt: new Date() } }).catch(() => {});

    const retried = retryReport.summary.total_pages_created;
    const stillFailing = retryReport.summary.total_errors;
    emit('done', `━━━ Retry complete — ${retried} recovered, ${stillFailing} still failing ━━━`, { batch_id: retryBatchId });
    currentBatchId = null;
    _currentAppUserId = null;
  }

  // Agent Chat
  router.post('/chat', (req, res, next) => {
    if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
    next();
  }, async (req, res) => {
    const { message, migrationState = {}, migrationLogs = [], isSystemTrigger = false } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Attach migration executors to session so toolExecutor can fire them
    req.session._agentDeps = {
      startMigration: async ({ dryRun, batchId, migDir: dir, appUserId: uid }) => {
        if (dir === 'gemini-copilot') {
          const msEmail = req.session.msEmail || null;
          const uploadId = migrationState.uploadData?.id;
          const uploadDoc = uploadId
            ? await db().collection('uploads').findOne({ _id: uploadId })
            : await db().collection('uploads').findOne({}, { sort: { uploadTime: -1 } });
          const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: 'gemini-copilot' });
          return runMigration({
            extract_path: migrationState.uploadExtractPath || uploadDoc?.extractPath,
            tenant_id: migrationState.tenantId || null,
            customer_name: migrationState.customerName || 'Gemini',
            user_mappings: mappingDoc?.mappings || {},
            dry_run: dryRun,
            batch_id: batchId,
            appUserId: uid,
            googleEmail: req.session.appUser?.email,
            msEmail,
          });
        }
        return Promise.resolve({ started: true, note: `${dir} migration queued` });
      },
      retryMigration: async ({ batchId: retryFromBatchId, appUserId: uid }) => {
        const batchDoc = await db().collection('reportsWorkspace').findOne({ _id: retryFromBatchId });
        if (!batchDoc) return { error: 'Batch not found' };
        const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: 'gemini-copilot', batchId: retryFromBatchId });
        const uploadDoc = await db().collection('uploads').findOne({}, { sort: { uploadTime: -1 } });
        const retryTargets = {};
        for (const u of batchDoc.report?.users || []) {
          if (u.errors?.length > 0) retryTargets[u.email] = u.errors.map(e => e.conversation);
        }
        if (Object.keys(retryTargets).length === 0) return { started: false, message: 'No failed items to retry' };
        const retryBatchId = `${retryFromBatchId}_retry_${Date.now()}`;
        return runRetry({
          batchId: retryFromBatchId,
          retryBatchId,
          extractPath: uploadDoc?.extractPath,
          tenantId: batchDoc.tenantId,
          customerName: batchDoc.customerName || 'Gemini',
          userMappings: mappingDoc?.mappings || {},
          retryTargets,
          appUserId: uid,
        });
      },
    };

    await runAgentLoop(req, res, {
      message,
      migrationState,
      migrationLogs,
      isSystemTrigger: isSystemTrigger || message === '__step_context__',
      db: db(),
    });
  });

  return router;
}
