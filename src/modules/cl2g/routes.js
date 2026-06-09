/**
 * CL2G (Claude → Gemini) routes — mounted at /api/cl2g.
 * Completely self-contained; does not touch any existing module.
 */

import express  from 'express';
import multer   from 'multer';
import fs       from 'node:fs';
import os       from 'node:os';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter }  from 'events';
import { getLogger }     from '../../utils/logger.js';

const dbLog    = getLogger('db:cl2g');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.resolve(__dirname, '../../../');

export function createCL2GRouter({ db }) {
  const router = express.Router();

  // Multer scratch space — OS temp dir. The raw ZIP and the extracted JSONs
  // live here only for the few seconds it takes to parse them into
  // conversationStore, then both are deleted.
  const uploadsDir = path.join(os.tmpdir(), 'gemco-cl2g');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
    fileFilter: (_req, file, cb) => {
      if (file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
      else cb(new Error('Only ZIP files are accepted'));
    },
  });

  // Wrap multer to return JSON errors instead of HTML
  function uploadMiddleware(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      next();
    });
  }

  // SSE emitter for migration logs
  const cl2gLogEmitter = new EventEmitter();
  cl2gLogEmitter.setMaxListeners(50);

  function cl2gLog(type, message) {
    cl2gLogEmitter.emit('log', { type, message, ts: new Date().toISOString() });
  }

  function requireAuth(req, res, next) {
    if (req.session?.appUser) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  function getCtx(req) {
    return {
      appUserId:   req.session?.appUser?._id?.toString() || null,
      googleEmail: req.session?.googleEmail || null,
    };
  }

  // ── GET /api/cl2g/migrate-log ─────────────────────────────────────────────
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

    // Heartbeat every 10s to keep connection alive through proxies/browsers
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    }, 10000);

    const handler = d => send(d);
    cl2gLogEmitter.on('log', handler);
    req.on('close', () => {
      cl2gLogEmitter.off('log', handler);
      clearInterval(heartbeat);
    });
  });

  // ── POST /api/cl2g/upload ─────────────────────────────────────────────────
  router.post('/upload', requireAuth, uploadMiddleware, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { appUserId, googleEmail } = getCtx(req);
    const uploadId   = `cl2g_${Date.now()}`;
    const extractDir = path.join(uploadsDir, uploadId);

    try {
      fs.mkdirSync(extractDir, { recursive: true });

      // Dynamic import to avoid top-level dependency issues
      const { extractZip, parseClaudeExport } = await import('./zipParser.js');
      await extractZip(req.file.path, extractDir);

      // Remove the raw zip after extraction
      fs.unlink(req.file.path, () => {});

      const parsed = parseClaudeExport(extractDir);

      // Persist all Claude conversations to conversationStore at upload time.
      // FATAL if it fails — disk is about to be deleted so DB is the only copy.
      const ingestBatchId = `ingest_${uploadId}`;
      let totalPersisted = 0;
      const { getUserData } = await import('./zipParser.js');
      const { persistSourceConversations, SOURCE_TYPE } = await import('../_shared/conversationStore.js');
      for (const u of parsed.users) {
        const { conversations: userConvs } = getUserData(extractDir, u.uuid);
        if (!userConvs?.length) continue;
        const r = await persistSourceConversations(
          {
            batchId: ingestBatchId,
            appUserId,
            migDir: 'claude-gemini',
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

      // DB is the source of truth — purge the disk extract. Memory + project
      // documents previously read from disk are dropped (scope decision).
      fs.rm(extractDir, { recursive: true, force: true }, (err) => {
        if (err) dbLog.warn(`Failed to clean up extractDir ${extractDir}: ${err.message}`);
        else dbLog.info(`extractDir cleaned: ${extractDir}`);
      });

      const now = new Date();
      const doc = {
        _id:                uploadId,
        appUserId,
        googleEmail,
        fileName:           req.file.originalname,
        // No extractPath — disk is gone; migration reads exclusively from conversationStore.
        ingestBatchId,
        conversationsPersisted: totalPersisted,
        uploadTime:         now,
        // lastActiveAt tracks the user's currently-selected upload across
        // restarts. Bumped on upload (this is the new active one) and again
        // any time the user picks a different upload from the Saved Uploads
        // menu (POST /uploads/:id/activate). GET /uploads sorts by this DESC.
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

  // ── GET /api/cl2g/uploads ─────────────────────────────────────────────────
  // Sorted by lastActiveAt DESC so the user's last-selected (or last-uploaded)
  // ZIP is index 0 — that's the one the App-level mount restore picks on
  // server restart / browser refresh. Falls back to uploadTime for legacy
  // rows that don't have lastActiveAt yet.
  router.get('/uploads', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const uploads = await db().collection('claudeUploads')
        .find({ appUserId })
        .sort({ lastActiveAt: -1, uploadTime: -1 })
        .toArray();

      // Auto-purge only LEGACY records that have an extractPath whose dir is
      // gone AND no DB content. New uploads have conversationsPersisted > 0
      // and no extractPath — they're kept indefinitely.
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

  // ── POST /api/cl2g/uploads/:id/activate ────────────────────────────────────
  // Bumps lastActiveAt so the App-level mount restore picks this upload on
  // next refresh / server restart. Called from the UI when the user clicks
  // a different ZIP in the "Saved Uploads" menu.
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

  // ── DELETE /api/cl2g/uploads/:id ─────────────────────────────────────────
  router.delete('/uploads/:id', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('claudeUploads').findOne({ _id: req.params.id, appUserId });
      if (!doc) return res.status(404).json({ error: 'Upload not found' });

      // Delete extracted files from disk
      if (doc.extractPath) {
        fs.rm(doc.extractPath, { recursive: true, force: true }, () => {});
      }

      await db().collection('claudeUploads').deleteOne({ _id: req.params.id, appUserId });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/cl2g/user-mappings ───────────────────────────────────────────
  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('userMappings').findOne({ appUserId, migDir: 'claude-gemini' });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2g/user-mappings ──────────────────────────────────────────
  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId, googleEmail } = getCtx(req);
      const { mappings, csvEmails } = req.body;
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: 'claude-gemini' },
        { $set: { migDir: 'claude-gemini', appUserId, googleEmail, mappings, csvEmails, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      dbLog.info(`userMappings.upsert — CL2G ${Object.keys(mappings || {}).length} mappings`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/cl2g/user-mappings ────────────────────────────────────────
  router.delete('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      await db().collection('userMappings').deleteOne({ appUserId, migDir: 'claude-gemini' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2g/migrate ────────────────────────────────────────────────
  router.post('/migrate', requireAuth, async (req, res) => {
    try {
      const { appUserId, googleEmail } = getCtx(req);
      const { pairs, uploadId, folderName, dryRun, fromDate, toDate, includeMemory, includeProjects } = req.body;

      if (!pairs?.length)  return res.status(400).json({ error: 'No user pairs provided' });
      if (!uploadId)       return res.status(400).json({ error: 'No uploadId provided' });

      const uploadDoc = await db().collection('claudeUploads').findOne({ _id: uploadId, appUserId });
      if (!uploadDoc) return res.status(404).json({ error: 'Upload not found' });

      const batchId     = `cl2g_${Date.now()}`;
      const startTime   = new Date();
      const resumeContext = {
        kind: 'cl2g',
        appUserId, googleEmail,
        pairs, uploadId, folderName, dryRun, fromDate, toDate, includeMemory, includeProjects,
      };

      res.json({ started: true, batchId });

      setImmediate(() => executeCL2GMigration({ batchId, startTime, resumeContext, isResume: false }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function executeCL2GMigration({ batchId, startTime, resumeContext, isResume }) {
    const { appUserId, googleEmail, pairs, uploadId, folderName, dryRun, fromDate, toDate, includeMemory, includeProjects } = resumeContext;
    const isDryRun   = dryRun === true;
    const cl2gFolder = folderName || 'ClaudeChats';

    // Re-look up uploadDoc by id on resume (uploadDoc not in closure here)
    const uploadDoc = await db().collection('claudeUploads').findOne({ _id: uploadId, appUserId });
    if (!uploadDoc) {
      dbLog.error(`[CL2G] Upload ${uploadId} not found on ${isResume ? 'resume' : 'start'} — aborting batch ${batchId}`);
      await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: 'Upload doc missing' } }).catch(() => {});
      return;
    }

    {
        let files = 0, errors = 0;
        // Declared at function scope so the catch handler can reference them.
        let reportUsers = [];
        const { startHeartbeat, stopHeartbeat, markUserPairMigrated, markUserPairFailed } = await import('../_shared/conversationStore.js');
        let _heartbeatId = null;

        try {
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { migDir: 'claude-gemini', direction: 'claude-gemini', customerName: cl2gFolder, startTime, status: 'running', dryRun: isDryRun, appUserId, googleEmail, fromDate: fromDate || null, toDate: toDate || null, totalUsers: pairs.length, lastHeartbeat: new Date(), resumeContext, ...(isResume ? { resumedAt: new Date() } : {}) } },
            { upsert: true }
          );
          _heartbeatId = startHeartbeat(batchId);

          // After the DB-only refactor, uploadDoc.extractPath is intentionally
          // missing on new uploads (conversations live in conversationStore).
          // Only block if BOTH the disk extract AND DB content are missing —
          // either source is enough to migrate from.
          const hasDiskExtract = uploadDoc.extractPath && fs.existsSync(uploadDoc.extractPath);
          const dbConvCount = await db().collection('conversationStore')
            .countDocuments({ uploadId, appUserId });
          if (!hasDiskExtract && dbConvCount === 0) {
            const msg = `Upload has no data — no disk extract AND no conversations in DB. Re-upload the ZIP.`;
            dbLog.error(`[CL2G] ${msg}`);
            cl2gLog('error', msg);
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'claude-gemini', status: 'failed', endTime: new Date(), error: msg } }).catch(() => {});
            cl2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          const { migrateUserPair } = await import('./migration/migrate.js');
          // reportUsers declared at function scope above so catch can see it
          reportUsers.length = 0;

          dbLog.info(`[CL2G] Starting ${isDryRun ? 'dry run' : 'migration'} — ${pairs.length} user(s), uploadId=${uploadId}, ${hasDiskExtract ? 'disk:' + uploadDoc.extractPath : 'DB-only (' + dbConvCount + ' convs)'}`);
          cl2gLog('info', `Starting CL2G ${isDryRun ? 'dry run' : 'migration'} for ${pairs.length} user(s)...`);
          cl2gLog('total', JSON.stringify({ total: pairs.length }));

          // Pre-flight validator (only on dry-run; additive — does not affect existing loop)
          if (isDryRun) {
            try {
              const { runDryRunValidator } = await import('../dry-run/validator.js');
              const dryRunReport = await runDryRunValidator({
                migDir: 'claude-gemini',
                pairs: pairs.map(p => ({ sourceEmail: p.sourceEmail, sourceUuid: p.sourceUuid, destEmail: p.destEmail, expectedConversationCount: p.conversationCount || 0 })),
                config: { folderName: cl2gFolder, dryRun: true },
                appUserId, googleEmail,
                uploadData: uploadDoc,
              });
              await db().collection('migrationWorkspaces').updateOne(
                { _id: batchId },
                { $set: { dryRunReport } }
              ).catch(() => {});
              cl2gLog('info', `Dry-run validator: ${dryRunReport.summary.ready} ready · ${dryRunReport.summary.warning} warning · ${dryRunReport.summary.blocker} blocker`);
            } catch (e) {
              cl2gLog('warn', `Dry-run validator failed: ${e.message}`);
            }
          }

          for (const pair of pairs) {
            cl2gLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destEmail}`);

            if (isDryRun) {
              // Dry run: count conversations from DB (preferred) or disk (legacy).
              // Memory + projects are dropped after the DB-only refactor — they
              // lived only on disk. Each user now produces at most 1 merged DOCX.
              let convCount = 0;
              if (hasDiskExtract) {
                try {
                  const { getUserData } = await import('./zipParser.js');
                  const { conversations } = getUserData(uploadDoc.extractPath, pair.sourceUuid);
                  convCount = conversations.length;
                } catch (e) { cl2gLog('warn', `getUserData failed for ${pair.sourceEmail}: ${e.message}`); }
              } else {
                convCount = await db().collection('conversationStore').countDocuments({
                  uploadId, appUserId, sourceEmail: pair.sourceEmail,
                });
              }
              const dryFiles = convCount > 0 ? 1 : 0;
              cl2gLog('info', `  ${pair.sourceDisplayName}: ${convCount} conversations → ${dryFiles ? '1 merged DOCX' : 'no data'}`);
              reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: pair.sourceDisplayName, status: 'success', pages_created: dryFiles, conversations_processed: convCount, migrated_conversations: convCount, files_uploaded: 0, error_count: 0, errors: [] });
              files += dryFiles;
              // Emit progress so the UI stats card shows the real conversation
              // count (not just the file count). Live path emits this after
              // each migrated pair; dry-run was skipping it because of the
              // `continue` below.
              const cumulativeConvs = reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0);
              cl2gLog('progress', JSON.stringify({ files, convs: cumulativeConvs, errors, users: reportUsers.length, total: pairs.length }));
              continue;
            }

            const r = await migrateUserPair(
              { sourceUuid: pair.sourceUuid, sourceDisplayName: pair.sourceDisplayName, destUserEmail: pair.destEmail, extractPath: uploadDoc.extractPath, appUserId, uploadId, sourceEmail: pair.sourceEmail },
              { folderName: cl2gFolder, fromDate, toDate, includeMemory, includeProjects, isResume }
            );

            // Note: conversations already persisted to conversationStore at upload time.

            const status = r.errors?.length ? (r.filesUploaded > 0 ? 'partial' : 'failed') : 'success';
            // CL2G destination is a merged DOCX in Drive that contains all
            // conversations — so on success/partial, all parsed conversations
            // are considered migrated. files_uploaded counts standalone
            // attachments (images, PDFs) regenerated alongside, NOT the DOCX.
            const _migratedConvs = status === 'failed' ? 0 : (r.conversationsCount || 0);
            const _attachmentCount = r.attachmentsUploaded || 0;
            reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: r.sourceDisplayName, status, pages_created: r.filesUploaded, conversations_processed: r.conversationsCount, migrated_conversations: _migratedConvs, files_uploaded: _attachmentCount, error_count: r.errors.length, errors: r.errors.map(e => ({ error_message: e })), files: r.files });

            // Mark conversationStore rows for this user pair
            if (status === 'failed') {
              await markUserPairFailed({ appUserId, uploadId, batchId, sourceEmail: pair.sourceEmail, error: r.errors[0] || 'unknown' });
            } else {
              await markUserPairMigrated({ appUserId, uploadId, batchId, sourceEmail: pair.sourceEmail, destEmail: pair.destEmail });
            }

            if (r.errors.length) {
              r.errors.forEach(e => { cl2gLog('warn', e); dbLog.warn(`[CL2G] ${r.sourceDisplayName}: ${e}`); });
            }
            files  += r.filesUploaded;
            errors += r.errors.length;
            dbLog.info(`[CL2G] ${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} files uploaded, ${r.errors.length} error(s)`);
            cl2gLog(status === 'failed' ? 'warn' : 'success', `${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} files, ${r.errors.length} error(s)`);
            const cumulativeConvs = reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0);
            cl2gLog('progress', JSON.stringify({ files, convs: cumulativeConvs, errors, users: reportUsers.length, total: pairs.length }));

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
          // Isolate the final DB write — a failure here must not hide the real file count
          const totalConvsSum = reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0);
          // Migrated = sum of per-user migrated_conversations (0 for failed
          // users). Dry-runs force 0 since nothing was actually written.
          const migratedConvSum = isDryRun
            ? 0
            : reportUsers.reduce((s, u) => s + (u.migrated_conversations || 0), 0);
          const finalUpdate = { migDir: 'claude-gemini', status: finalStatus, endTime: new Date(), totalConversations: totalConvsSum, migratedConversations: migratedConvSum, migratedUsers: reportUsers.filter(u => u.status !== 'failed').length, failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors, report: { summary: { total_users: pairs.length, total_pages_created: files, total_errors: errors, total_conversations: totalConvsSum, total_migrated_conversations: migratedConvSum }, users: reportUsers } };
          try {
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: finalUpdate });
          } catch (dbErr) {
            dbLog.error(`[CL2G] Final report DB write failed: ${dbErr.message}. Retrying...`);
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: finalUpdate })
              .catch(e2 => dbLog.error(`[CL2G] Retry also failed: ${e2.message}`));
          }
          cl2gLog('done', JSON.stringify({ files, errors, users: pairs.length, batchId }));

        } catch (e) {
          console.error('[CL2G] Unhandled error:', e);
          dbLog.error(`[CL2G] Unhandled error after ${files} file(s) uploaded: ${e.message}`);
          cl2gLog('error', e.message || String(e));
          // Use actual files/errors counts so UI shows correct numbers even on error
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { migDir: 'claude-gemini', status: files > 0 ? 'completed' : 'failed', endTime: new Date(), migratedConversations: reportUsers.reduce((s, u) => s + (u.conversations_processed || 0), 0) || files, totalErrors: errors + 1, error: e.message } }
          ).catch(() => {});
          cl2gLog('done', JSON.stringify({ files, errors: errors + 1, users: pairs.length, batchId }));
        } finally {
          stopHeartbeat(_heartbeatId);
        }
      }
  }

  router.executeCL2GMigration = executeCL2GMigration;

  return router;
}
