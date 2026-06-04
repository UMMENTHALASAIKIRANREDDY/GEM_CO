/**
 * G2C (Gemini → Copilot) routes.
 * All route paths preserved exactly as they were in server.js.
 */

import { randomUUID } from 'crypto';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
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
import { IndexWriter } from '../../agent/indexWriter.js';
import { getLogger } from '../../utils/logger.js';
import { runAgentLoop } from '../../agent/agentLoop.js';
import { auditEmitter } from '../../agent/auditLogger.js';
import { provisionUser, provisionUsers } from './userProvisioner.js';

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

  // Multer scratch space — OS temp dir. The raw ZIP and the extracted XML
  // files live here only for the few seconds it takes to parse them into
  // conversationStore, then both are deleted. The project's old uploads/
  // folder is no longer used (reportsDir was also unused dead code).
  const uploadsDir = path.join(os.tmpdir(), 'gemco-g2c');
  fs.mkdirSync(uploadsDir, { recursive: true });

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
      const { getServiceAccountAuthForUser, SCOPES_AUDIT_LOG } = await import('../c2g/googleService.js');
      const auth = await getServiceAccountAuthForUser(appUserId, null, SCOPES_AUDIT_LOG);
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
      const { getServiceAccountAuthForUser, SCOPES_DRIVE } = await import('../c2g/googleService.js');
      const auth = await getServiceAccountAuthForUser(appUserId, null, SCOPES_DRIVE);
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
      const { getServiceAccountAuthForUser, SCOPES_DRIVE } = await import('../c2g/googleService.js');
      const googleClient = await getServiceAccountAuthForUser(appUserId, null, SCOPES_DRIVE);
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
      const { getServiceAccountAuthForUser, SCOPES_DRIVE } = await import('../c2g/googleService.js');
      const googleClient = await getServiceAccountAuthForUser(appUserId, null, SCOPES_DRIVE);
      const result = await checkPermissions(googleClient);
      res.json(result);
    } catch (err) {
      res.status(401).json({
        drive: false, reports: false, directory: false,
        errors: { auth: err.message },
      });
    }
  });

  // Provision MS user(s) — trigger OneDrive + assign license if missing
  router.post('/provision-users', requireMsAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { emails } = req.body;
      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'emails array required' });
      }
      const results = await provisionUsers(appUserId, emails);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Google users (Admin SDK)
  router.get('/google/users', requireGoogleAuth, async (req, res) => {
    try {
      const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
      const { getServiceAccountAuthForUser } = await import('../c2g/googleService.js');
      // Service-account auth — bypasses Google's user-OAuth reauth policy.
      const auth = await getServiceAccountAuthForUser(appUserId);
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
              filter: { email: u.email, source: 'google', appUserId },
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
              filter: { email: u.mail || u.userPrincipalName, source: 'microsoft', appUserId },
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
      const { user_emails, accountId } = req.body;
      if (!user_emails || user_emails.length === 0) return res.status(400).json({ error: 'user_emails array required' });
      const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
      // IMPORTANT: pass accountId so we use the SOURCE admin's identity for
      // Vault search. Vault permissions are per-tenant — using the wrong
      // admin returns "No permission to search accounts" for cross-tenant
      // user lists.
      const { getGoogleAccounts } = await import('../../core/auth/googleOAuth.js');
      const accounts = getGoogleAccounts(appUserId);
      const picked = accountId
        ? accounts.find(a => a.accountId === accountId)
        : accounts[0];
      if (!picked) {
        return res.status(400).json({ error: `Google account ${accountId || '(default)'} not connected. Sign in first.` });
      }
      // PREFER service-account auth via domain-wide delegation: it impersonates
      // the picked admin without requiring periodic admin reauthentication.
      // This is what makes the connection "persist forever after one sign-in"
      // — the JWT we sign refreshes itself on every API call. Falls back to
      // the OAuth2 client (requires periodic reauth) if DWD isn't configured.
      let auth;
      let usingServiceAccount = false;
      try {
        const { getVaultServiceAccountAuth } = await import('../c2g/googleService.js');
        auth = getVaultServiceAccountAuth(picked.email);
        // Force a token mint to fail fast if DWD isn't configured for the
        // ediscovery scope.
        const client = await auth.getClient();
        await client.getAccessToken();
        usingServiceAccount = true;
      } catch (svcErr) {
        // DWD isn't set up for ediscovery scope — fall back to user OAuth.
        // This will work but is subject to Google's reauth policy.
        dbLog.warn(`vault-export: service-account auth unavailable (${svcErr.message?.slice(0, 200)}) — falling back to OAuth which may require admin re-sign-in.`);
        try {
          auth = getGoogleOAuth2Client(appUserId, accountId || null);
          await auth.getAccessToken();
        } catch (e) {
          return res.status(401).json({ error: `Google session expired for ${picked.email}. Reconnect this account, OR have your Workspace admin grant the ediscovery scope to the service account for domain-wide delegation (one-time setup that avoids future reauthentication).` });
        }
      }
      dbLog.info(`vault-export: admin=${picked.email} auth=${usingServiceAccount ? 'service-account (no reauth)' : 'oauth (may reauth)'} users=${user_emails.length}: ${user_emails.slice(0, 5).join(', ')}${user_emails.length > 5 ? `, ...+${user_emails.length - 5} more` : ''}`);
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

  // Upload ZIP — extracts conversations to conversationStore (DB) at upload time
  //
  // Flow:
  //  1. Multer drops raw ZIP on disk
  //  2. Extract to uploads/extracted_{filename}/
  //  3. Parse all users + all conversations via VaultReader
  //  4. EVERY conversation is written to `conversationStore` (FATAL if it fails)
  //  5. Disk extract is deleted — migration reads exclusively from DB
  router.post('/upload', requireGoogleAuth, upload.single('vault_zip'), async (req, res) => {
    let extractTo = null;
    try {
      const zipPath = req.file.path;
      extractTo = path.join(uploadsDir, `extracted_${req.file.filename}`);
      fs.mkdirSync(extractTo, { recursive: true });
      new AdmZip(zipPath).extractAllTo(extractTo, true);
      const xmlFiles = fs.readdirSync(extractTo).filter(f => f.toLowerCase().endsWith('.xml'));
      if (xmlFiles.length === 0) {
        return res.status(400).json({ error: 'No XML files found in ZIP.', files_found: fs.readdirSync(extractTo).slice(0, 20) });
      }
      const reader = new VaultReader(extractTo);
      const users = await reader.discoverUsers();
      if (users.length === 0) return res.status(400).json({ error: 'No users found in Vault export XML files.' });

      // Write all conversations to conversationStore. FATAL — disk extract is
      // about to be deleted so DB is the only copy.
      const { appUserId: _appUserId, googleEmail: _googleEmail, msEmail: _msEmail } = getWorkspaceContext(req);
      const uploadId = req.file.filename;
      const ingestBatchId = `ingest_${uploadId}`;
      let totalPersisted = 0;
      const { persistSourceConversations, SOURCE_TYPE } = await import('../_shared/conversationStore.js');
      for (const u of users) {
        const userConvs = await reader.loadUserConversations(u.email, null, null);
        if (!userConvs?.length) continue;
        const r = await persistSourceConversations(
          {
            batchId: ingestBatchId,
            appUserId: _appUserId,
            migDir: 'gemini-copilot',
            sourceType: SOURCE_TYPE.VAULT,
            sourceEmail: u.email,
            sourceDisplayName: u.displayName,
            uploadId,
          },
          userConvs.map(c => ({
            sessionId: c.id || `${u.email}::${c.title || 'untitled'}::${c.createdDateTime || ''}`,
            title: c.title,
            createdDateTime: c.createdDateTime,
            payload: c,
          }))
        );
        totalPersisted += r.inserted;
      }
      dbLog.info(`conversationStore.upsert — ${totalPersisted} conversations persisted at upload time for ${req.file.originalname}`);

      // DB has every conversation — purge disk extract. Vault attachments
      // referenced by conversations are dropped (scope decision).
      fs.rm(extractTo, { recursive: true, force: true }, (err) => {
        if (err) dbLog.warn(`Failed to clean up extract dir ${extractTo}: ${err.message}`);
        else dbLog.info(`extract dir cleaned: ${extractTo}`);
      });
      // Also remove the raw ZIP — multer left it on disk after extraction.
      fs.unlink(zipPath, () => {});

      const usersArr = users.map(u => ({ email: u.email, displayName: u.displayName, conversationCount: u.conversationCount }));
      const uploadDoc = {
        _id: uploadId, originalName: req.file.originalname || 'vault_export.zip',
        uploadTime: new Date(),
        // No extractPath — disk is gone; migration reads from conversationStore.
        ingestBatchId,
        conversationsPersisted: totalPersisted,
        totalUsers: users.length,
        totalConversations: users.reduce((s, u) => s + u.conversationCount, 0), users: usersArr,
        appUserId: _appUserId, googleEmail: _googleEmail, msEmail: _msEmail,
      };
      await db().collection('uploads').updateOne({ _id: uploadDoc._id }, { $set: uploadDoc }, { upsert: true });
      dbLog.info(`uploads.upsert — ${uploadDoc.originalName} (${uploadDoc.totalUsers} users, ${uploadDoc.totalConversations} conversations, ${totalPersisted} in conversationStore)`);
      res.json({
        id: uploadDoc._id, original_name: uploadDoc.originalName, upload_time: uploadDoc.uploadTime.toISOString(),
        total_users: uploadDoc.totalUsers, total_conversations: uploadDoc.totalConversations,
        conversations_persisted: totalPersisted,
        ingest_batch_id: ingestBatchId,
        users: usersArr.map(u => ({ email: u.email, display_name: u.displayName, conversation_count: u.conversationCount }))
      });
    } catch (err) {
      // On failure, clean up the partial extract so it doesn't linger.
      if (extractTo) fs.rm(extractTo, { recursive: true, force: true }, () => {});
      res.status(500).json({ error: err.message });
    }
  });

  // Upload management
  router.get('/uploads', async (req, res) => {
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    if (!appUserId || !googleEmail) return res.json({ uploads: [] });
    const uploads = await db().collection('uploads').find({ appUserId, $or: [{ googleEmail }, { googleEmail: { $exists: false } }] }).sort({ uploadTime: -1 }).toArray();
    res.json({ uploads: uploads.map(u => ({ id: u._id, original_name: u.originalName, upload_time: u.uploadTime, total_users: u.totalUsers, total_conversations: u.totalConversations, users: (u.users || []).map(x => ({ email: x.email, display_name: x.displayName, conversation_count: x.conversationCount })) })) });
  });

  router.delete('/uploads/:id', async (req, res) => {
    const { id } = req.params;
    const { appUserId } = getWorkspaceContext(req);
    const entry = await db().collection('uploads').findOne({ _id: id, appUserId });
    if (!entry) return res.status(404).json({ error: 'Upload not found' });
    try { fs.rmSync(entry.extractPath, { recursive: true, force: true }); } catch {}
    await db().collection('uploads').deleteOne({ _id: id, appUserId });
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
    // Exclude migrations that have dedicated /reports endpoints (g2g, c2c).
    // Without this filter, ReportsPanel — which concatenates results from
    // /api/reports + /api/g2g/reports + /api/c2c/reports — shows each foreign
    // batch twice.
    const reports = await db().collection('migrationWorkspaces')
      .find({
        $and: [
          { $or: orClauses },
          { migDir: { $nin: ['gemini-gemini', 'copilot-copilot'] } },
        ],
      }, { projection: { report: 0 } })
      .sort({ startTime: -1 }).toArray();
    res.json(reports);
  });

  router.get('/reports/aggregate', async (req, res) => {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.json({ totalBatches: 0, totalUsers: 0, totalPages: 0, totalErrors: 0, liveBatches: 0, dryRunBatches: 0 });
    const pipeline = [
      { $match: { status: 'completed', appUserId, migDir: { $nin: ['gemini-gemini', 'copilot-copilot'] } } },
      { $group: { _id: null, totalBatches: { $sum: 1 }, totalUsers: { $sum: '$totalUsers' }, totalPages: { $sum: '$migratedConversations' }, totalErrors: { $sum: { $ifNull: ['$report.summary.total_errors', 0] } }, liveBatches: { $sum: { $cond: [{ $ne: ['$dryRun', true] }, 1, 0] } }, dryRunBatches: { $sum: { $cond: [{ $eq: ['$dryRun', true] }, 1, 0] } } } }
    ];
    const [agg] = await db().collection('migrationWorkspaces').aggregate(pipeline).toArray();
    const result = agg || { totalBatches: 0, totalUsers: 0, totalPages: 0, totalErrors: 0, liveBatches: 0, dryRunBatches: 0 };
    delete result._id;
    res.json(result);
  });

  router.get('/batches/migrated-users', async (req, res) => {
    const { uploadId } = req.query;
    if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
    const appUserId = req.session.appUser?._id?.toString() || null;
    const batches = await db().collection('migrationWorkspaces')
      .find({ uploadId, appUserId, migDir: 'gemini-copilot', status: 'completed', dryRun: { $ne: true } }, { projection: { 'report.users.email': 1 } }).toArray();
    const migrated = new Set();
    batches.forEach(b => (b.report?.users || []).forEach(u => migrated.add(u.email)));
    res.json({ migrated_users: [...migrated] });
  });

  router.get('/reports/:id/csv', async (req, res) => {
    const { appUserId } = getWorkspaceContext(req);
    const doc = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId });
    if (!doc) return res.status(404).json({ error: 'Batch not found' });
    const { buildBatchCsv } = await import('../_shared/csvExport.js');
    const csv = buildBatchCsv(doc);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="batch_${req.params.id}.csv"`);
    res.send(csv);
  });

  router.get('/reports/:id/errors', async (req, res) => {
    const { appUserId } = getWorkspaceContext(req);
    const doc = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId });
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
    const { appUserId } = getWorkspaceContext(req);
    if (id === 'migration') {
      const latest = await db().collection('migrationWorkspaces').findOne({ appUserId }, { sort: { startTime: -1 } });
      if (!latest) return res.status(404).json({ error: 'No report yet' });
      const payload = latest.report || {};
      return res.json({ ...payload, customerName: latest.customerName, tenantId: latest.tenantId, batchId: latest._id });
    }
    const doc = await db().collection('migrationWorkspaces').findOne({ _id: id, appUserId });
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
    const { customerName, mappings, selectedUsers, csvEmails } = req.body;
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    await db().collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot' },
      { $set: { customerName, mappings, selectedUsers, csvEmails: csvEmails ?? null, appUserId, migDir: 'gemini-copilot', googleEmail, msEmail, batchId: 'latest', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    dbLog.info(`userMappings.upsert — G2C ${Object.keys(mappings || {}).length} mappings, ${(selectedUsers || []).length} selected`);
    res.json({ ok: true });
  });

  const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  router.post('/user-mappings-csv', uploadMemory.single('csv'), async (req, res) => {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    const migDirParam = req.query.migDir || req.body?.migDir || 'gemini-copilot';
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

    try {
      const text = req.file.buffer.toString('utf8');
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const cols = lines[0]?.split(',').map(s => s.trim()) ?? [];
      const hasHeader = cols.every(c => !c.includes('@'));
      const dataLines = hasHeader ? lines.slice(1) : lines;

      const mappings = {};
      for (const line of dataLines) {
        const [src, dst] = line.split(',').map(s => s?.trim().toLowerCase());
        if (src && dst) mappings[src] = dst;
      }

      const count = Object.keys(mappings).length;
      if (count === 0) return res.status(400).json({ error: 'No valid rows found. CSV must have source_email,dest_email columns.' });

      const csvEmails = Object.keys(mappings);
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: migDirParam },
        {
          $set: { mappings, csvEmails, appUserId, migDir: migDirParam, googleEmail, msEmail, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      dbLog.info(`userMappings-csv — ${migDirParam} ${count} mappings from CSV`);
      res.json({ success: true, count, mappings, csvEmails, migDir: migDirParam });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET current user mappings (mappings + csvEmails) for G2C — used by Step2 on mount
  router.get('/user-mappings', async (req, res) => {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.json(null);
    const doc = await db().collection('userMappings').findOne({ appUserId, migDir: 'gemini-copilot' });
    res.json(doc || null);
  });

  // DELETE — clear CSV-uploaded mappings for G2C (restores cloud auto-mapping)
  router.delete('/user-mappings', async (req, res) => {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.json({ ok: true });
    await db().collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot' },
      { $set: { mappings: {}, csvEmails: null, updatedAt: new Date() } }
    );
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

    // After the move to DB-only storage, `extract_path` is no longer required —
    // conversations are loaded from conversationStore via upload_id. We still
    // accept it for legacy callers / backward compat, but tenant_id is all we
    // actually need.
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    if (!dry_run && !isAuthenticated(appUserId)) {
      return res.status(401).json({ error: 'Admin not signed in. Click "Sign in with Microsoft" first.' });
    }

    const batch_id = randomUUID();
    res.json({ started: true, batch_id });
    const resumeContext = {
      kind: 'g2c',
      extract_path, tenant_id, customer_name, user_mappings,
      dry_run, skip_followups, skip_ai_response,
      from_date, to_date, upload_id,
      appUserId, googleEmail, msEmail,
    };
    executeG2CMigration({ batchId: batch_id, startTime: new Date(), resumeContext, isResume: false }).catch(e => {
      console.error('[G2C] runMigration unhandled error:', e.message);
    });
  });

  async function executeG2CMigration({ batchId, startTime, resumeContext, isResume }) {
    const { extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, upload_id, appUserId, googleEmail, msEmail } = resumeContext;
    return runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id: batchId, upload_id, appUserId, googleEmail, msEmail, isResume, resumeContext, startTime });
  }

  async function runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, skip_ai_response, from_date, to_date, batch_id, upload_id, appUserId, googleEmail, msEmail, isResume = false, resumeContext = null, startTime: providedStartTime = null }) {
    logBuffers.set(appUserId, []);
    const batchId = batch_id || randomUUID();
    currentBatchId = batchId;
    _currentAppUserId = appUserId;
    const startTime = new Date();

    try {
    await db().collection('userMappings').updateOne(
      { appUserId, migDir: 'gemini-copilot' },
      { $set: { customerName: customer_name, mappings: user_mappings, migDir: 'gemini-copilot', batchId, updatedAt: startTime, appUserId, googleEmail, msEmail }, $setOnInsert: { createdAt: startTime } },
      { upsert: true }
    );
    dbLog.info(`userMappings.upsert — G2C batch ${batchId} (${Object.keys(user_mappings).length} mappings)`);

    await db().collection('migrationWorkspaces').updateOne(
      { _id: batchId },
      { $set: { migDir: 'gemini-copilot', customerName: customer_name, tenantId: tenant_id, startTime, status: 'running', dryRun: dry_run, uploadId: upload_id, appUserId, googleEmail, msEmail, lastHeartbeat: new Date(), ...(resumeContext ? { resumeContext } : {}), ...(isResume ? { resumedAt: new Date() } : {}) } },
      { upsert: true }
    );
    dbLog.info(`migrationWorkspaces.${isResume ? 'resume' : 'insert'} — batch ${batchId} status=running${isResume ? ' (AUTO-RESUMED)' : ''}`);

    // Start heartbeat so the boot-time orphan detector knows this batch is alive
    const { startHeartbeat, stopHeartbeat, loadConversationsFromStore, markUserPairMigrated, markUserPairFailed } = await import('../_shared/conversationStore.js');
    const _heartbeatId = startHeartbeat(batchId);

    const jobIds = {};
    if (!dry_run && Object.keys(user_mappings).length > 0) {
      await Promise.all(Object.entries(user_mappings).map(async ([sourceEmail, destEmail]) => {
        const jobId = randomUUID();
        try {
          await db().collection('migrationJobs').insertOne({
            jobId, workspaceId: batchId, appUserId, migDir: 'gemini-copilot',
            sourceEmail, destEmail, status: 'pending', pages: 0, errors: [],
            startTime: null, endTime: null,
          });
          jobIds[sourceEmail] = jobId;
        } catch (e) { dbLog.warn(`migrationJobs.insert failed for ${sourceEmail}: ${e.message}`); }
      }));
    }

    await new Promise(r => setTimeout(r, 200));
    emit('info', '━━━ Migration started ━━━');
    if (skip_ai_response) emit('info', 'Azure OpenAI disabled — migrating original Gemini responses only');

    try {
      // VaultReader is only used as a disk-fallback for legacy uploads (where
      // conversationStore wasn't populated at upload time). New uploads have
      // no extract_path because the disk content was deleted at upload time —
      // conversations come from conversationStore instead.
      const reader = (extract_path && fs.existsSync(extract_path)) ? new VaultReader(extract_path) : null;
      let allUsers;
      if (reader) {
        allUsers = await reader.discoverUsers();
      } else {
        // DB-only path: get the user list from the upload metadata document.
        const uploadDoc = upload_id ? await db().collection('uploads').findOne({ _id: upload_id }) : null;
        if (!uploadDoc) {
          emit('error', `Upload ${upload_id} not found in DB — cannot determine users to migrate. Re-upload the Vault ZIP.`);
          throw new Error(`Upload not found: ${upload_id}`);
        }
        allUsers = (uploadDoc.users || []).map(u => ({ email: u.email, displayName: u.displayName, conversationCount: u.conversationCount }));
      }
      const users = Object.keys(user_mappings).length > 0
        ? allUsers.filter(u => Object.prototype.hasOwnProperty.call(user_mappings, u.email))
        : allUsers;

      emit('info', `Discovered ${allUsers.length} users — migrating ${users.length} selected`);

      if (dry_run) {
        // Pre-flight validator (additive — runs alongside count loop)
        try {
          const { runDryRunValidator } = await import('../dry-run/validator.js');
          const validatorPairs = users.map(u => ({
            sourceEmail: u.email,
            destEmail: user_mappings[u.email] || u.email,
            expectedConversationCount: u.conversationCount || 0,
          }));
          const uploadDoc = await db().collection('uploads').findOne({ _id: upload_id });
          const dryRunReport = await runDryRunValidator({
            migDir: 'gemini-copilot',
            pairs: validatorPairs,
            config: { folderName: customer_name, fromDate: from_date, toDate: to_date, dryRun: true },
            appUserId, googleEmail, msEmail,
            uploadData: uploadDoc,
            extractPath: extract_path,
          });
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { dryRunReport } }
          ).catch(() => {});
          emit('info', `Dry-run validator: ${dryRunReport.summary.ready} ready · ${dryRunReport.summary.warning} warning · ${dryRunReport.summary.blocker} blocker`);
        } catch (e) {
          emit('warn', `Dry-run validator failed: ${e.message}`);
        }
        for (const u of users) {
          const m365Email = user_mappings[u.email] || u.email;
          emit('user', `${u.email} → ${m365Email} (${u.conversationCount} conversations)`);
        }
        const total = users.reduce((s, u) => s + u.conversationCount, 0);
        await db().collection('migrationWorkspaces').updateOne(
          { _id: batchId },
          { $set: { migDir: 'gemini-copilot', status: 'completed', endTime: new Date(), dryRun: true, totalUsers: users.length, totalConversations: total, migratedUsers: 0, migratedConversations: 0, failedUsers: 0, report: { summary: { total_users: users.length, total_conversations: total, total_pages_created: 0, total_errors: 0 } } } }
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
        if (jobIds[gEmail]) {
          await db().collection('migrationJobs').updateOne(
            { jobId: jobIds[gEmail] },
            { $set: { status: 'running', startTime: new Date() } }
          ).catch(() => {});
        }
        let conversations = null;
        const errors = [];
        let pagesCreated = 0;

        try {
          // Try to load from conversationStore FIRST (Chunk 2: DB-backed read).
          // Falls back to disk-based reader if no rows found (legacy uploads).
          const fromStore = await loadConversationsFromStore({
            appUserId,
            sourceEmail: gEmail,
            uploadId: upload_id,
            fromDate: from_date,
            toDate: to_date,
            includeMigrated: !isResume,  // resume skips already-migrated rows
          });
          if (fromStore && fromStore.length > 0) {
            conversations = fromStore;
            emit('info', `  Loaded ${conversations.length} conversations from conversationStore for ${gEmail}`);
          } else if (reader) {
            // Legacy disk-only upload
            conversations = await reader.loadUserConversations(gEmail, from_date, to_date);
            emit('info', `  Loaded ${conversations.length} conversations (disk) for ${gEmail}`);
          } else {
            // DB miss + no disk → upload is corrupt or never ingested
            conversations = [];
            emit('warn', `  No conversations found in conversationStore for ${gEmail}. Upload may need to be re-done.`);
          }

          let googleClient = null;
          let fileCorrelator = null;
          let driveMatcher = null;
          try {
            // Service-account auth so the migration runs regardless of the
            // admin's user-OAuth token freshness (no invalid_rapt failures).
            // Migration needs Drive + Audit Log scopes (FileCorrelator queries
            // the audit log; DriveFileMatcher reads/writes Drive).
            const { getServiceAccountAuthForUser, SCOPES_DRIVE, SCOPES_AUDIT_LOG } = await import('../c2g/googleService.js');
            googleClient = await getServiceAccountAuthForUser(appUserId, null, [...SCOPES_DRIVE, ...SCOPES_AUDIT_LOG]);
            fileCorrelator = new FileCorrelator(googleClient, gEmail);
            driveMatcher = new DriveFileMatcher(googleClient, gEmail, appUserId);
            emit('info', `  Drive file resolution enabled for ${gEmail}`);
          } catch (err) {
            emit('warn', `  Drive file resolution skipped for ${gEmail} — ${err.message}`);
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

          // Auto-provision OneDrive + SharePoint personal site before writing pages
          try {
            const provResult = await provisionUser(appUserId, m365Email);
            if (provResult.provisioned) emit('info', `  OneDrive provisioned for ${m365Email}`);
            if (provResult.licenseAssigned) emit('info', `  M365 license assigned to ${m365Email}`);
          } catch (e) {
            emit('warn', `  Pre-provision failed for ${m365Email}: ${e.message} — continuing anyway`);
          }

          let oneNoteBlocked = false;
          for (const conv of enrichedConversations) {
            if (oneNoteBlocked) break;
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

              // Phase 1 (inline data fences) + Phase 2 (Python regen) recovery
              // from Gemini's response text. Same module as G2G. Uploads each
              // recovered file to the destination user's OneDrive and attaches
              // to the matching turn so the OneNote page hyperlinks it.
              try {
                const { recoverFilesFromConversation, cleanupWorkDirs } = await import('../gemini/fileRegenerator.js');
                const recovered = await recoverFilesFromConversation(convWithResponses);
                if (recovered.length > 0) {
                  const fs = await import('fs');
                  const msToken = await getValidToken(appUserId);
                  let regenCount = 0;
                  for (const f of recovered) {
                    if (f._failed) {
                      errors.push({ conversation: conv.title, error: `Gemini regen ${f.sourceTag}: ${f.reason}` });
                      emit('warn', `    Gemini regen failed (${f.sourceTag}): ${f.reason}`);
                      continue;
                    }
                    try {
                      const buf = f.buffer || fs.default.readFileSync(f.fullPath);
                      const safeName = (f.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
                      const encoded = encodeURIComponent(`GeminiMigration/${safeName}`);
                      const url = `https://graph.microsoft.com/v1.0/users/${m365Email}/drive/root:/${encoded}:/content`;
                      const upRes = await fetch(url, {
                        method: 'PUT',
                        headers: { Authorization: `Bearer ${msToken}`, 'Content-Type': f.mime || 'application/octet-stream' },
                        body: buf,
                      });
                      if (!upRes.ok) {
                        emit('warn', `    Gemini regen upload failed for "${f.name}": ${upRes.status}`);
                        continue;
                      }
                      const upData = await upRes.json();
                      const webUrl = upData.webUrl || upData['@microsoft.graph.downloadUrl'] || null;
                      const turn = convWithResponses.turns?.[f.turnIndex];
                      if (turn) {
                        if (!turn.driveFiles) turn.driveFiles = [];
                        turn.driveFiles.push({
                          fileName: f.name,
                          mimeType: f.mime,
                          oneDriveUrl: webUrl,
                          _imageBuffer: (f.mime || '').startsWith('image/') ? buf : null,
                        });
                      }
                      regenCount++;
                      emit('success', `    Gemini-regenerated: "${f.name}" (${buf.length} bytes) → ${m365Email}'s OneDrive`);
                    } catch (e) {
                      emit('warn', `    Gemini regen upload error for "${f.name}": ${e.message}`);
                      errors.push({ conversation: conv.title, error: `Gemini regen upload "${f.name}": ${e.message}` });
                    }
                  }
                  if (regenCount > 0) emit('info', `  Regenerated ${regenCount} file(s) from Gemini chat content for "${conv.title?.slice(0, 50)}"`);
                  cleanupWorkDirs(recovered);
                }
              } catch (err) {
                emit('warn', `  Gemini file recovery skipped for "${conv.title}": ${err.message}`);
              }

              await creator.createPage(m365Email, convWithResponses, visualReports[gEmail] || []);
              pagesCreated++;
              emit('success', `  Page created: ${conv.title?.slice(0, 60)}`);
            } catch (err) {
              if (err.message.startsWith('ONENOTE_NOT_PROVISIONED:')) {
                oneNoteBlocked = true;
                const cleanMsg = err.message.replace(/^ONENOTE_NOT_PROVISIONED:[^\s]+ — /, '');
                errors.push({ conversation: conv.title, error: cleanMsg });
                dbLog.error(`OneNote not provisioned for ${m365Email} — skipping remaining conversations`);
                emit('error', `  OneNote not provisioned for ${m365Email} — ${cleanMsg}`);
              } else {
                errors.push({ conversation: conv.title, error: err.message });
                dbLog.error(`Page creation failed for "${conv.title}" → ${err.message}`);
                emit('error', `  Failed: ${conv.title?.slice(0, 40)} — ${err.message}`);
              }
            }
          }

          report.addUserResult({ email: m365Email, conversations: conversations.length, pagesCreated, visualAssetsFlagged: (visualReports[gEmail] || []).length, errors });
          await checkpoint.markComplete(gEmail);
          // Mark conversationStore rows as migrated for this user pair
          if (!dry_run) {
            await markUserPairMigrated({ appUserId, uploadId: upload_id, batchId, sourceEmail: gEmail, destEmail: m365Email });
          }
          emit('success', `  Done: ${pagesCreated}/${conversations.length} pages created for ${m365Email}`);
        } catch (err) {
          emit('error', `Fatal error for ${gEmail}: ${err.message}`);
          report.addUserResult({ email: m365Email, conversations: 0, pagesCreated: 0, visualAssetsFlagged: 0, errors: [{ error: err.message }] });
          progressErrors++;
          // Mark conversationStore rows as failed
          if (!dry_run) {
            await markUserPairFailed({ appUserId, uploadId: upload_id, batchId, sourceEmail: gEmail, error: err.message });
          }
        } finally {
          progressUsers++;
          progressPages += pagesCreated;
          conversations = null;
          db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { progressUsers, progressPages, progressErrors, totalUsers: users.length } }
          ).catch(() => {});
          if (jobIds[gEmail]) {
            await db().collection('migrationJobs').updateOne(
              { jobId: jobIds[gEmail] },
              { $set: {
                status: errors.length > 0 ? 'failed' : 'done',
                pages: pagesCreated,
                errors: errors.map(e => ({ page: e.conversation || '', message: e.error || '' })),
                endTime: new Date(),
              } }
            ).catch(() => {});
          }
        }
      });

      // ReportWriter writes JSON to disk then re-reads it; use a per-batch
      // temp file so concurrent migrations don't stomp on each other.
      const reportPath = path.join(uploadsDir, `migration_report_${batch_id}.json`);
      report.write(reportPath);
      const fullReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      fs.unlink(reportPath, () => {});

      const _totalErrors = fullReport.summary?.total_errors || 0;
      // NB: reportWriter writes `users` at the TOP level (not under summary).
      const _reportUsers = Array.isArray(fullReport.users) ? fullReport.users : [];
      const _migratedUsers = _reportUsers.length > 0
        ? _reportUsers.filter(u => u.status === 'success' || u.status === 'partial').length
        : (fullReport.summary?.total_users || 0);
      const _failedUsers = _reportUsers.length > 0
        ? _reportUsers.filter(u => u.status === 'failed').length
        : (_totalErrors > 0 ? 1 : 0);
      // status: completed = at least one user produced pages OR no errors; failed = nobody produced anything but errors exist
      const _finalStatus = (fullReport.summary?.total_pages_created || 0) === 0 && _totalErrors > 0
        ? 'failed'
        : 'completed';
      const reportUpdate = {
        status: _finalStatus, endTime: new Date(),
        totalUsers: fullReport.summary?.total_users || users.length,
        migratedUsers: _migratedUsers,
        failedUsers: _failedUsers,
        totalErrors: _totalErrors,  // ← was missing; reports panel uses this for Success/Partial/Failed badge
        totalConversations: fullReport.summary?.total_conversations || 0,
        // migratedConversations must reflect conversation count (not OneNote page
        // count) so the Reports panel and CSV row match the per-user totals.
        migratedConversations: fullReport.summary?.total_conversations || 0,
        flaggedAssets: fullReport.summary?.total_flagged || Object.values(visualReports || {}).reduce((s, v) => s + (v?.length || 0), 0),
        report: fullReport,
      };

      if (!dry_run) {
        emit('info', '━━━ Deploying Copilot Agent ━━━');
        try {
          const existingG2CDeployment = await db().collection('agentDeployments').findOne({
            appUserId, tenantId: tenant_id, agentName: 'Gemini Conversation Agent',
          });
          const deployer = new AgentDeployer(customer_name, tenant_id, {
            appId: existingG2CDeployment?.appId || undefined,
          }, appUserId);

          let appInfo;
          if (existingG2CDeployment?.catalogId) {
            const updateResult = await deployer.updateAgent(existingG2CDeployment.catalogId);
            if (!updateResult.updated) {
              appInfo = await deployer.deployAgent();
            } else {
              appInfo = { id: existingG2CDeployment.catalogId, alreadyExisted: true, installInstructions: deployer._installInstructions() };
            }
          } else {
            appInfo = await deployer.deployAgent();
          }

          if (appInfo.alreadyExisted) {
            emit('info', `Agent "Gemini Conversation Agent" already exists in catalog — updated`);
          } else {
            emit('success', `Agent "Gemini Conversation Agent" published to Teams catalog (id: ${appInfo.id})`);
          }
          emit('info', appInfo.installInstructions);
          reportUpdate.agentDeployment = { catalogId: appInfo.id, alreadyExisted: appInfo.alreadyExisted };
          await db().collection('agentDeployments').updateOne(
            { appUserId, tenantId: tenant_id, agentName: 'Gemini Conversation Agent' },
            { $set: { batchId, catalogId: appInfo.id, appId: deployer.appId, msEmail, deployedAt: new Date() } },
            { upsert: true }
          );
          dbLog.info(`agentDeployments.upsert — "Gemini Conversation Agent" (catalog id: ${appInfo.id})`);
        } catch (err) {
          emit('warn', `Agent deployment failed (can be done manually): ${err.message}`);
        }
      }

      // Write GemCo/index.json to each target user's OneDrive
      try {
        emit('info', 'Writing conversation index to OneDrive...');
        const indexWriter = new IndexWriter(appUserId);
        const pages = await db().collection('conversationPages').find({
          batchFolder: customer_name,
        }).toArray();

        const byEmail = {};
        for (const p of pages) {
          if (!p.targetEmail || !p.oneNotePageId) continue;
          if (!byEmail[p.targetEmail]) byEmail[p.targetEmail] = [];
          byEmail[p.targetEmail].push({
            title: p.title || 'Untitled',
            pageId: p.oneNotePageId,
            migratedAt: p.migratedAt?.toISOString?.() || new Date().toISOString(),
          });
        }

        for (const [email, conversations] of Object.entries(byEmail)) {
          await indexWriter.writeIndex(email, {
            source: 'Gemini',
            notebookName: `${customer_name} Conversations`,
            sectionName: `${customer_name} Conversations`,
            conversations,
          }).catch(e => logger.warn(`IndexWriter failed for ${email}: ${e.message}`));
        }
        emit('info', 'Conversation index written to OneDrive.');
      } catch (err) {
        emit('warn', `Index write failed (non-fatal): ${err.message}`);
      }

      await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'gemini-copilot', ...reportUpdate } });
      dbLog.info(`migrationWorkspaces.update — batch ${batchId} status=completed (${reportUpdate.migratedConversations} pages, ${reportUpdate.totalUsers} users)`);
      emit('done', `━━━ Migration complete! Reports saved. ━━━`, { batch_id: batchId });
      currentBatchId = null;
      _currentAppUserId = null;
      stopHeartbeat(_heartbeatId);
    } catch (err) {
      console.error('[G2C] Migration failed:', err.message, err.stack);
      emit('error', `Migration failed: ${err.message}`);
      await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'gemini-copilot', status: 'failed', endTime: new Date(), error: err.message } }).catch(() => {});
      dbLog.info(`migrationWorkspaces.update — batch ${batchId} status=failed`);
      currentBatchId = null;
      _currentAppUserId = null;
      stopHeartbeat(_heartbeatId);
    }
    } catch (outerErr) {
      console.error('[G2C] Migration setup failed:', outerErr.message, outerErr.stack);
      emit('error', `Migration setup failed: ${outerErr.message}`);
      await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'gemini-copilot', status: 'failed', endTime: new Date(), error: outerErr.message } }).catch(() => {});
      currentBatchId = null;
      _currentAppUserId = null;
      stopHeartbeat(_heartbeatId);
    }
  }

  // Retry failed conversations
  router.post('/migrate/retry', requireWorkspace, async (req, res) => {
    const { batchId, customer_name } = req.body;
    if (!batchId) return res.status(400).json({ error: 'batchId required' });
    const { appUserId } = getWorkspaceContext(req);
    if (!isAuthenticated(appUserId)) return res.status(401).json({ error: 'Not signed in. Click "Sign in with Microsoft" first.' });

    const batchDoc = await db().collection('migrationWorkspaces').findOne({ _id: batchId, appUserId });
    if (!batchDoc) return res.status(404).json({ error: 'Batch not found' });

    const mappingDoc = await db().collection('userMappings').findOne({ appUserId, migDir: 'gemini-copilot' });
    const uploadDoc = await db().collection('uploads').findOne({ appUserId }, { sort: { uploadTime: -1 } });

    const retryTargets = {};
    for (const u of batchDoc.report?.users || []) {
      if (u.errors?.length > 0) retryTargets[u.email] = u.errors.map(e => e.conversation);
    }

    if (Object.keys(retryTargets).length === 0) return res.json({ started: false, message: 'No failed conversations to retry' });

    const effectiveCustomerName = customer_name || batchDoc.customerName;
    const retryBatchId = `${batchId}_retry_${randomUUID()}`;
    res.json({ started: true, batch_id: retryBatchId, targets: retryTargets });

    const failedEmails = Object.keys(retryTargets);
    if (failedEmails.length > 0) {
      await db().collection('migrationJobs').updateMany(
        { workspaceId: batchId, sourceEmail: { $in: failedEmails } },
        { $set: { status: 'retried', retriedAt: new Date() } }
      ).catch(() => {});
    }

    runRetry({ batchId, retryBatchId, extractPath: uploadDoc?.extractPath, tenantId: batchDoc.tenantId, customerName: effectiveCustomerName, userMappings: mappingDoc?.mappings || {}, retryTargets, appUserId }).catch(e => {
      console.error('[G2C] runRetry unhandled error:', e.message);
    });
  });

  async function runRetry({ batchId, retryBatchId, extractPath, tenantId, customerName, userMappings, retryTargets, appUserId }) {
    logBuffers.set(appUserId, []);
    currentBatchId = retryBatchId;
    _currentAppUserId = appUserId;
    try {
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
    await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { 'report.retry': retryReport, retryAt: new Date() } }).catch(() => {});

    const retried = retryReport.summary.total_pages_created;
    const stillFailing = retryReport.summary.total_errors;
    emit('done', `━━━ Retry complete — ${retried} recovered, ${stillFailing} still failing ━━━`, { batch_id: retryBatchId });
    currentBatchId = null;
    _currentAppUserId = null;
    } catch (retryErr) {
      emit('error', `Retry failed: ${retryErr.message}`);
      currentBatchId = null;
      _currentAppUserId = null;
    }
  }

  // Agent Chat
  router.post('/chat', (req, res, next) => {
    if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
    next();
  }, async (req, res) => {
    const { message, migrationState = {}, migrationLogs = [], isSystemTrigger = false } = req.body;
    const appUserName = req.session.appUser?.name || req.session.appUser?.email?.split('@')[0] || 'there';
    if (!message) return res.status(400).json({ error: 'message required' });

    // Build migration executors as local closures (not stored in session — functions can't be serialized)
    const agentDeps = {
      startMigration: async ({ dryRun, batchId, migDir: dir, appUserId: uid }) => {
        // Validate preconditions only — UI handles the actual migration trigger and SSE connection
        if (dir === 'gemini-copilot') {
          const uploadDoc = await db().collection('uploads').findOne({ appUserId: uid }, { sort: { uploadTime: -1 } });
          const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: 'gemini-copilot' });
          if (!uploadDoc) return { error: 'No Gemini export uploaded. Upload your takeout ZIP first.' };
          if (!mappingDoc || !Object.keys(mappingDoc.mappings || {}).length) return { error: 'No user mappings for Gemini→Copilot. Map users first.' };
          return { validated: true, batchId, note: 'UI will start migration and connect to log stream' };
        }
        if (dir === 'copilot-gemini') {
          const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: 'copilot-gemini' });
          if (!mappingDoc || !Object.keys(mappingDoc.mappings || {}).length) return { error: 'No user mappings for Copilot→Gemini. Map users first.' };
          return { validated: true, batchId, note: 'UI will start migration and connect to log stream' };
        }
        if (dir === 'claude-gemini') {
          const uploadDoc = await db().collection('cl2gUploads').findOne({ appUserId: uid }, { sort: { uploadTime: -1 } });
          const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: 'claude-gemini' });
          if (!uploadDoc) return { error: 'No Claude export ZIP uploaded. Upload your export first.' };
          if (!mappingDoc || !Object.keys(mappingDoc.mappings || {}).length) return { error: 'No user mappings for Claude→Gemini. Map users first.' };
          return { validated: true, batchId, note: 'UI will start migration and connect to log stream' };
        }
        return Promise.resolve({ validated: true, note: `${dir} migration will be started by UI` });
      },
      retryMigration: async ({ batchId: retryFromBatchId, appUserId: uid }) => {
        const batchDoc = await db().collection('migrationWorkspaces').findOne({ _id: retryFromBatchId, appUserId: uid });
        if (!batchDoc) return { error: 'Batch not found' };
        // Retry only supports gemini-copilot today; reject other directions explicitly
        const batchDir = batchDoc.migDir || 'gemini-copilot';
        if (batchDir !== 'gemini-copilot') {
          return { error: `Retry not yet supported for ${batchDir} migrations. Run another batch instead.` };
        }
        const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: batchDir });
        const uploadDoc = await db().collection('uploads').findOne({ appUserId: uid }, { sort: { uploadTime: -1 } });
        const retryTargets = {};
        for (const u of batchDoc.report?.users || []) {
          if (u.errors?.length > 0) retryTargets[u.email] = u.errors.map(e => e.conversation);
        }
        if (Object.keys(retryTargets).length === 0) return { started: false, message: 'No failed items to retry' };
        const retryBatchId = `${retryFromBatchId}_retry_${randomUUID()}`;
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
      migrationState: { ...migrationState, appUserName },
      migrationLogs,
      isSystemTrigger: isSystemTrigger || message === '__step_context__',
      db: db(),
      agentDeps,
    });
  });

  // ─── Audit routes (internal monitor tool — no auth required) ─────────────────

  // GET /audit/sessions — 50 most recent sessions with summary fields
  router.get('/audit/sessions', async (req, res) => {
    try {
      const sessions = await db().collection('agentAuditLog').aggregate([
        { $sort: { ts: -1 } },
        { $group: {
          _id: '$sessionId',
          firstTs: { $last: '$ts' },
          lastTs: { $first: '$ts' },
          appUserId: { $first: '$appUserId' },
          step: { $last: '$step' },
          migDir: { $last: '$migDir' },
          messageSnippet: { $last: '$message' },
          eventCount: { $sum: 1 },
        }},
        { $sort: { lastTs: -1 } },
        { $limit: 50 },
        { $project: { sessionId: '$_id', _id: 0, firstTs: 1, lastTs: 1, appUserId: 1, step: 1, migDir: 1, messageSnippet: 1, eventCount: 1 } },
      ]).toArray();
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /audit/session/:id — all events for a session, sorted ascending
  router.get('/audit/session/:id', async (req, res) => {
    try {
      const events = await db().collection('agentAuditLog')
        .find({ sessionId: req.params.id })
        .sort({ ts: 1 })
        .toArray();
      res.json(events);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /audit/stream — SSE fan-out of live audit events
  router.get('/audit/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onEvent = (event) => {
      if (!res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          res.flush?.();
        } catch (_) {}
      }
    };
    auditEmitter.on('event', onEvent);

    req.on('close', () => {
      auditEmitter.off('event', onEvent);
    });
  });

  router.executeG2CMigration = executeG2CMigration;

  return router;
}
