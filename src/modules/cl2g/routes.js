/**
 * CL2G (Claude → Gemini) routes — mounted at /api/cl2g.
 * Completely self-contained; does not touch any existing module.
 */

import express  from 'express';
import multer   from 'multer';
import fs       from 'node:fs';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter }  from 'events';
import { getLogger }     from '../../utils/logger.js';

const dbLog    = getLogger('db:cl2g');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.resolve(__dirname, '../../../');

export function createCL2GRouter({ db }) {
  const router = express.Router();

  // Upload directory for Claude ZIPs
  const uploadsDir = path.join(ROOT_DIR, 'uploads', 'cl2g');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const upload = multer({
    dest: uploadsDir,
    fileFilter: (_req, file, cb) => {
      if (file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
      else cb(new Error('Only ZIP files are accepted'));
    },
  });

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
  router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
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

      const doc = {
        _id:                uploadId,
        appUserId,
        googleEmail,
        fileName:           req.file.originalname,
        extractPath:        extractDir,
        uploadTime:         new Date(),
        totalConversations: parsed.totalConversations,
        totalMemories:      parsed.totalMemories,
        totalProjects:      parsed.totalProjects,
        users:              parsed.users,
        status:             'ready',
      };

      await db().collection('cl2gUploads').insertOne(doc);
      dbLog.info(`cl2gUploads.insert — ${uploadId} (${parsed.users.length} users, ${parsed.totalConversations} convs)`);

      res.json({ uploadId, users: parsed.users, totalConversations: parsed.totalConversations, totalMemories: parsed.totalMemories, totalProjects: parsed.totalProjects });
    } catch (err) {
      fs.rm(extractDir, { recursive: true, force: true }, () => {});
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/cl2g/uploads ─────────────────────────────────────────────────
  router.get('/uploads', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const uploads = await db().collection('cl2gUploads')
        .find({ appUserId })
        .sort({ uploadTime: -1 })
        .toArray();
      res.json(uploads);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/cl2g/uploads/:id ─────────────────────────────────────────
  router.delete('/uploads/:id', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('cl2gUploads').findOne({ _id: req.params.id, appUserId });
      if (!doc) return res.status(404).json({ error: 'Upload not found' });

      // Delete extracted files from disk
      if (doc.extractPath) {
        fs.rm(doc.extractPath, { recursive: true, force: true }, () => {});
      }

      await db().collection('cl2gUploads').deleteOne({ _id: req.params.id, appUserId });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/cl2g/user-mappings ───────────────────────────────────────────
  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const doc = await db().collection('userMappings').findOne({ direction: 'claude-gemini', appUserId });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/cl2g/user-mappings ──────────────────────────────────────────
  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId, googleEmail } = getCtx(req);
      const { mappings, csvEmails } = req.body;
      await db().collection('userMappings').updateOne(
        { direction: 'claude-gemini', appUserId },
        { $set: { direction: 'claude-gemini', appUserId, googleEmail, mappings, csvEmails, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
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
      await db().collection('userMappings').deleteOne({ direction: 'claude-gemini', appUserId });
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

      const uploadDoc = await db().collection('cl2gUploads').findOne({ _id: uploadId, appUserId });
      if (!uploadDoc) return res.status(404).json({ error: 'Upload not found' });

      const isDryRun    = dryRun === true;
      const cl2gFolder  = folderName || 'ClaudeChats';
      const batchId     = `cl2g_${Date.now()}`;
      const startTime   = new Date();

      res.json({ started: true, batchId });

      setImmediate(async () => {
        let files = 0, errors = 0;

        try {
          await db().collection('reportsWorkspace').updateOne(
            { _id: batchId },
            { $set: { direction: 'claude-gemini', customerName: cl2gFolder, startTime, status: 'running', dryRun: isDryRun, appUserId, googleEmail, totalUsers: pairs.length } },
            { upsert: true }
          );

          // Verify the extracted ZIP directory is still present on disk
          if (!uploadDoc.extractPath || !fs.existsSync(uploadDoc.extractPath)) {
            const msg = `Upload files not found on disk (${uploadDoc.extractPath}). The server may have restarted and lost the uploaded ZIP. Please re-upload the ZIP file and try again.`;
            dbLog.error(`[CL2G] ${msg}`);
            cl2gLog('error', msg);
            await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: msg } }).catch(() => {});
            cl2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          const { migrateUserPair } = await import('./migration/migrate.js');
          const reportUsers = [];

          dbLog.info(`[CL2G] Starting ${isDryRun ? 'dry run' : 'migration'} — ${pairs.length} user(s), uploadId=${uploadId}, extractPath=${uploadDoc.extractPath}`);
          cl2gLog('info', `Starting CL2G ${isDryRun ? 'dry run' : 'migration'} for ${pairs.length} user(s)...`);
          cl2gLog('total', JSON.stringify({ total: pairs.length }));

          for (const pair of pairs) {
            cl2gLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destEmail}`);

            if (isDryRun) {
              // Dry run: count merged files (max 3 per user: conversations, memory, projects)
              const { getUserData } = await import('./zipParser.js');
              const { conversations, memory, projects } = getUserData(uploadDoc.extractPath, pair.sourceUuid);
              const validProjects = projects.filter(p => p.name || p.docs?.length);
              const dryFiles =
                (conversations.length > 0 ? 1 : 0) +
                (memory?.conversations_memory ? 1 : 0) +
                (validProjects.length > 0 ? 1 : 0);
              cl2gLog('info', `  ${pair.sourceDisplayName}: ${conversations.length} conversations → 1 merged DOCX${memory?.conversations_memory ? ' + memory' : ''}${validProjects.length > 0 ? ' + projects' : ''}`);
              reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: pair.sourceDisplayName, status: 'success', pages_created: dryFiles, conversations_processed: conversations.length, error_count: 0, errors: [] });
              files += dryFiles;
              continue;
            }

            const r = await migrateUserPair(
              { sourceUuid: pair.sourceUuid, sourceDisplayName: pair.sourceDisplayName, destUserEmail: pair.destEmail, extractPath: uploadDoc.extractPath },
              { folderName: cl2gFolder, fromDate, toDate, includeMemory, includeProjects }
            );

            const status = r.errors?.length ? (r.filesUploaded > 0 ? 'partial' : 'failed') : 'success';
            reportUsers.push({ email: pair.sourceEmail, destEmail: pair.destEmail, displayName: r.sourceDisplayName, status, pages_created: r.filesUploaded, conversations_processed: r.conversationsCount, error_count: r.errors.length, errors: r.errors.map(e => ({ error_message: e })), files: r.files });

            if (r.errors.length) {
              r.errors.forEach(e => { cl2gLog('warn', e); dbLog.warn(`[CL2G] ${r.sourceDisplayName}: ${e}`); });
            }
            files  += r.filesUploaded;
            errors += r.errors.length;
            dbLog.info(`[CL2G] ${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} files uploaded, ${r.errors.length} error(s)`);
            cl2gLog(status === 'failed' ? 'warn' : 'success', `${r.sourceDisplayName} → ${pair.destEmail}: ${r.filesUploaded} files, ${r.errors.length} error(s)`);
            cl2gLog('progress', JSON.stringify({ files, errors, users: reportUsers.length, total: pairs.length }));
          }

          const finalStatus = errors > 0 && files === 0 ? 'failed' : 'completed';
          await db().collection('reportsWorkspace').updateOne(
            { _id: batchId },
            { $set: { status: finalStatus, endTime: new Date(), migratedConversations: files, migratedUsers: reportUsers.filter(u => u.status !== 'failed').length, failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors, report: { summary: { total_users: pairs.length, total_pages_created: files, total_errors: errors }, users: reportUsers } } }
          );
          cl2gLog('done', JSON.stringify({ files, errors, users: pairs.length, batchId }));

        } catch (e) {
          console.error('[CL2G] Unhandled error:', e);
          cl2gLog('error', e.message || String(e));
          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: e.message } }).catch(() => {});
          cl2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
        }
      });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
