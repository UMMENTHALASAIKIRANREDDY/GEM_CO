/**
 * C2G (Copilot → Gemini) routes.
 * All route paths preserved exactly as they were in server.js.
 */

import express from 'express';
import { EventEmitter } from 'events';
import { getLogger } from '../../utils/logger.js';

const dbLog = getLogger('db:ops');

/**
 * @param {{ db: () => import('mongodb').Db, isAuthenticated: Function, getValidToken: Function, getCurrentTenantId: () => string|null }} deps
 */
export function createC2GRouter(deps) {
  const { db, isAuthenticated, getValidToken, getCurrentTenantId } = deps;

  const router = express.Router();

  // C2G SSE log emitter (separate from G2C)
  const c2gLogEmitter = new EventEmitter();
  c2gLogEmitter.setMaxListeners(50);

  function c2gLog(type, message) {
    c2gLogEmitter.emit('log', { type, message, ts: new Date().toISOString() });
  }

  function getWorkspaceContext(req) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    const googleEmail = req.session.googleEmail || null;
    const msEmail = req.session.msEmail || null;
    return { appUserId, googleEmail, msEmail };
  }

  // GET /api/c2g/migrate-log — SSE stream for C2G migration
  router.get('/migrate-log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
    const handler = d => send(d);
    c2gLogEmitter.on('log', handler);
    req.on('close', () => c2gLogEmitter.off('log', handler));
  });

  function requireAuth(req, res, next) {
    if (req.session?.appUser) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  // GET /api/c2g/user-mappings — fetch saved C2G CSV mapping from DB
  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const doc = await db().collection('userMappings').findOne({ appUserId, migDir: 'copilot-gemini' });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/c2g/user-mappings — save C2G CSV mapping to DB
  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId, msEmail, googleEmail } = getWorkspaceContext(req);
      const { mappings, csvEmails } = req.body;
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: 'copilot-gemini' },
        { $set: { migDir: 'copilot-gemini', appUserId, msEmail, googleEmail, mappings, csvEmails, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      dbLog.info(`userMappings.upsert — C2G ${Object.keys(mappings || {}).length} mappings, ${(csvEmails || []).length} CSV emails`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/c2g/user-mappings — remove C2G CSV mapping from DB
  router.delete('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      await db().collection('userMappings').deleteOne({ appUserId, migDir: 'copilot-gemini' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/c2g/migrate — run Copilot→Gemini migration
  router.post('/migrate', requireAuth, async (req, res) => {
    try {
      const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
      const { pairs, folderName, dryRun, fromDate, toDate } = req.body;
      if (!pairs?.length) return res.status(400).json({ error: 'No user pairs provided' });
      const isDryRun = dryRun === true;
      const c2gFolderName = folderName || 'CopilotChats';

      res.json({ started: true });

      const batchId = `c2g_${Date.now()}`;
      const startTime = new Date();

      setImmediate(async () => {
        let files = 0, errors = 0;

        // Create report doc in DB
        try {
          await db().collection('reportsWorkspace').updateOne(
            { _id: batchId },
            { $set: { customerName: c2gFolderName, tenantId: process.env.SOURCE_AZURE_TENANT_ID || process.env.C2G_AZURE_TENANT_ID || '', startTime, status: 'running', dryRun: isDryRun, direction: 'c2g', appUserId, googleEmail, msEmail } },
            { upsert: true }
          );
          dbLog.info(`reportsWorkspace.insert — C2G batch ${batchId} status=running (dryRun=${isDryRun})`);
        } catch (dbErr) { console.error('[C2G] DB insert error:', dbErr.message); }

        try {
          let migModule, svcModule;
          try {
            migModule = await import('./migration/migrate.js');
            svcModule = await import('./copilotService.js');
          } catch (importErr) {
            console.error('[C2G] Import error:', importErr);
            c2gLog('error', `Failed to load C2G module: ${importErr.message}`);
            await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: importErr.message } }).catch(() => {});
            c2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }
          const { runMigration: runC2G } = migModule;
          const { createSourceGraphClient, listDirectoryUsers } = svcModule;

          // Apply tenant ID from session if available
          const currentTenantId = getCurrentTenantId?.();
          if (currentTenantId) {
            if (!process.env.SOURCE_AZURE_TENANT_ID && !process.env.C2G_AZURE_TENANT_ID) process.env.SOURCE_AZURE_TENANT_ID = currentTenantId;
            if (!process.env.AZURE_TENANT_ID) process.env.AZURE_TENANT_ID = currentTenantId;
          }

          c2gLog('info', 'Resolving user IDs from Microsoft directory...');
          let allMsUsers = [];
          try {
            const { accessToken } = await createSourceGraphClient();
            allMsUsers = await listDirectoryUsers(accessToken);
          } catch (appTokenErr) {
            const msToken = isAuthenticated(appUserId) ? await getValidToken(appUserId).catch(() => null) : null;
            if (msToken) {
              let url = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999';
              while (url) {
                const r = await fetch(url, { headers: { Authorization: `Bearer ${msToken}` } });
                const d = await r.json();
                allMsUsers = allMsUsers.concat(d.value || []);
                url = d['@odata.nextLink'] || null;
              }
            } else {
              c2gLog('error', `Cannot fetch MS users: ${appTokenErr.message}. Connect Microsoft account first.`);
              await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: appTokenErr.message } }).catch(() => {});
              c2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
              return;
            }
          }

          c2gLog('info', `Found ${allMsUsers.length} users in directory`);

          const userMap = {};
          allMsUsers.forEach(u => { userMap[(u.mail || u.userPrincipalName || '').toLowerCase()] = u; });

          const migPairs = pairs.map(p => {
            const u = userMap[p.sourceEmail.toLowerCase()];
            return { sourceUserId: u?.id, sourceDisplayName: u?.displayName || p.sourceEmail, destUserEmail: p.destEmail, sourceEmail: p.sourceEmail };
          }).filter(p => p.sourceUserId);

          if (!migPairs.length) {
            c2gLog('error', 'No valid user pairs found. Check that the M365 emails exist in the tenant.');
            await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: 'No valid user pairs', totalUsers: 0 } }).catch(() => {});
            c2gLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { totalUsers: migPairs.length } }).catch(() => {});

          c2gLog('info', `Starting C2G ${isDryRun ? 'dry run' : 'migration'} for ${migPairs.length} user pair(s)...`);

          if (isDryRun) {
            const { getCopilotInteractionsForUser } = svcModule;
            const reportUsers = [];
            for (const p of migPairs) {
              try {
                const { accessToken: at } = await createSourceGraphClient();
                const interactions = await getCopilotInteractionsForUser(at, p.sourceUserId, {});
                const sessions = new Map();
                for (const item of interactions) { const sid = item.sessionId || 'unknown'; if (!sessions.has(sid)) sessions.set(sid, []); sessions.get(sid).push(item); }
                c2gLog('info', `${p.sourceDisplayName} → ${p.destUserEmail}: ${interactions.length} interactions, ${sessions.size} conversations`);
                reportUsers.push({ email: p.sourceEmail, destEmail: p.destUserEmail, displayName: p.sourceDisplayName, status: 'success', pages_created: sessions.size, conversations_processed: sessions.size, error_count: 0, errors: [] });
                files += sessions.size;
              } catch (e) {
                c2gLog('warn', `${p.sourceDisplayName}: ${e.message}`);
                reportUsers.push({ email: p.sourceEmail, destEmail: p.destUserEmail, displayName: p.sourceDisplayName, status: 'failed', pages_created: 0, conversations_processed: 0, error_count: 1, errors: [{ error_message: e.message }] });
                errors++;
              }
            }
            await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: {
              status: 'completed', endTime: new Date(), dryRun: true, totalUsers: migPairs.length,
              migratedConversations: files, migratedUsers: reportUsers.filter(u => u.status === 'success').length,
              failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors,
              report: { summary: { total_users: migPairs.length, total_pages_created: files, total_errors: errors }, users: reportUsers }
            } }).catch(() => {});
            c2gLog('done', JSON.stringify({ files, errors, users: migPairs.length, batchId }));
            return;
          }

          // Live migration
          const migOpts = { folderName: c2gFolderName };
          if (fromDate) migOpts.fromDate = fromDate;
          if (toDate) migOpts.toDate = toDate;
          const { migrateUserPair } = migModule;
          const results = [];
          const reportUsers = [];

          c2gLog('info', `Starting C2G migration for ${migPairs.length} user pair(s)...`);
          c2gLog('total', JSON.stringify({ total: migPairs.length }));

          for (const pair of migPairs) {
            c2gLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destUserEmail}`);
            const r = await migrateUserPair(
              { sourceUserId: pair.sourceUserId, sourceDisplayName: pair.sourceDisplayName, destUserEmail: pair.destUserEmail },
              migOpts
            );
            results.push(r);

            const userReport = {
              email: r.sourceEmail || pair.sourceEmail || pair.sourceDisplayName,
              destEmail: r.destUserEmail, displayName: r.sourceDisplayName,
              status: r.errors?.length ? (r.filesUploaded > 0 ? 'partial' : 'failed') : 'success',
              pages_created: r.filesUploaded || 0, conversations_processed: r.conversationsCount || 0,
              error_count: (r.errors || []).length,
              errors: (r.errors || []).map(e => ({ error_message: e })),
              files: r.files || [],
            };
            reportUsers.push(userReport);

            if (r.errors?.length) {
              console.error(`[C2G] ${r.sourceDisplayName} errors:`, r.errors.join(' | '));
              r.errors.forEach(err => {
                let friendly = err;
                if (err.includes('invalid_grant') || err.includes('Invalid email or User ID')) {
                  friendly = `Google rejected destination "${r.destUserEmail}". Verify the email exists in Google Workspace and the service account has Domain-Wide Delegation.`;
                } else if (err.includes('Service account key file not found')) {
                  friendly = `Service account JSON file is missing. Check GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env.`;
                } else if (err.includes('Copilot license')) {
                  friendly = `${r.sourceDisplayName} does not have a Microsoft 365 Copilot license assigned.`;
                } else if (err.includes('No Copilot conversations')) {
                  friendly = `${r.sourceDisplayName} has no Copilot chat history to migrate.`;
                }
                c2gLog('warn', friendly);
              });
            }
            files += r.filesUploaded || 0;
            errors += (r.errors || []).length;
            c2gLog(r.errors?.length ? 'warn' : 'success', `${r.sourceDisplayName} → ${r.destUserEmail}: ${r.filesUploaded || 0} files uploaded, ${(r.errors||[]).length} error(s)`);
            c2gLog('progress', JSON.stringify({ files, errors, users: results.length, total: migPairs.length }));
          }

          const reportUpdate = {
            status: errors > 0 && files === 0 ? 'failed' : 'completed', endTime: new Date(),
            totalUsers: migPairs.length, migratedConversations: files,
            migratedUsers: reportUsers.filter(u => u.status === 'success' || u.status === 'partial').length,
            failedUsers: reportUsers.filter(u => u.status === 'failed').length, totalErrors: errors,
            report: {
              summary: { total_users: migPairs.length, total_pages_created: files, total_errors: errors, total_conversations: reportUsers.reduce((s, u) => s + u.conversations_processed, 0) },
              users: reportUsers,
            },
          };
          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: reportUpdate }).catch(() => {});
          dbLog.info(`reportsWorkspace.update — C2G batch ${batchId} status=${reportUpdate.status} (${files} files, ${migPairs.length} users)`);
          c2gLog('done', JSON.stringify({ files, errors, users: migPairs.length, batchId }));
        } catch (e) {
          console.error('[C2G] Unhandled error:', e);
          c2gLog('error', e.message || String(e));
          await db().collection('reportsWorkspace').updateOne({ _id: batchId }, { $set: { status: 'failed', endTime: new Date(), error: e.message } }).catch(() => {});
          c2gLog('done', JSON.stringify({ files, errors, users: 0, batchId }));
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
