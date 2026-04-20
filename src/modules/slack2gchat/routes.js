import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { extractSlackZip } from './services/slackExport/zipExtractor.js';
import { parseSlackExport } from './services/slackExport/exportParser.js';
import { buildUserMatches, parseUserMappingCsv } from './services/slackExport/userMatcher.js';
import { saveUserMap, getUserMap, updateUserMapping, applyBulkMapping } from './services/mapping/userMapService.js';
import { saveChannelMap, getChannelMap } from './services/mapping/channelMapService.js';
import { getJobProgress } from './services/mapping/messageProgressSvc.js';
import { startMigration, pauseMigration, resumeMigration, retryErrors } from './services/migration/orchestrator.js';
import { getProgressEmitter } from './sse/progressEmitter.js';
import { getS2GDb } from './db/ensureCollections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.S2G_UPLOAD_DIR || path.join(process.cwd(), 'uploads', 's2g');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: (parseInt(process.env.S2G_MAX_ZIP_MB || '5120', 10)) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files accepted'));
  },
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * @param {{ requireAuth, requireGoogleAuth, getWorkspaceContext }} deps
 */
export function createS2GRouter({ requireAuth, requireGoogleAuth, getWorkspaceContext }) {
  const router = express.Router();

  // All S2G routes require app login + Google auth
  router.use(requireAuth);
  router.use(requireGoogleAuth);

  // ── POST /api/s2g/upload ─────────────────────────────────────────────────────
  router.post('/upload', upload.single('slack_export'), async (req, res) => {
    try {
      const { appUserId, googleEmail } = getWorkspaceContext(req);
      const batchId = `s2g_${Date.now()}`;
      const extractDir = path.join(UPLOAD_DIR, batchId);

      await extractSlackZip(req.file.path, extractDir);
      fs.unlinkSync(req.file.path); // remove raw zip after extraction

      const parsed = await parseSlackExport(extractDir);

      // Persist job
      const db = getS2GDb();
      await db.collection('jobs').insertOne({
        _id: batchId, appUserId, googleEmail,
        status: 'parsed', phase: 'USER_MAP',
        uploadPath: extractDir,
        workspaceName: parsed.stats.totalChannels > 0 ? 'Slack Workspace' : 'Unknown',
        stats: parsed.stats,
        config: { preserveThreads: true, skipAttachments: true },
        createdAt: new Date(), updatedAt: new Date(),
      });

      // Save channel map
      await saveChannelMap(batchId, parsed.channels);

      // Save user map (unmatched — user will fix next)
      const userMatches = buildUserMatches(parsed.users);
      await saveUserMap(batchId, userMatches.map(u => ({ ...u, batchId })));

      res.json({ batchId, stats: parsed.stats });
    } catch (err) {
      console.error('[S2G /upload]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/s2g/parse/:batchId ─────────────────────────────────────────────
  // Re-parse (if upload already done but parse needed again)
  router.post('/parse/:batchId', async (req, res) => {
    try {
      const db = getS2GDb();
      const job = await db.collection('jobs').findOne({ _id: req.params.batchId });
      if (!job) return res.status(404).json({ error: 'Batch not found' });

      const parsed = await parseSlackExport(job.uploadPath);
      await saveChannelMap(req.params.batchId, parsed.channels);

      res.json({ stats: parsed.stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/s2g/users/:batchId ──────────────────────────────────────────────
  router.get('/users/:batchId', async (req, res) => {
    try {
      const users = await getUserMap(req.params.batchId);
      res.json({ users });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/s2g/users/:batchId/mapping ─────────────────────────────────────
  // CSV upload: columns slack_email (or slack_user_id), google_email
  router.post('/users/:batchId/mapping', csvUpload.single('mapping_csv'), async (req, res) => {
    try {
      const { batchId } = req.params;

      // Accept CSV file OR JSON body array
      if (req.file) {
        const mapping = parseUserMappingCsv(req.file.buffer);
        const updated = await applyBulkMapping(batchId, mapping);
        return res.json({ updated });
      }

      // JSON body: [{ slackUserId, googleEmail }]
      if (req.body?.mappings?.length) {
        let updated = 0;
        for (const { slackUserId, googleEmail } of req.body.mappings) {
          await updateUserMapping(batchId, slackUserId, googleEmail);
          updated++;
        }
        return res.json({ updated });
      }

      res.status(400).json({ error: 'Provide mapping_csv file or mappings array in body' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/s2g/channels/:batchId ──────────────────────────────────────────
  router.get('/channels/:batchId', async (req, res) => {
    try {
      const channels = await getChannelMap(req.params.batchId);
      res.json({ channels });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/s2g/migrate/:batchId ──────────────────────────────────────────
  router.post('/migrate/:batchId', async (req, res) => {
    try {
      const { batchId } = req.params;
      const db = getS2GDb();
      const job = await db.collection('jobs').findOne({ _id: batchId });
      if (!job) return res.status(404).json({ error: 'Batch not found' });
      if (job.status === 'importing') return res.status(409).json({ error: 'Migration already running' });

      res.json({ started: true, batchId });

      setImmediate(() => startMigration(batchId, req.body?.config || {}).catch(err => {
        console.error('[S2G orchestrator]', err.message);
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/s2g/migrate/:batchId/pause ────────────────────────────────────
  router.post('/migrate/:batchId/pause', async (req, res) => {
    try {
      await pauseMigration(req.params.batchId);
      res.json({ paused: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/s2g/migrate/:batchId/resume ───────────────────────────────────
  router.post('/migrate/:batchId/resume', async (req, res) => {
    try {
      await resumeMigration(req.params.batchId);
      res.json({ resumed: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/s2g/migrate/:batchId/retry-errors ─────────────────────────────
  router.post('/migrate/:batchId/retry-errors', async (req, res) => {
    try {
      const count = await retryErrors(req.params.batchId);
      res.json({ retrying: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/s2g/status/:batchId ────────────────────────────────────────────
  router.get('/status/:batchId', async (req, res) => {
    try {
      const db = getS2GDb();
      const job = await db.collection('jobs').findOne({ _id: req.params.batchId });
      if (!job) return res.status(404).json({ error: 'Batch not found' });

      const progress = await getJobProgress(req.params.batchId);
      const totalImported = progress.reduce((s, p) => s + (p.importedCount || 0), 0);
      const totalMessages = progress.reduce((s, p) => s + (p.totalMessages || 0), 0);
      const doneChannels = progress.filter(p => p.status === 'done').length;

      res.json({
        ...job,
        progress: {
          totalImported,
          totalMessages,
          doneChannels,
          totalChannels: progress.length,
          pct: totalMessages > 0 ? Math.round(totalImported / totalMessages * 100) : 0,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/s2g/migrate-log/:batchId — SSE ──────────────────────────────────
  router.get('/migrate-log/:batchId', (req, res) => {
    const { batchId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const ee = getProgressEmitter(batchId);
    const handler = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    ee.on('progress', handler);
    req.on('close', () => ee.off('progress', handler));
  });

  // ── GET /api/s2g/report/:batchId ────────────────────────────────────────────
  router.get('/report/:batchId', async (req, res) => {
    try {
      const db = getS2GDb();
      const channels = await getChannelMap(req.params.batchId);
      const progress = await getJobProgress(req.params.batchId);
      const progMap = new Map(progress.map(p => [p.slackChannelId, p]));

      const lines = ['channel_name,type,status,imported,total,errors'];
      for (const ch of channels) {
        const p = progMap.get(ch.slackChannelId);
        lines.push([
          ch.slackName, ch.slackType,
          ch.skipped ? 'skipped' : (ch.importCompleted ? 'done' : 'pending'),
          p?.importedCount || 0, p?.totalMessages || 0,
          ch.skipReason || '',
        ].join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="s2g_report_${req.params.batchId}.csv"`);
      res.send(lines.join('\n'));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/s2g/history ─────────────────────────────────────────────────────
  router.get('/history', async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const db = getS2GDb();
      const jobs = await db.collection('jobs')
        .find({ appUserId }, { projection: { uploadPath: 0 } })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
