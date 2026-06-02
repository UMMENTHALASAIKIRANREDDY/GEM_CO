/**
 * G2G (Gemini → Gemini) routes.
 * Reads conversations from source Google account Vault export
 * and uploads them to destination Google account.
 */

import express from 'express';
import { EventEmitter } from 'events';
import { getLogger } from '../../utils/logger.js';
import { getGoogleAccounts } from '../../core/auth/googleOAuth.js';

const dbLog = getLogger('db:ops');

export function createG2GRouter(deps) {
  const { db, getGoogleOAuth2Client: getClient } = deps;
  const router = express.Router();

  const g2gLogEmitter = new EventEmitter();
  g2gLogEmitter.setMaxListeners(50);

  function g2gLog(type, message) {
    g2gLogEmitter.emit('log', { type, message, ts: new Date().toISOString() });
  }

  function requireAuth(req, res, next) {
    if (req.session?.appUser) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  function getWorkspaceContext(req) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    return { appUserId };
  }

  // GET /api/g2g/migrate-log — SSE stream for G2G migration
  router.get('/migrate-log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
    const handler = d => send(d);
    g2gLogEmitter.on('log', handler);
    req.on('close', () => g2gLogEmitter.off('log', handler));
  });

  // GET /api/g2g/accounts — get all connected Google accounts for account selection
  router.get('/accounts', requireAuth, (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const accounts = getGoogleAccounts(appUserId);
      res.json({ accounts: accounts || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/g2g/users — get users from a specific Google account by accountId
  router.get('/users', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const accountId = req.query.accountId;
      if (!accountId) {
        return res.status(400).json({ error: 'accountId required' });
      }

      const { google } = await import('googleapis');
      const { getServiceAccountAuthForUser } = await import('../c2g/googleService.js');
      // Use service-account auth instead of user OAuth so the admin's token
      // expiry (invalid_rapt reauth policy) never blocks this endpoint.
      const auth = await getServiceAccountAuthForUser(appUserId, accountId);
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

      res.json({ total: users.length, users });
    } catch (err) {
      console.error('[g2g/users]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── User mappings (mappings + csvEmails per app user) ──────────────
  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const doc = await db().collection('userMappings').findOne({ appUserId, migDir: 'gemini-gemini' });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { mappings, csvEmails } = req.body;
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: 'gemini-gemini' },
        {
          $set: { migDir: 'gemini-gemini', appUserId, mappings, csvEmails: csvEmails ?? null, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: 'gemini-gemini' },
        { $set: { mappings: {}, csvEmails: null, updatedAt: new Date() } }
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/g2g/session — get current G2G migration session state
  router.get('/session', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const session = await db().collection('g2gSessions').findOne({ appUserId });
      if (session) {
        return res.json({ ...session, _id: undefined, appUserId: undefined });
      }
      res.json({});
    } catch (err) {
      console.error('[g2g/session]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/g2g/session — save G2G migration session state
  router.post('/session', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { g2gUploadData, g2gConfig, g2gMappings, g2gSelectedUsers, g2gOptions } = req.body;

      await db().collection('g2gSessions').updateOne(
        { appUserId },
        { $set: {
          appUserId,
          g2gUploadData,
          g2gConfig,
          g2gMappings,
          g2gSelectedUsers: Array.from(g2gSelectedUsers || []),
          g2gOptions,
          lastUpdated: new Date()
        } },
        { upsert: true }
      );

      res.json({ saved: true });
    } catch (err) {
      console.error('[g2g/session]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/g2g/session — clear G2G migration session
  router.delete('/session', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      await db().collection('g2gSessions').deleteOne({ appUserId });
      res.json({ cleared: true });
    } catch (err) {
      console.error('[g2g/session delete]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/g2g/migrate — run Gemini→Gemini migration
  router.post('/migrate', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { sourceAccountId, destAccountId, gemName, dryRun, extractPath, selectedUsers, userMappings, fromDate, toDate } = req.body;

      if (!sourceAccountId || !destAccountId) {
        return res.status(400).json({ error: 'sourceAccountId and destAccountId required' });
      }

      if (!extractPath) {
        return res.status(400).json({ error: 'extractPath required' });
      }

      if (!selectedUsers || selectedUsers.length === 0) {
        return res.status(400).json({ error: 'At least one user must be selected' });
      }

      const isDryRun = dryRun === true || dryRun === 'true';
      const g2gGemName = gemName || 'Gemini Conversations';

      res.json({ started: true });

      const batchId = `g2g_${Date.now()}`;
      const startTime = new Date();

      setImmediate(async () => {
        let files = 0, errors = 0;

        try {
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: {
              migDir: 'gemini-gemini',
              customerName: g2gGemName,
              startTime,
              status: 'running',
              dryRun: isDryRun,
              direction: 'g2g',
              appUserId,
              sourceAccountId,
              destAccountId,
              totalUsers: selectedUsers?.length || 0,
              migratedConversations: 0,
              filesUploaded: 0,
              totalErrors: 0
            } },
            { upsert: true }
          );
          dbLog.info(`migrationWorkspaces.insert — G2G batch ${batchId} status=running (dryRun=${isDryRun}, ${selectedUsers?.length || 0} users)`);
        } catch (dbErr) {
          console.error('[G2G] DB insert error:', dbErr.message);
        }

        try {
          const migModule = await import('./migration/migrate.js');
          const { runG2GMigration } = migModule;

          // sourceCreds is unused now (vault data already extracted to extractPath);
          // destCreds is unused (we use service account impersonation per destination user).
          // We still resolve sourceCreds defensively in case future hooks need it.
          // Service-account auth so the migration is never blocked by user-OAuth
          // reauth policy (invalid_rapt).
          let sourceCreds = null;
          try {
            const { getServiceAccountAuthForUser, SCOPES_VAULT, SCOPES_DRIVE } = await import('../c2g/googleService.js');
            sourceCreds = await getServiceAccountAuthForUser(appUserId, sourceAccountId, [...SCOPES_VAULT, ...SCOPES_DRIVE]);
          } catch { /* optional */ }

          const opts = { gemName: g2gGemName };
          if (fromDate) opts.fromDate = fromDate;
          if (toDate) opts.toDate = toDate;

          g2gLog('info', `Starting G2G ${isDryRun ? 'dry run' : 'migration'} (source=${sourceAccountId}, dest=${destAccountId}, ${selectedUsers?.length || 0} users)...`);

          // Pre-flight validator (only on dry-run; additive)
          if (isDryRun) {
            try {
              const { runDryRunValidator } = await import('../dry-run/validator.js');
              const validatorPairs = (selectedUsers || []).map(srcEmail => ({
                sourceEmail: srcEmail,
                destEmail: userMappings?.[srcEmail] || srcEmail,
              }));
              const dryRunReport = await runDryRunValidator({
                migDir: 'gemini-gemini',
                pairs: validatorPairs,
                config: { folderName: g2gGemName, fromDate, toDate, dryRun: true },
                appUserId,
                extractPath,
                sourceAccountId, destAccountId,
              });
              await db().collection('migrationWorkspaces').updateOne(
                { _id: batchId },
                { $set: { dryRunReport } }
              ).catch(() => {});
              g2gLog('info', `Dry-run validator: ${dryRunReport.summary.ready} ready · ${dryRunReport.summary.warning} warning · ${dryRunReport.summary.blocker} blocker`);
            } catch (e) {
              g2gLog('warn', `Dry-run validator failed: ${e.message}`);
            }
          }

          const result = await runG2GMigration(
            {
              extractPath,
              sourceAuth: sourceCreds,
              destAuth: null,
              isDryRun,
              selectedUsers,
              userMappings,
              opts,
              // Context passed through for conversationStore persistence
              batchId,
              appUserId,
              sourceAccountId,
              destAccountId,
              uploadId: extractPath || null,  // G2G uses extractPath as the upload identifier
            },
            (logEntry) => {
              g2gLog(logEntry.type, logEntry.message);
            }
          );

          files = result.filesUploaded || 0;
          errors = result.errors?.length || 0;

          const reportUpdate = {
            status: errors > 0 && files === 0 && !isDryRun ? 'failed' : 'completed',
            endTime: new Date(),
            migratedConversations: result.conversationsCount || 0,
            migratedUsers: result.migratedUsers || 0,
            totalUsers: selectedUsers?.length || 0,
            filesUploaded: files,
            totalErrors: errors,
            users: result.users || [],
            report: {
              summary: {
                total_users: selectedUsers?.length || 0,
                total_conversations: result.conversationsCount || 0,
                total_files_created: files,
                total_errors: errors
              },
              users: result.users || [],
              errors: result.errors || []
            }
          };

          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { migDir: 'gemini-gemini', ...reportUpdate } }
          ).catch(() => {});

          dbLog.info(`migrationWorkspaces.update — G2G batch ${batchId} status=${reportUpdate.status} (${files} files)`);
          g2gLog('done', JSON.stringify({
            files,
            errors,
            conversationCount: result.conversationsCount || 0,
            batchId,
            batch_id: batchId,
            migratedUsers: result.migratedUsers || 0,
            totalUsers: selectedUsers?.length || 0
          }));

        } catch (err) {
          console.error('[G2G] Unhandled error:', err);
          g2gLog('error', err.message || String(err));
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: { migDir: 'gemini-gemini', status: 'failed', endTime: new Date(), error: err.message } }
          ).catch(() => {});
          g2gLog('done', JSON.stringify({ files, errors: 1, batchId }));
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/g2g/reports — list all G2G migration batches for this user
  router.get('/reports', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      if (!appUserId) {
        dbLog.info('g2g/reports: no appUserId');
        return res.json([]);
      }
      const reports = await db().collection('migrationWorkspaces')
        .find({ appUserId, migDir: 'gemini-gemini' }, { projection: { report: 0 } })
        .sort({ startTime: -1 }).toArray();
      dbLog.info(`g2g/reports: found ${reports.length} batches for ${appUserId}`);
      res.json(reports);
    } catch (err) {
      dbLog.error('[g2g/reports]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/g2g/reports/:id — detail view of a single G2G batch (users + errors)
  router.get('/reports/:id', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const batch = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId, migDir: 'gemini-gemini' });
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      const users = (batch.users || batch.report?.users || []).map(u => ({
        email: u.email,
        destEmail: u.destEmail,
        status: u.status || 'pending',
        pages_created: u.pages_created || u.files_created || 0,
        files_created: u.files_created || 0,
        error_count: u.error_count || (u.errors?.length || 0),
        errors: u.errors || [],
      }));
      res.json({
        _id: batch._id,
        customerName: batch.customerName,
        direction: batch.direction || 'g2g',
        migDir: batch.migDir,
        status: batch.status,
        dryRun: batch.dryRun,
        startTime: batch.startTime,
        endTime: batch.endTime,
        totalUsers: batch.totalUsers || 0,
        migratedConversations: batch.migratedConversations || 0,
        filesUploaded: batch.filesUploaded || 0,
        totalErrors: batch.totalErrors || 0,
        users,
      });
    } catch (err) {
      console.error('[g2g/reports/:id]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/g2g/reports/:id/errors — list of errors for a batch
  router.get('/reports/:id/errors', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const batch = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId, migDir: 'gemini-gemini' });
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      const flat = [];
      for (const u of (batch.users || batch.report?.users || [])) {
        for (const e of (u.errors || [])) {
          flat.push({ email: u.email, destEmail: u.destEmail, conversation: e.conversation || '', error: e.error_message || e.error || '' });
        }
      }
      res.json({ errors: flat });
    } catch (err) {
      console.error('[g2g/reports/:id/errors]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/g2g/reports/:id/csv — CSV export of a G2G batch
  router.get('/reports/:id/csv', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const batch = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId, migDir: 'gemini-gemini' });
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      const users = batch.users || batch.report?.users || [];
      const rows = [['Source User', 'Destination User', 'Status', 'Files Created', 'Conversations', 'Errors', 'Error Detail']];
      for (const u of users) {
        if (u.errors && u.errors.length > 0) {
          for (const e of u.errors) {
            rows.push([u.email, u.destEmail || '', u.status || '', u.files_created || 0, u.pages_created || 0, u.error_count || 0, e.error_message || e.error || '']);
          }
        } else {
          rows.push([u.email, u.destEmail || '', u.status || '', u.files_created || 0, u.pages_created || 0, u.error_count || 0, '']);
        }
      }
      const csv = rows.map(r => r.map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="g2g_batch_${batch._id}.csv"`);
      res.send(csv);
    } catch (err) {
      console.error('[g2g/reports/:id/csv]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/g2g/reports/aggregate — aggregate stats for G2G migrations
  router.get('/reports/aggregate', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      if (!appUserId) return res.json({ totalBatches: 0, totalConversations: 0, totalErrors: 0, liveBatches: 0 });
      const pipeline = [
        { $match: { appUserId, migDir: 'gemini-gemini', status: 'completed' } },
        { $group: {
          _id: null,
          totalBatches: { $sum: 1 },
          totalConversations: { $sum: '$migratedConversations' },
          totalErrors: { $sum: { $ifNull: ['$totalErrors', 0] } },
          liveBatches: { $sum: { $cond: [{ $ne: ['$dryRun', true] }, 1, 0] } }
        }}
      ];
      const [agg] = await db().collection('migrationWorkspaces').aggregate(pipeline).toArray();
      const result = agg || { totalBatches: 0, totalConversations: 0, totalErrors: 0, liveBatches: 0 };
      delete result._id;
      res.json(result);
    } catch (err) {
      console.error('[g2g/reports/aggregate]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
