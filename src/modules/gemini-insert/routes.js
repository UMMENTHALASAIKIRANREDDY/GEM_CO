/**
 * Gemini Insert routes — mounted at /api/gemini-insert
 *
 * POST /migrate       — start inserting conversations into Gemini sidebar
 * GET  /log           — SSE stream of migration logs
 * GET  /status/:jobId — check job status
 * DELETE /profile     — reset Gemini browser profile (forces re-auth)
 */

import express from 'express';
import { EventEmitter } from 'events';
import { getLogger }    from '../../utils/logger.js';
import { insertConversationsToGemini, deleteProfile } from './geminiInserter.js';

const log = getLogger('gemini-insert');

export function createGeminiInsertRouter({ db }) {
  const router  = express.Router();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  function emit(type, message) {
    emitter.emit('log', { type, message, ts: new Date().toISOString() });
  }

  function requireAuth(req, res, next) {
    if (req.session?.appUser) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  function getCtx(req) {
    return {
      appUserId:   req.session?.appUser?._id?.toString() || null,
      googleEmail: req.session?.googleEmail || null,
      msEmail:     req.session?.msEmail     || null,
    };
  }

  // ── GET /api/gemini-insert/log — SSE ────────────────────────────────────────
  router.get('/log', (req, res) => {
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
    emitter.on('log', handler);
    req.on('close', () => {
      emitter.off('log', handler);
      clearInterval(heartbeat);
    });
  });

  // ── GET /api/gemini-insert/status/:jobId ────────────────────────────────────
  router.get('/status/:jobId', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const job = await db().collection('geminiInsertJobs').findOne({ _id: req.params.jobId, appUserId });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json(job);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/gemini-insert/jobs — list recent jobs ──────────────────────────
  router.get('/jobs', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const jobs = await db().collection('geminiInsertJobs')
        .find({ appUserId })
        .sort({ startTime: -1 })
        .limit(20)
        .toArray();
      res.json(jobs);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/gemini-insert/profile — reset Gemini auth ───────────────────
  router.delete('/profile', (req, res) => {
    try {
      const { appUserId } = getCtx(req);
      const effectiveId = appUserId || 'demo';
      deleteProfile(effectiveId);
      log.info(`gemini-insert: profile deleted for ${effectiveId}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/gemini-insert/migrate ─────────────────────────────────────────
  // Body: { conversations: [{ title, messages: [{role, content}], date? }] }
  router.post('/migrate', async (req, res) => {
    try {
      const { appUserId: _uid, googleEmail } = getCtx(req);
      const appUserId = _uid || 'demo';
      const { conversations, headless = false } = req.body;

      if (!Array.isArray(conversations) || conversations.length === 0) {
        return res.status(400).json({ error: 'conversations array required' });
      }

      const jobId    = `gi_${Date.now()}`;
      const startTime = new Date();

      // Insert job record
      await db().collection('geminiInsertJobs').insertOne({
        _id:           jobId,
        appUserId,
        googleEmail,
        startTime,
        status:        'running',
        total:         conversations.length,
        inserted:      0,
        failed:        0,
        results:       [],
      });

      // Store in migrationWorkspaces for unified history view
      await db().collection('migrationWorkspaces').updateOne(
        { _id: jobId },
        { $set: {
          migDir:       'gemini-insert',
          direction:    'gemini-insert',
          customerName: 'Gemini Chat Import',
          startTime,
          status:       'running',
          appUserId,
          googleEmail,
          totalUsers:   1,
        } },
        { upsert: true }
      ).catch(() => {});

      res.json({ started: true, jobId });

      // Run async
      setImmediate(async () => {
        try {
          emit('info', `Starting Gemini insert for ${conversations.length} conversation(s)...`);
          emit('total', JSON.stringify({ total: conversations.length }));

          const { inserted, failed, results } = await insertConversationsToGemini({
            appUserId,
            conversations,
            headless,
            onLog: (type, message) => {
              emit(type, message);
              log.info(`[GI] ${message}`);
            },
            onProgress: ({ done, total }) => {
              emit('progress', JSON.stringify({ done, total }));
            },
          });

          const finalStatus = failed === 0 ? 'completed' : inserted > 0 ? 'partial' : 'failed';

          await db().collection('geminiInsertJobs').updateOne(
            { _id: jobId },
            { $set: { status: finalStatus, endTime: new Date(), inserted, failed, results } }
          );

          await db().collection('migrationWorkspaces').updateOne(
            { _id: jobId },
            { $set: {
              migDir:               'gemini-insert',
              status:               finalStatus,
              endTime:              new Date(),
              migratedConversations: inserted,
              totalErrors:          failed,
            } }
          ).catch(() => {});

          emit('done', JSON.stringify({ inserted, failed, total: conversations.length, jobId }));

        } catch (e) {
          log.error(`[GI] Unhandled error: ${e.message}`);
          emit('error', e.message || String(e));
          await db().collection('geminiInsertJobs').updateOne(
            { _id: jobId },
            { $set: { status: 'failed', endTime: new Date(), error: e.message } }
          ).catch(() => {});
          await db().collection('migrationWorkspaces').updateOne(
            { _id: jobId },
            { $set: { migDir: 'gemini-insert', status: 'failed', endTime: new Date(), error: e.message } }
          ).catch(() => {});
          emit('done', JSON.stringify({ inserted: 0, failed: conversations.length, total: conversations.length, jobId }));
        }
      });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
