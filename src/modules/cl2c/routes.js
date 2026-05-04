/**
 * CL2C (Claude → Copilot/OneNote) routes — mounted at /api/cl2c.
 * Mirrors cl2g/routes.js but uploads Claude conversations to Microsoft OneNote
 * using the delegated MS token (same auth already used by G2C).
 */

import express  from 'express';
import multer   from 'multer';
import fs       from 'node:fs';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter }  from 'events';
import { getLogger }     from '../../utils/logger.js';
import { getTenantForUser } from '../../core/auth/microsoft.js';

const dbLog    = getLogger('db:cl2c');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.resolve(__dirname, '../../../');

export function createCL2CRouter({ db, isAuthenticated, getValidToken, getCurrentTenantId }) {
  const router = express.Router();

  const uploadsDir = path.join(ROOT_DIR, 'uploads', 'cl2c');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
      else cb(new Error('Only ZIP files are accepted'));
    },
  });

  function uploadMiddleware(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      next();
    });
  }

  const cl2cLogEmitter = new EventEmitter();
  cl2cLogEmitter.setMaxListeners(50);

  function cl2cLog(type, message) {
    cl2cLogEmitter.emit('log', { type, message, ts: new Date().toISOString() });
  }

  function requireAuth(req, res, next) {
    if (req.session?.appUser) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  function requireMsAuth(req, res, next) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    if (!appUserId || !isAuthenticated(appUserId)) {
      return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
    }
    next();
  }

  function getCtx(req) {
    return {
      appUserId: req.session?.appUser?._id?.toString() || null,
      msEmail:   req.session?.msEmail || null,
    };
  }

  // ── GET /api/cl2c/migrate-log ─────────────────────────────────────────────
  router.get('/migrate-log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = d => {
      res.write(`data: ${JSON.stringify(d)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    };

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    }, 10000);

    const handler = d => send(d);
    cl2cLogEmitter.on('log', handler);
    req.on('close', () => {
      cl2cLogEmitter.off('log', handler);
      clearInterval(heartbeat);
    });
  });

  // ── POST /api/cl2c/upload ─────────────────────────────────────────────────
  router.post('/upload', requireAuth, uploadMiddleware, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { appUserId, msEmail } = getCtx(req);
    const uploadId   = `cl2c_${Date.now()}`;
    const extractDir = path.join(uploadsDir, uploadId);

    try {
      fs.mkdirSync(extractDir, { recursive: true });

      const { extractZip, parseClaudeExport } = await import('../cl2g/zipParser.js');
      await extractZip(req.file.path, extractDir);
      fs.unlink(req.file.path, () => {});

      const parsed = parseClaudeExport(extractDir);

      const doc = {
        _id:                uploadId,
        appUserId,
        msEmail,
        fileName:           req.file.originalname,
        extractPath:        extractDir,
        uploadTime:         new Date(),
        totalConversations: parsed.totalConversations,
        totalMemories:      parsed.totalMemories,
        totalProjects:      parsed.totalProjects,
        users:              parsed.users,
        status:             'ready',
      };

      await db().collection('cl2cUploads').insertOne(doc);
      dbLog.info(`cl2cUploads.insert — ${uploadId} (${parsed.users.length} users, ${parsed.totalConversations} convs)`);

      res.json({ uploadId, users: parsed.users, totalConversations: parsed.totalConversations, totalMemories: parsed.totalMemories, totalProjects: parsed.totalProjects });
    } catch (err) {
      fs.rm(extractDir, { recursive: true, force: true }, () => {});
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/cl2c/uploads ─────────────────────────────────────────────────
  router.get('/uploads', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const uploads = await db().collection('cl2cUploads')
        .find({ appUserId })
        .sort({ uploadTime: -1 })
        .toArray();

      const staleIds = uploads
        .filter(u => u.extractPath && !fs.existsSync(u.extractPath))
        .map(u => u._id);
      if (staleIds.length) {
        await db().collection('cl2cUploads').deleteMany({ _id: { $in: staleIds } });
        dbLog.info(`cl2cUploads.purge — removed ${staleIds.length} stale record(s)`);
      }

      res.json(uploads.filter(u => !staleIds.includes(u._id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/cl2c/uploads/:id ─────────────────────────────────────────
  router.delete('/uploads/:id', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('cl2cUploads').findOne({ _id: req.params.id, appUserId });
      if (!doc) return res.status(404).json({ error: 'Upload not found' });
      if (doc.extractPath) fs.rm(doc.extractPath, { recursive: true, force: true }, () => {});
      await db().collection('cl2cUploads').deleteOne({ _id: req.params.id, appUserId });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/cl2c/user-mappings ───────────────────────────────────────────
  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('userMappings').findOne({ direction: 'claude-copilot', appUserId });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2c/user-mappings ──────────────────────────────────────────
  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId, msEmail } = getCtx(req);
      const { mappings, csvEmails } = req.body;
      await db().collection('userMappings').updateOne(
        { direction: 'claude-copilot', appUserId },
        { $set: { direction: 'claude-copilot', appUserId, msEmail, mappings, csvEmails, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      dbLog.info(`userMappings.upsert — CL2C ${Object.keys(mappings || {}).length} mappings`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/cl2c/user-mappings ────────────────────────────────────────
  router.delete('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      await db().collection('userMappings').deleteOne({ direction: 'claude-copilot', appUserId });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2c/migrate ────────────────────────────────────────────────
  router.post('/migrate', requireAuth, requireMsAuth, async (req, res) => {
    try {
      const { appUserId, msEmail } = getCtx(req);
      const { pairs, uploadId, folderName, dryRun, fromDate, toDate, includeMemory, includeProjects } = req.body;

      if (!pairs?.length)  return res.status(400).json({ error: 'No user pairs provided' });
      if (!uploadId)       return res.status(400).json({ error: 'No uploadId provided' });

      const uploadDoc = await db().collection('cl2cUploads').findOne({ _id: uploadId, appUserId });
      if (!uploadDoc) return res.status(404).json({ error: 'Upload not found' });

      const isDryRun   = dryRun === true;
      const cl2cFolder = folderName || 'ClaudeChats';
      const batchId    = `cl2c_${Date.now()}`;
      const startTime  = new Date();

      res.json({ started: true, batchId });

      setImmediate(async () => {
        let files = 0, errors = 0;

        try {
          await db().collection('reportsWorkspace').updateOne(
            { _id: batchId },
            { $set: { direction: 'claude-copilot', customerName: cl2cFolder, startTime, status: 'running', dryRun: isDryRun, appUserId, msEmail, totalUsers: pairs.length } },
            { upsert: true }
          );

          if (!uploadDoc.extractPath || !fs.existsSync(uploadDoc.extractPath)) {
            const msg = `Upload files not found on disk (${uploadDoc.extractPath}). The server may have restarted and lost the uploaded ZIP. Please re-upload the ZIP file and try again.`;
            dbLog.error(`[CL2C] ${msg}`);
            cl2cLog('error', msg);
            await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: msg } }).catch(() => {});
            cl2cLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          const { migrateUserPair } = await import('./migration/migrate.js');
          const reportUsers = [];

          dbLog.info(`[CL2C] Starting ${isDryRun ? 'dry run' : 'migration'} — ${pairs.length} user(s), uploadId=${uploadId}`);
          cl2cLog('info', `Starting CL2C ${isDryRun ? 'dry run' : 'migration'} for ${pairs.length} user(s)...`);
          cl2cLog('total', JSON.stringify({ total: pairs.length }));

          for (const pair of pairs) {
            cl2cLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destEmail}`);

            if (isDryRun) {
              const { getUserData } = await import('../cl2g/zipParser.js');
              const { conversations, memory, projects } = getUserData(uploadDoc.extractPath, pair.sourceUuid);

              // Apply same date filter as live migration
              let filteredConvs = conversations;
              if (fromDate || toDate) {
                const from = fromDate ? new Date(fromDate) : null;
                const to   = toDate   ? new Date(toDate + 'T23:59:59Z') : null;
                filteredConvs = conversations.filter(c => {
                  const d = new Date(c.created_at);
                  if (from && d < from) return false;
                  if (to   && d > to)   return false;
                  return true;
                });
              }

              const validProjects  = projects.filter(p => p.name || p.docs?.length);
              const hasMemoryPage  = includeMemory  !== false && !!memory?.conversations_memory;
              const hasProjectPage = includeProjects !== false && validProjects.length > 0;
              const dryPages = filteredConvs.length + (hasMemoryPage ? 1 : 0) + (hasProjectPage ? 1 : 0);

              cl2cLog('info', `  ${pair.sourceDisplayName}: ${filteredConvs.length} conversations → ${filteredConvs.length} pages${hasMemoryPage ? ' + memory page' : ''}${hasProjectPage ? ' + projects page' : ''}`);
              reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: pair.sourceDisplayName, status: 'success', pages_created: dryPages, conversations_processed: filteredConvs.length, error_count: 0, errors: [] });
              files += dryPages;
              continue;
            }

            const r = await migrateUserPair(
              { sourceUuid: pair.sourceUuid, sourceDisplayName: pair.sourceDisplayName, destUserEmail: pair.destEmail, extractPath: uploadDoc.extractPath, appUserId },
              { folderName: cl2cFolder, fromDate, toDate, includeMemory, includeProjects }
            );

            const status = r.errors?.length ? (r.filesUploaded > 0 ? 'partial' : 'failed') : 'success';
            reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: r.sourceDisplayName, status, pages_created: r.filesUploaded, conversations_processed: r.conversationsCount, error_count: r.errors.length, errors: r.errors.map(e => ({ error_message: e })), files: r.files });

            if (r.errors.length) r.errors.forEach(e => { cl2cLog('warn', e); dbLog.warn(`[CL2C] ${r.sourceDisplayName}: ${e}`); });
            files  += r.filesUploaded;
            errors += r.errors.length;
            dbLog.info(`[CL2C] ${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} pages created, ${r.errors.length} error(s)`);
            cl2cLog(status === 'failed' ? 'warn' : 'success', `${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} pages, ${r.errors.length} error(s)`);
            cl2cLog('progress', JSON.stringify({ files, errors, users: reportUsers.length, total: pairs.length }));
          }

          const finalStatus = errors > 0 && files === 0 ? 'failed' : 'completed';

          // Isolated final DB write
          try {
            await db().collection('reportsWorkspace').updateOne(
              { _id: batchId },
              { $set: { status: finalStatus, endTime: new Date(), migratedConversations: files, migratedUsers: reportUsers.filter(u => u.status !== 'failed').length, failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors, report: { summary: { total_users: pairs.length, total_pages_created: files, total_errors: errors }, users: reportUsers } } }
            );
          } catch (dbErr) {
            dbLog.error(`[CL2C] Final report DB write failed: ${dbErr.message}. Retrying...`);
            await db().collection('reportsWorkspace').updateOne(
              { _id: batchId },
              { $set: { status: finalStatus, endTime: new Date(), migratedConversations: files, migratedUsers: reportUsers.filter(u => u.status !== 'failed').length, failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors, report: { summary: { total_users: pairs.length, total_pages_created: files, total_errors: errors }, users: reportUsers } } }
            ).catch(e2 => dbLog.error(`[CL2C] Retry also failed: ${e2.message}`));
          }

          // Deploy Claude Conversation Agent (once per tenant)
          if (!isDryRun) {
            cl2cLog('info', 'Deploying Claude Conversation Agent to Teams catalog...');
            try {
              const { AgentDeployer } = await import('../../agent/agentDeployer.js');
              // Resolve tenantId from the user's live session (reliable per-domain)
              const tenantId = await getTenantForUser(appUserId)
                || (typeof getCurrentTenantId === 'function' ? getCurrentTenantId() : null)
                || process.env.AZURE_TENANT_ID;
              if (!tenantId) {
                cl2cLog('warn', 'Could not determine tenant ID — agent deployment skipped.');
              } else {
                const deployer = new AgentDeployer(cl2cFolder, tenantId, {
                  agentName: 'Claude Conversation Agent',
                  sourceLabel: 'Claude',
                  notebookName: cl2cFolder,
                  sectionName: `${cl2cFolder} Conversations`,
                }, appUserId);
                const appInfo = await deployer.deployAgent();
                if (appInfo.alreadyExisted) {
                  cl2cLog('info', `Claude Conversation Agent already exists in catalog for tenant ${tenantId} — skipping publish`);
                } else {
                  cl2cLog('success', `Claude Conversation Agent published to Teams catalog for tenant ${tenantId}`);
                }
                cl2cLog('info', appInfo.installInstructions);
                // Key by tenantId so each domain gets its own deployment record
                await db().collection('agentDeployments').updateOne(
                  { appUserId, tenantId, agentName: 'Claude Conversation Agent' },
                  { $set: { batchId, msEmail, catalogId: appInfo.id, deployedAt: new Date() } },
                  { upsert: true }
                ).catch(() => {});
              }
            } catch (agentErr) {
              cl2cLog('warn', `Agent deployment failed (can be done manually): ${agentErr.message}`);
            }
          }

          cl2cLog('done', JSON.stringify({ files, errors, users: pairs.length, batchId }));

        } catch (e) {
          console.error('[CL2C] Unhandled error:', e);
          dbLog.error(`[CL2C] Unhandled error after ${files} page(s) created: ${e.message}`);
          cl2cLog('error', e.message || String(e));
          await db().collection('reportsWorkspace').updateOne(
            { _id: batchId },
            { $set: { status: files > 0 ? 'completed' : 'failed', endTime: new Date(), migratedConversations: files, totalErrors: errors + 1, error: e.message } }
          ).catch(() => {});
          cl2cLog('done', JSON.stringify({ files, errors: errors + 1, users: pairs.length, batchId }));
        }
      });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
