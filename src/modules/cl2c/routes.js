/**
 * CL2C (Claude → Copilot/OneNote) routes — mounted at /api/cl2c.
 * Mirrors cl2g/routes.js but uploads Claude conversations to Microsoft OneNote
 * using the delegated MS token (same auth already used by G2C).
 */

import express  from 'express';
import multer   from 'multer';
import fs       from 'node:fs';
import os       from 'node:os';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter }  from 'events';
import { getLogger }     from '../../utils/logger.js';
import { getTenantForUser } from '../../core/auth/microsoft.js';
import { IndexWriter } from '../../agent/indexWriter.js';

const dbLog    = getLogger('db:cl2c');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.resolve(__dirname, '../../../');

export function createCL2CRouter({ db, isAuthenticated, getValidToken, getCurrentTenantId }) {
  const router = express.Router();

  // Multer scratch space — OS temp dir. The raw ZIP and the extracted JSONs
  // live here only for the few seconds it takes to parse them into
  // conversationStore, then both are deleted. The project's old uploads/
  // folder is no longer used.
  const uploadsDir = path.join(os.tmpdir(), 'gemco-cl2c');
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

      // Persist all Claude conversations to conversationStore at upload time.
      // This is FATAL — if it fails we don't keep the upload because the disk
      // extract is about to be deleted (we're moving to DB-only storage).
      const ingestBatchId = `ingest_${uploadId}`;
      let totalPersisted = 0;
      const { getUserData } = await import('../cl2g/zipParser.js');
      const { persistSourceConversations, SOURCE_TYPE } = await import('../_shared/conversationStore.js');
      for (const u of parsed.users) {
        const { conversations: userConvs } = getUserData(extractDir, u.uuid);
        if (!userConvs?.length) continue;
        const r = await persistSourceConversations(
          {
            batchId: ingestBatchId,
            appUserId,
            migDir: 'claude-copilot',
            sourceType: SOURCE_TYPE.CLAUDE,
            sourceEmail: u.email_address,
            sourceUserId: u.uuid,
            sourceDisplayName: u.full_name || u.name,
            uploadId,
          },
          userConvs.map(c => ({
            sessionId: c.uuid || c.id || `${u.uuid}::${c.name || 'untitled'}`,
            title: c.name || c.title || 'Untitled',
            createdDateTime: c.created_at || c.createdDateTime,
            payload: c,
          }))
        );
        totalPersisted += r.inserted;
      }
      dbLog.info(`conversationStore.upsert — ${totalPersisted} Claude conversations persisted at upload time for ${req.file.originalname}`);

      // DB now has every conversation. Delete the disk extract so the uploads/
      // folder doesn't grow indefinitely. Memory + project documents that
      // existed only on disk are intentionally dropped — see scope decision.
      fs.rm(extractDir, { recursive: true, force: true }, (err) => {
        if (err) dbLog.warn(`Failed to clean up extractDir ${extractDir}: ${err.message}`);
        else dbLog.info(`extractDir cleaned: ${extractDir}`);
      });

      const now = new Date();
      const doc = {
        _id:                uploadId,
        appUserId,
        msEmail,
        fileName:           req.file.originalname,
        // No extractPath — disk content has been deleted; migration reads
        // exclusively from conversationStore.
        ingestBatchId,
        conversationsPersisted: totalPersisted,
        uploadTime:         now,
        lastActiveAt:       now,
        totalConversations: parsed.totalConversations,
        users:              parsed.users,
        status:             'ready',
      };

      await db().collection('claudeUploads').insertOne(doc);
      dbLog.info(`claudeUploads.insert — ${uploadId} (${parsed.users.length} users, ${parsed.totalConversations} convs, ${totalPersisted} in conversationStore)`);

      res.json({ uploadId, users: parsed.users, totalConversations: parsed.totalConversations, conversations_persisted: totalPersisted, ingest_batch_id: ingestBatchId });
    } catch (err) {
      fs.rm(extractDir, { recursive: true, force: true }, () => {});
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/cl2c/uploads ─────────────────────────────────────────────────
  // Sorted by lastActiveAt DESC so the user's last-selected (or last-uploaded)
  // ZIP is index 0 — that's what the App-level mount restore picks. Falls
  // back to uploadTime for legacy rows without lastActiveAt.
  router.get('/uploads', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const uploads = await db().collection('claudeUploads')
        .find({ appUserId })
        .sort({ lastActiveAt: -1, uploadTime: -1 })
        .toArray();

      const staleIds = uploads
        .filter(u => u.extractPath && !fs.existsSync(u.extractPath) && !u.conversationsPersisted)
        .map(u => u._id);
      if (staleIds.length) {
        await db().collection('claudeUploads').deleteMany({ _id: { $in: staleIds } });
        dbLog.info(`claudeUploads.purge — removed ${staleIds.length} legacy record(s) with no disk + no DB content`);
      }

      res.json(uploads.filter(u => !staleIds.includes(u._id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2c/uploads/:id/activate ────────────────────────────────────
  router.post('/uploads/:id/activate', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const r = await db().collection('claudeUploads').updateOne(
        { _id: req.params.id, appUserId },
        { $set: { lastActiveAt: new Date() } }
      );
      if (r.matchedCount === 0) return res.status(404).json({ error: 'Upload not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/cl2c/uploads/:id ─────────────────────────────────────────
  router.delete('/uploads/:id', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('claudeUploads').findOne({ _id: req.params.id, appUserId });
      if (!doc) return res.status(404).json({ error: 'Upload not found' });
      if (doc.extractPath) fs.rm(doc.extractPath, { recursive: true, force: true }, () => {});
      await db().collection('claudeUploads').deleteOne({ _id: req.params.id, appUserId });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/cl2c/user-mappings ───────────────────────────────────────────
  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('userMappings').findOne({ migDir: 'claude-copilot', appUserId });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2c/user-mappings ──────────────────────────────────────────
  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId, msEmail } = getCtx(req);
      const { mappings, csvEmails } = req.body;
      await db().collection('userMappings').updateOne(
        { migDir: 'claude-copilot', appUserId },
        { $set: { migDir: 'claude-copilot', appUserId, msEmail, mappings, csvEmails, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
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
      await db().collection('userMappings').deleteOne({ migDir: 'claude-copilot', appUserId });
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

      const uploadDoc = await db().collection('claudeUploads').findOne({ _id: uploadId, appUserId });
      if (!uploadDoc) return res.status(404).json({ error: 'Upload not found' });

      const batchId    = `cl2c_${Date.now()}`;
      const startTime  = new Date();
      const resumeContext = {
        kind: 'cl2c',
        appUserId, msEmail,
        pairs, uploadId, folderName, dryRun, fromDate, toDate, includeMemory, includeProjects,
      };

      res.json({ started: true, batchId });

      setImmediate(() => executeCL2CMigration({ batchId, startTime, resumeContext, isResume: false }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function executeCL2CMigration({ batchId, startTime, resumeContext, isResume }) {
    const { appUserId, msEmail, pairs, uploadId, folderName, dryRun, fromDate, toDate, includeMemory, includeProjects } = resumeContext;
    const isDryRun   = dryRun === true;
    const cl2cFolder = folderName || 'ClaudeChats';

    const uploadDoc = await db().collection('claudeUploads').findOne({ _id: uploadId, appUserId });
    if (!uploadDoc) {
      dbLog.error(`[CL2C] Upload ${uploadId} not found on ${isResume ? 'resume' : 'start'} — aborting batch ${batchId}`);
      await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: 'Upload doc missing' } }).catch(() => {});
      return;
    }

    {
        let files = 0, errors = 0;
        // Declared at function scope so the catch handler can reference it.
        let reportUsers = [];
        const { startHeartbeat, stopHeartbeat, markUserPairMigrated, markUserPairFailed } = await import('../_shared/conversationStore.js');
        let _heartbeatId = null;

        try {
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { migDir: 'claude-copilot', customerName: cl2cFolder, startTime, status: 'running', dryRun: isDryRun, appUserId, msEmail, fromDate: fromDate || null, toDate: toDate || null, totalUsers: pairs.length, lastHeartbeat: new Date(), resumeContext, ...(isResume ? { resumedAt: new Date() } : {}) } },
            { upsert: true }
          );
          _heartbeatId = startHeartbeat(batchId);

          // After the DB-only refactor, new uploads have no disk extract —
          // conversations live in conversationStore. Only block if BOTH are
          // missing. Either source is sufficient to migrate from.
          const hasDiskExtract = uploadDoc.extractPath && fs.existsSync(uploadDoc.extractPath);
          const dbConvCount = await db().collection('conversationStore')
            .countDocuments({ uploadId, appUserId });
          if (!hasDiskExtract && dbConvCount === 0) {
            const msg = `Upload has no data — no disk extract AND no conversations in DB. Re-upload the ZIP.`;
            dbLog.error(`[CL2C] ${msg}`);
            cl2cLog('error', msg);
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: msg } }).catch(() => {});
            cl2cLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          const { migrateUserPair } = await import('./migration/migrate.js');
          // reportUsers declared at function scope above; reset for this run
          reportUsers.length = 0;

          dbLog.info(`[CL2C] Starting ${isDryRun ? 'dry run' : 'migration'} — ${pairs.length} user(s), uploadId=${uploadId}`);
          cl2cLog('info', `Starting CL2C ${isDryRun ? 'dry run' : 'migration'} for ${pairs.length} user(s)...`);
          cl2cLog('total', JSON.stringify({ total: pairs.length }));

          // Pre-flight validator (only on dry-run; additive)
          if (isDryRun) {
            try {
              const { runDryRunValidator } = await import('../dry-run/validator.js');
              const dryRunReport = await runDryRunValidator({
                migDir: 'claude-copilot',
                pairs: pairs.map(p => ({ sourceEmail: p.sourceEmail, sourceUuid: p.sourceUuid, destEmail: p.destEmail, expectedConversationCount: p.conversationCount || 0 })),
                config: { folderName: cl2cFolder, dryRun: true },
                appUserId, msEmail,
                msAccountId: req.body?.msAccountId || null,
                uploadData: uploadDoc,
              });
              await db().collection('migrationWorkspaces').updateOne(
                { _id: batchId },
                { $set: { dryRunReport } }
              ).catch(() => {});
              cl2cLog('info', `Dry-run validator: ${dryRunReport.summary.ready} ready · ${dryRunReport.summary.warning} warning · ${dryRunReport.summary.blocker} blocker`);
            } catch (e) {
              cl2cLog('warn', `Dry-run validator failed: ${e.message}`);
            }
          }

          for (const pair of pairs) {
            cl2cLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destEmail}`);

            if (isDryRun) {
              // Count conversations: prefer DB (post-refactor), fall back to
              // disk for legacy uploads. Memory/projects dropped after
              // the DB-only refactor (they lived only on disk).
              let convCount = 0;
              const hasDisk = uploadDoc.extractPath && fs.existsSync(uploadDoc.extractPath);
              if (hasDisk) {
                try {
                  const { getUserData } = await import('../cl2g/zipParser.js');
                  const { conversations } = getUserData(uploadDoc.extractPath, pair.sourceUuid);
                  let filtered = conversations;
                  if (fromDate || toDate) {
                    const from = fromDate ? new Date(fromDate) : null;
                    const to   = toDate   ? new Date(toDate + 'T23:59:59Z') : null;
                    filtered = conversations.filter(c => {
                      const d = new Date(c.created_at);
                      if (from && d < from) return false;
                      if (to   && d > to)   return false;
                      return true;
                    });
                  }
                  convCount = filtered.length;
                } catch (e) { cl2cLog('warn', `getUserData failed for ${pair.sourceEmail}: ${e.message}`); }
              } else {
                convCount = await db().collection('conversationStore').countDocuments({
                  uploadId, appUserId, sourceEmail: pair.sourceEmail,
                });
              }

              cl2cLog('info', `  ${pair.sourceDisplayName}: ${convCount} conversation${convCount===1?'':'s'} → ${convCount} OneNote page${convCount===1?'':'s'}`);
              reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: pair.sourceDisplayName, status: 'success', pages_created: convCount, conversations_processed: convCount, migrated_conversations: convCount, files_uploaded: 0, error_count: 0, errors: [] });
              files += convCount;
              // Emit progress so the UI sees the real conversation count
              // during dry-run (not just the file count).
              const cumulativeConvs = reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0);
              cl2cLog('progress', JSON.stringify({ files, convs: cumulativeConvs, errors, users: reportUsers.length, total: pairs.length }));
              continue;
            }

            const r = await migrateUserPair(
              { sourceUuid: pair.sourceUuid, sourceDisplayName: pair.sourceDisplayName, destUserEmail: pair.destEmail, extractPath: uploadDoc.extractPath, appUserId, uploadId, sourceEmail: pair.sourceEmail },
              { folderName: cl2cFolder, fromDate, toDate, includeMemory, includeProjects, isResume }
            );

            // Note: conversations already persisted to conversationStore at upload time.

            const status = r.errors?.length ? (r.filesUploaded > 0 ? 'partial' : 'failed') : 'success';
            // CL2C creates one OneNote page per conversation; r.filesUploaded
            // == pages == migrated conversations. files_uploaded counts
            // attachment files (images, PDFs) uploaded alongside, NOT pages.
            const _attachmentCount = r.attachmentsUploaded || 0;
            reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: r.sourceDisplayName, status, pages_created: r.filesUploaded, conversations_processed: r.conversationsCount, migrated_conversations: r.filesUploaded, files_uploaded: _attachmentCount, error_count: r.errors.length, errors: r.errors.map(e => ({ error_message: e })), files: r.files });

            // Mark conversationStore rows
            if (status === 'failed') {
              await markUserPairFailed({ appUserId, uploadId, batchId, sourceEmail: pair.sourceEmail, error: r.errors[0] || 'unknown' });
            } else {
              await markUserPairMigrated({ appUserId, uploadId, batchId, sourceEmail: pair.sourceEmail, destEmail: pair.destEmail });
            }

            if (r.errors.length) r.errors.forEach(e => { cl2cLog('warn', e); dbLog.warn(`[CL2C] ${r.sourceDisplayName}: ${e}`); });
            files  += r.filesUploaded;
            errors += r.errors.length;
            dbLog.info(`[CL2C] ${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} pages created, ${r.errors.length} error(s)`);
            cl2cLog(status === 'failed' ? 'warn' : 'success', `${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} pages, ${r.errors.length} error(s)`);
            const cumulativeConvs = reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0);
            cl2cLog('progress', JSON.stringify({ files, convs: cumulativeConvs, errors, users: reportUsers.length, total: pairs.length }));

            // Incremental progress write — Reports polling sees live progress.
            await db().collection('migrationWorkspaces').updateOne(
              { _id: batchId },
              {
                $set: {
                  progressUsers: reportUsers.length,
                  progressPages: files,
                  progressConversations: reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0),
                  progressErrors: errors,
                  users: reportUsers,
                  lastProgressAt: new Date(),
                },
              }
            ).catch(() => {});
          }

          const finalStatus = errors > 0 && files === 0 ? 'failed' : 'completed';

          // Isolated final DB write
          const totalConvsSum = reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0);
          const finalUpdate = { migDir: 'claude-copilot', status: finalStatus, endTime: new Date(), migratedConversations: totalConvsSum, migratedUsers: reportUsers.filter(u => u.status !== 'failed').length, failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors, report: { summary: { total_users: pairs.length, total_pages_created: files, total_errors: errors, total_conversations: totalConvsSum }, users: reportUsers } };
          try {
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: finalUpdate });
          } catch (dbErr) {
            dbLog.error(`[CL2C] Final report DB write failed: ${dbErr.message}. Retrying...`);
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: finalUpdate })
              .catch(e2 => dbLog.error(`[CL2C] Retry also failed: ${e2.message}`));
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
                const existingDeployment = await db().collection('agentDeployments').findOne({
                  appUserId: appUserId, tenantId, agentName: 'Claude Conversation Agent',
                });
                const deployer = new AgentDeployer(cl2cFolder, tenantId, {
                  agentName: 'Claude Conversation Agent',
                  sourceLabel: 'Claude',
                  notebookName: cl2cFolder,
                  sectionName: `${cl2cFolder} Conversations`,
                  appId: existingDeployment?.appId || undefined, // reuse stored GUID
                }, appUserId);

                let appInfo;
                if (existingDeployment?.catalogId) {
                  const updateResult = await deployer.updateAgent(existingDeployment.catalogId);
                  if (!updateResult.updated) {
                    appInfo = await deployer.deployAgent();
                  } else {
                    appInfo = { id: existingDeployment.catalogId, alreadyExisted: true, installInstructions: '' };
                  }
                } else {
                  appInfo = await deployer.deployAgent();
                }
                if (appInfo.alreadyExisted) {
                  cl2cLog('info', `Claude Conversation Agent already exists in catalog for tenant ${tenantId} — skipping publish`);
                } else {
                  cl2cLog('success', `Claude Conversation Agent published to Teams catalog for tenant ${tenantId}`);
                }
                cl2cLog('info', appInfo.installInstructions);
                // Key by tenantId so each domain gets its own deployment record
                await db().collection('agentDeployments').updateOne(
                  { appUserId, tenantId, agentName: 'Claude Conversation Agent' },
                  { $set: { batchId, msEmail, catalogId: appInfo.id, appId: deployer.appId, deployedAt: new Date() } },
                  { upsert: true }
                ).catch(() => {});
              }
            } catch (agentErr) {
              cl2cLog('warn', `Agent deployment failed (can be done manually): ${agentErr.message}`);
            }
          }

          // Write GemCo/index.json to each target user's OneDrive (non-fatal)
          if (!isDryRun) {
            try {
              const indexWriter = new IndexWriter(appUserId);
              const pages = await db().collection('conversationPages').find({
                provider: 'claude',
                batchFolder: cl2cFolder,
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
                  source: 'Claude',
                  notebookName: cl2cFolder,
                  sectionName: `${cl2cFolder} Conversations`,
                  conversations,
                }).catch(() => {});
              }
            } catch {}
          }

          cl2cLog('done', JSON.stringify({ files, errors, users: pairs.length, batchId }));

        } catch (e) {
          console.error('[CL2C] Unhandled error:', e);
          dbLog.error(`[CL2C] Unhandled error after ${files} page(s) created: ${e.message}`);
          cl2cLog('error', e.message || String(e));
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { migDir: 'claude-copilot', status: files > 0 ? 'completed' : 'failed', endTime: new Date(), migratedConversations: reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0) || files, totalErrors: errors + 1, error: e.message } }
          ).catch(() => {});
          cl2cLog('done', JSON.stringify({ files, errors: errors + 1, users: pairs.length, batchId }));
        } finally {
          stopHeartbeat(_heartbeatId);
        }
      }
  }

  router.executeCL2CMigration = executeCL2CMigration;

  return router;
}
