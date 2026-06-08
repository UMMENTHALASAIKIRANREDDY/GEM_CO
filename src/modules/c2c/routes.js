/**
 * C2C (Copilot → Copilot) routes.
 *
 * Mirrors C2G's structure but:
 *   - Source side fetches Copilot data from a chosen SOURCE tenant
 *   - Destination side uploads DOCX files to a chosen DESTINATION tenant's OneDrive
 *   - Tenants are managed via per-tenant admin consent flow → /api/c2c/connected-tenants
 */

import express from 'express';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { getLogger } from '../../utils/logger.js';
import {
  getTenantAccessToken,
  clearTenantToken,
  readC2CAppSummary,
} from './multiTenantAuth.js';
import { buildAdminConsentUrl, fetchTenantInfo } from './tenantConsent.js';
import { listDestTenantUsers } from './destGraph.js';

const dbLog = getLogger('db:ops');
const log = getLogger('c2c:routes');

export function createC2CRouter(deps) {
  const { db } = deps;
  const router = express.Router();

  const c2cLogEmitter = new EventEmitter();
  c2cLogEmitter.setMaxListeners(50);

  function c2cLog(type, message) {
    c2cLogEmitter.emit('log', { type, message, ts: new Date().toISOString() });
  }

  function getWorkspaceContext(req) {
    const appUserId = req.session?.appUser?._id?.toString() || null;
    return { appUserId };
  }

  function requireAuth(req, res, next) {
    if (req.session?.appUser) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  // ── Settings / summary ──────────────────────────────────────────────

  // GET /api/c2c/settings — app-level config visible to UI
  router.get('/settings', requireAuth, (req, res) => {
    res.json(readC2CAppSummary());
  });

  // POST /api/c2c/tenants/:tenantId/refresh-token — clear cached token and force fresh acquisition.
  // Use after granting new permissions in Azure so the next API call picks up the new scope.
  router.post('/tenants/:tenantId/refresh-token', requireAuth, async (req, res) => {
    try {
      clearTenantToken(req.params.tenantId);
      const token = await getTenantAccessToken(req.params.tenantId);
      res.json({ ok: true, tokenLength: token.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Tenant consent flow ─────────────────────────────────────────────

  // GET /api/c2c/consent-url — build a fresh consent URL for popup
  // The state token carries appUserId so we know who initiated it on callback.
  router.get('/consent-url', requireAuth, (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const state = crypto.randomBytes(16).toString('hex');
      // Persist the state ⇒ appUserId mapping for ~10 min so callback can correlate.
      // Using session is fine here — single-tenant per-user flow.
      req.session._c2cConsentState = req.session._c2cConsentState || {};
      req.session._c2cConsentState[state] = { appUserId, ts: Date.now() };
      // Garbage collect old states
      const now = Date.now();
      for (const [k, v] of Object.entries(req.session._c2cConsentState)) {
        if (now - v.ts > 10 * 60_000) delete req.session._c2cConsentState[k];
      }

      const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      // Reuse the OAuth redirect URI — /auth/callback handles both code-exchange
      // and admin_consent return paths, so only ONE redirect URI needs to be
      // registered in Azure.
      const redirectUri = `${base.replace(/\/+$/, '')}/auth/callback`;

      const url = buildAdminConsentUrl({ redirectUri, state });
      res.json({ url, state });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/c2c/connected-tenants — list tenants consented by this app user.
  // If the user has NO Microsoft accounts signed in this session, auto-revoke
  // any lingering tenant consents from prior sessions and return an empty list.
  // This matches user expectation: "0 clouds connected = empty C2C state".
  router.get('/connected-tenants', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      // Lazy import to avoid circular dep; getMsAccounts is from server.js auth layer
      const { getMsAccounts } = await import('../../core/auth/microsoft.js');
      const hasMsAccounts = (getMsAccounts?.(appUserId) || []).length > 0;
      if (!hasMsAccounts) {
        // Soft-revoke any active consents — user is in a "no clouds connected"
        // state and shouldn't see stale tenants from a prior session.
        const result = await db().collection('connectedTenants').updateMany(
          { appUserId, consentState: { $ne: 'revoked' } },
          { $set: { consentState: 'revoked', revokedAt: new Date(), revokeReason: 'no_ms_accounts_in_session' } }
        );
        if (result.modifiedCount > 0) {
          console.log(`[c2c] auto-revoked ${result.modifiedCount} stale tenant consent(s) for appUserId=${appUserId} (no MS accounts)`);
        }
        return res.json({ tenants: [] });
      }
      const tenants = await db().collection('connectedTenants')
        .find({ appUserId, consentState: { $ne: 'revoked' } })
        .sort({ consentedAt: -1 })
        .toArray();
      res.json({ tenants: tenants.map(t => ({
        tenantId: t.tenantId,
        displayName: t.displayName,
        defaultDomain: t.defaultDomain,
        consentedAt: t.consentedAt,
      })) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/c2c/connected-tenants/:tenantId — soft-remove (mark revoked + clear cache)
  router.delete('/connected-tenants/:tenantId', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { tenantId } = req.params;
      await db().collection('connectedTenants').updateOne(
        { appUserId, tenantId },
        { $set: { consentState: 'revoked', revokedAt: new Date() } }
      );
      clearTenantToken(tenantId);
      // ConversationStore: drop rows where this tenant was source OR destination
      try {
        const { deleteByTenant } = await import('../_shared/conversationStore.js');
        await deleteByTenant(appUserId, tenantId);
      } catch (e) { /* non-fatal */ }
      // Wipe the saved C2C mapping doc + C2C session state. The mapping doc
      // stores sourceTenantId/destTenantId but the read endpoint doesn't
      // filter by them, so leaving the doc behind causes the User Mapping
      // screen to show stale destinations after the user reconnects a
      // different tenant.
      await db().collection('userMappings').deleteOne({ appUserId, migDir: 'copilot-copilot' });
      await db().collection('c2cSessions').deleteOne({ appUserId });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/c2c/tenants/:tenantId/users — list users in a destination tenant
  // Used for the destination-user dropdown in the user-mapping step.
  router.get('/tenants/:tenantId/users', requireAuth, async (req, res) => {
    try {
      const { tenantId } = req.params;
      const users = await listDestTenantUsers(tenantId);
      res.json({ total: users.length, users });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Migration log (SSE) ─────────────────────────────────────────────

  // GET /api/c2c/migrate-log — SSE stream
  router.get('/migrate-log', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
    const handler = d => send(d);
    c2cLogEmitter.on('log', handler);
    req.on('close', () => c2cLogEmitter.off('log', handler));
  });

  // ── User mappings (saved per app user + migDir) ─────────────────────

  router.get('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const doc = await db().collection('userMappings').findOne({ appUserId, migDir: 'copilot-copilot' });
      res.json(doc || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { mappings, csvEmails, sourceTenantId, destTenantId } = req.body;
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: 'copilot-copilot' },
        {
          $set: {
            migDir: 'copilot-copilot', appUserId,
            mappings, csvEmails, sourceTenantId, destTenantId,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
      dbLog.info(`userMappings.upsert — C2C ${Object.keys(mappings || {}).length} mappings`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/user-mappings', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      await db().collection('userMappings').updateOne(
        { appUserId, migDir: 'copilot-copilot' },
        { $set: { mappings: {}, csvEmails: null, updatedAt: new Date() } }
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Session (UI state persistence) ──────────────────────────────────

  router.get('/session', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const doc = await db().collection('c2cSessions').findOne({ appUserId });
      if (doc) {
        return res.json({ ...doc, _id: undefined, appUserId: undefined });
      }
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/session', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { c2cConfig, c2cMappings, c2cSelectedUsers, c2cOptions } = req.body;
      await db().collection('c2cSessions').updateOne(
        { appUserId },
        {
          $set: {
            appUserId, c2cConfig, c2cMappings,
            c2cSelectedUsers: Array.from(c2cSelectedUsers || []),
            c2cOptions, lastUpdated: new Date(),
          },
        },
        { upsert: true }
      );
      res.json({ saved: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/session', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      await db().collection('c2cSessions').deleteOne({ appUserId });
      res.json({ cleared: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Reports (per-batch detail, list, CSV) ───────────────────────────

  router.get('/reports', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      if (!appUserId) return res.json([]);
      const reports = await db().collection('migrationWorkspaces')
        .find({ appUserId, migDir: 'copilot-copilot' }, { projection: { report: 0 } })
        .sort({ startTime: -1 }).toArray();
      res.json(reports);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/reports/aggregate', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      if (!appUserId) return res.json({ totalBatches: 0, totalConversations: 0, totalErrors: 0, liveBatches: 0 });
      const pipeline = [
        { $match: { appUserId, migDir: 'copilot-copilot', status: 'completed' } },
        { $group: {
          _id: null,
          totalBatches: { $sum: 1 },
          totalConversations: { $sum: '$migratedConversations' },
          totalErrors: { $sum: { $ifNull: ['$totalErrors', 0] } },
          liveBatches: { $sum: { $cond: [{ $ne: ['$dryRun', true] }, 1, 0] } },
        }},
      ];
      const [agg] = await db().collection('migrationWorkspaces').aggregate(pipeline).toArray();
      const result = agg || { totalBatches: 0, totalConversations: 0, totalErrors: 0, liveBatches: 0 };
      delete result._id;
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/reports/:id', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const batch = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId, migDir: 'copilot-copilot' });
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      const users = (batch.users || batch.report?.users || []).map(u => ({
        email: u.email, destEmail: u.destEmail,
        status: u.status || 'pending',
        conversations_processed: u.conversations_processed ?? u.pages_created ?? 0,
        migrated_conversations: u.migrated_conversations
          ?? (u.status === 'success' ? (u.conversations_processed ?? u.pages_created ?? 0) : (u.pages_created ?? 0)),
        files_uploaded: u.files_uploaded ?? u.files_created ?? 0,
        pages_created: u.pages_created || u.files_created || 0,
        files_created: u.files_created || 0,
        error_count: u.error_count || (u.errors?.length || 0),
        errors: u.errors || [],
      }));
      res.json({
        _id: batch._id, customerName: batch.customerName,
        direction: batch.direction || 'c2c', migDir: batch.migDir,
        status: batch.status, dryRun: batch.dryRun,
        startTime: batch.startTime, endTime: batch.endTime,
        totalUsers: batch.totalUsers || 0,
        totalConversations: batch.totalConversations || batch.migratedConversations || 0,
        migratedConversations: batch.migratedConversations || 0,
        filesUploaded: batch.filesUploaded || 0,
        totalErrors: batch.totalErrors || 0,
        users,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/reports/:id/errors', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const batch = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId, migDir: 'copilot-copilot' });
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      const flat = [];
      for (const u of (batch.users || batch.report?.users || [])) {
        for (const e of (u.errors || [])) {
          flat.push({ email: u.email, destEmail: u.destEmail, conversation: e.conversation || '', error: e.error_message || e.error || '' });
        }
      }
      res.json({ errors: flat });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/reports/:id/csv', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const batch = await db().collection('migrationWorkspaces').findOne({ _id: req.params.id, appUserId, migDir: 'copilot-copilot' });
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      const { buildBatchCsv } = await import('../_shared/csvExport.js');
      const csv = buildBatchCsv(batch);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="c2c_batch_${batch._id}.csv"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Main migration trigger ──────────────────────────────────────────

  // POST /api/c2c/migrate
  // Body: { sourceTenantId, destTenantId, pairs: [{sourceEmail, destEmail}], folderName, dryRun, fromDate, toDate }
  router.post('/migrate', requireAuth, async (req, res) => {
    try {
      const { appUserId } = getWorkspaceContext(req);
      const { sourceTenantId, destTenantId, pairs, folderName, dryRun, fromDate, toDate, destAccountId } = req.body;

      if (!sourceTenantId) return res.status(400).json({ error: 'sourceTenantId required' });
      if (!destTenantId) return res.status(400).json({ error: 'destTenantId required' });
      if (!pairs?.length) return res.status(400).json({ error: 'No user pairs provided' });

      // Resolve the destination admin's MS account in our session map. OneNote
      // app-only API is deprecated by Microsoft, so we need a delegated token
      // from the dest tenant admin to write pages on behalf of each dest user.
      let resolvedDestAccountId = destAccountId || null;
      let adminEmailForGrant = null;
      try {
        const { getMsAccounts } = await import('../../core/auth/microsoft.js');
        const accounts = getMsAccounts(appUserId) || [];
        if (!resolvedDestAccountId) {
          const match = accounts.find(a => a.tenantId === destTenantId);
          if (match) resolvedDestAccountId = match.accountId;
        }
        const adminAcct = accounts.find(a => a.accountId === resolvedDestAccountId);
        adminEmailForGrant = adminAcct?.email || null;
      } catch {}
      if (!resolvedDestAccountId && !(dryRun === true || dryRun === 'true')) {
        return res.status(400).json({
          error: 'Destination admin not signed in. Connect a Microsoft admin account for the destination tenant in Connect Clouds, then try again.',
        });
      }
      // Look up admin's tenant-side user GUID. Required for the just-in-time
      // site-owner grant (Microsoft's permission API needs the user id).
      let adminUserIdInDestTenant = null;
      if (resolvedDestAccountId && adminEmailForGrant && !(dryRun === true || dryRun === 'true')) {
        try {
          const { resolveAdminUserIdInTenant } = await import('./sitePermissions.js');
          adminUserIdInDestTenant = await resolveAdminUserIdInTenant(destTenantId, adminEmailForGrant);
        } catch {}
      }
      const destDelegatedAuth = resolvedDestAccountId
        ? { appUserId, accountId: resolvedDestAccountId, adminUserId: adminUserIdInDestTenant, adminEmail: adminEmailForGrant }
        : null;

      res.json({ started: true });

      const batchId = `c2c_${Date.now()}`;
      const startTime = new Date();
      const resumeContext = {
        kind: 'c2c',
        appUserId,
        sourceTenantId, destTenantId,
        pairs, folderName, dryRun, fromDate, toDate,
        destAccountId: resolvedDestAccountId,
      };

      setImmediate(() => executeC2CMigration({ batchId, startTime, resumeContext, isResume: false, destDelegatedAuth }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function executeC2CMigration({ batchId, startTime, resumeContext, isResume, destDelegatedAuth: destDelegatedAuthOverride }) {
    const { appUserId, sourceTenantId, destTenantId, pairs, folderName, dryRun, fromDate, toDate, destAccountId } = resumeContext;
    const isDryRun = dryRun === true || dryRun === 'true';
    const c2cFolderName = folderName || 'CopilotChats';

    // On boot resume, re-resolve destDelegatedAuth from saved destAccountId.
    // Microsoft session is restored during boot; if expired we still try and
    // the underlying call will fail with a clear error.
    let destDelegatedAuth = destDelegatedAuthOverride;
    if (!destDelegatedAuth && destAccountId) {
      let adminEmailForGrant = null;
      let adminUserIdInDestTenant = null;
      try {
        const { getMsAccounts } = await import('../../core/auth/microsoft.js');
        const accounts = getMsAccounts(appUserId) || [];
        const adminAcct = accounts.find(a => a.accountId === destAccountId);
        adminEmailForGrant = adminAcct?.email || null;
      } catch {}
      if (adminEmailForGrant && !isDryRun) {
        try {
          const { resolveAdminUserIdInTenant } = await import('./sitePermissions.js');
          adminUserIdInDestTenant = await resolveAdminUserIdInTenant(destTenantId, adminEmailForGrant);
        } catch {}
      }
      destDelegatedAuth = { appUserId, accountId: destAccountId, adminUserId: adminUserIdInDestTenant, adminEmail: adminEmailForGrant };
    }

    {
        let files = 0, errors = 0;
        const { startHeartbeat, stopHeartbeat, markUserPairMigrated, markUserPairFailed } = await import('../_shared/conversationStore.js');
        let _heartbeatId = null;
        try {
          await db().collection('migrationWorkspaces').updateOne(
            { _id: batchId },
            { $set: {
              migDir: 'copilot-copilot', customerName: c2cFolderName, direction: 'c2c',
              sourceTenantId, destTenantId, startTime, status: 'running',
              dryRun: isDryRun, appUserId,
              fromDate: fromDate || null, toDate: toDate || null,
              totalUsers: pairs.length, migratedConversations: 0, filesUploaded: 0, totalErrors: 0,
              lastHeartbeat: new Date(),
              resumeContext, ...(isResume ? { resumedAt: new Date() } : {}),
            }},
            { upsert: true }
          );
          dbLog.info(`migrationWorkspaces.insert — C2C batch ${batchId} status=running`);
          _heartbeatId = startHeartbeat(batchId);

          // Pre-flight validator (only on dry-run; additive)
          if (isDryRun) {
            try {
              const { runDryRunValidator } = await import('../dry-run/validator.js');
              // Acquire app-only tokens up front so the validator can actually
              // verify Copilot access in source + OneNote access in dest.
              // Without these, the validator flags "Could not acquire ... Graph
              // token" as a hard blocker — even when consent is already granted.
              let preflightSourceToken = null;
              let preflightDestToken = null;
              try { preflightSourceToken = await getTenantAccessToken(sourceTenantId); }
              catch (e) { dbLog.warn(`[C2C dry-run] source tenant token failed: ${e.message}`); }
              try { preflightDestToken = await getTenantAccessToken(destTenantId); }
              catch (e) { dbLog.warn(`[C2C dry-run] dest tenant token failed: ${e.message}`); }

              const dryRunReport = await runDryRunValidator({
                migDir: 'copilot-copilot',
                pairs: pairs.map(p => ({ sourceEmail: p.sourceEmail, destEmail: p.destEmail, expectedConversationCount: p.expectedConversationCount || 0 })),
                config: { folderName: c2cFolderName, dryRun: true },
                appUserId,
                sourceTenantId, destTenantId,
                sourceToken: preflightSourceToken,
                destToken: preflightDestToken,
              });
              await db().collection('migrationWorkspaces').updateOne(
                { _id: batchId },
                { $set: { dryRunReport } }
              ).catch(() => {});
              dbLog.info(`[C2C] Dry-run validator: ${dryRunReport.summary.ready} ready · ${dryRunReport.summary.warning} warning · ${dryRunReport.summary.blocker} blocker`);
            } catch (e) {
              dbLog.warn(`[C2C] Dry-run validator failed: ${e.message}`);
            }
          }
        } catch (e) { log.error('DB insert error:', e.message); }

        try {
          // Acquire source-tenant token + resolve source user IDs
          c2cLog('info', `Resolving source users in tenant ${sourceTenantId}...`);
          let sourceToken;
          try {
            sourceToken = await getTenantAccessToken(sourceTenantId);
          } catch (e) {
            c2cLog('error', `Source tenant token failed: ${e.message}`);
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'copilot-copilot', status: 'failed', endTime: new Date(), error: e.message } }).catch(() => {});
            c2cLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          // List source users to resolve emails → GUIDs
          let allSrcUsers = [];
          try {
            let url = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999';
            while (url) {
              const r = await fetch(url, { headers: { Authorization: `Bearer ${sourceToken}` } });
              const d = await r.json();
              if (!r.ok) throw new Error(d.error?.message || `Graph users list failed (${r.status})`);
              allSrcUsers = allSrcUsers.concat(d.value || []);
              url = d['@odata.nextLink'] || null;
            }
          } catch (e) {
            c2cLog('error', `Cannot list source users: ${e.message}`);
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'copilot-copilot', status: 'failed', endTime: new Date(), error: e.message } }).catch(() => {});
            c2cLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }
          c2cLog('info', `Found ${allSrcUsers.length} users in source tenant`);

          const srcMap = {};
          allSrcUsers.forEach(u => { srcMap[(u.mail || u.userPrincipalName || '').toLowerCase()] = u; });

          const migPairs = pairs.map(p => {
            const u = srcMap[String(p.sourceEmail || '').toLowerCase()];
            return {
              sourceTenantId,
              destTenantId,
              sourceUserId: u?.id,
              sourceDisplayName: u?.displayName || p.sourceEmail,
              sourceEmail: p.sourceEmail,
              destUserEmail: p.destEmail,
            };
          }).filter(p => p.sourceUserId);

          if (!migPairs.length) {
            c2cLog('error', 'No valid user pairs found. Check that source emails exist in the source tenant.');
            await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'copilot-copilot', status: 'failed', endTime: new Date(), error: 'No valid user pairs', totalUsers: 0 } }).catch(() => {});
            c2cLog('done', JSON.stringify({ files: 0, errors: 1, users: 0, batchId }));
            return;
          }

          await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'copilot-copilot', totalUsers: migPairs.length } }).catch(() => {});

          c2cLog('info', `Starting C2C ${isDryRun ? 'dry run' : 'migration'} for ${migPairs.length} user pair(s)...`);
          c2cLog('total', JSON.stringify({ total: migPairs.length }));

          const { migrateC2CUserPair } = await import('./migration/migrate.js');
          const reportUsers = [];
          const runOpts = {
            folderName: c2cFolderName,
            dryRun: isDryRun,
            // Context plumbed for conversationStore persistence
            batchId,
            appUserId,
          };
          if (fromDate) runOpts.fromDate = fromDate;
          if (toDate) runOpts.toDate = toDate;
          if (isResume) runOpts.isResume = true;

          // Resolve source tenant display name for OneNote footers + folder name
          let sourceLabel = sourceTenantId;
          try {
            const { fetchTenantInfo } = await import('./tenantConsent.js');
            const info = await fetchTenantInfo(sourceTenantId);
            sourceLabel = info?.displayName || info?.defaultDomain || sourceTenantId;
          } catch {}

          let totalPages = 0;
          let totalConversations = 0;

          for (const pair of migPairs) {
            c2cLog('info', `Processing: ${pair.sourceDisplayName} → ${pair.destUserEmail}`);
            // Inject per-pair sourceEmail into runOpts for store persistence
            const perPairRunOpts = { ...runOpts, sourceEmail: pair.sourceEmail || pair.sourceUpn || null };
            const r = await migrateC2CUserPair(
              { ...pair, sourceLabel, runOpts: perPairRunOpts, destDelegatedAuth },
              ({ pagesCreated, filesUploaded, convIdx, totalConvs }) => {
                c2cLog('progress', JSON.stringify({
                  files: totalPages + (pagesCreated || 0),
                  pages: totalPages + (pagesCreated || 0),
                  conversations: totalConversations + (convIdx || 0),
                  errors,
                  users: reportUsers.length,
                  total: migPairs.length,
                  convIdx, totalConvs,
                }));
              }
            );

            const _convCount = r.conversationsCount || 0;
            const _pagesCreated = r.pagesCreated || 0;
            const _status = r.errors?.length ? (_pagesCreated > 0 ? 'partial' : 'failed') : 'success';
            const userReport = {
              email: pair.sourceEmail, destEmail: pair.destUserEmail,
              displayName: pair.sourceDisplayName,
              status: _status,
              pages_created: _pagesCreated,
              conversations_processed: _convCount,
              // OneNote pages == conversations migrated for C2C.
              migrated_conversations: _pagesCreated,
              files_created: r.filesUploaded || 0,
              // Attachment files only — r.filesUploaded counts attachments
              // uploaded to OneDrive (separate from the OneNote pages).
              files_uploaded: r.filesUploaded || 0,
              error_count: (r.errors || []).length,
              errors: (r.errors || []).map(e => ({ error_message: e })),
              files: r.pages || [],
            };
            reportUsers.push(userReport);

            // Mark conversationStore rows for this user pair
            if (!isDryRun) {
              if (userReport.status === 'failed') {
                await markUserPairFailed({ appUserId, batchId, sourceEmail: pair.sourceEmail, error: (r.errors || [])[0] || 'unknown' });
              } else {
                await markUserPairMigrated({ appUserId, batchId, sourceEmail: pair.sourceEmail, destEmail: pair.destUserEmail });
              }
            }

            if (r.errors?.length) {
              r.errors.forEach(err => c2cLog('warn', `${pair.sourceDisplayName}: ${err}`));
            }
            totalPages += r.pagesCreated || 0;
            totalConversations += r.conversationsCount || 0;
            files = totalPages; // legacy stat name kept for compatibility with existing UI/log handler
            errors += (r.errors || []).length;
            c2cLog(r.errors?.length ? 'warn' : 'success', `${pair.sourceDisplayName} → ${pair.destUserEmail}: ${r.pagesCreated || 0} pages, ${r.conversationsCount || 0} conversations, ${(r.errors || []).length} error(s)`);
            c2cLog('progress', JSON.stringify({
              files: totalPages, pages: totalPages, conversations: totalConversations,
              errors, users: reportUsers.length, total: migPairs.length,
            }));

            // Incremental progress write so the Reports panel (which polls every
            // 3s) can show how many conversations have been migrated SO FAR — not
            // just at the end of the run. Without this, the Reports panel shows
            // 0 conversations for hours while the migration is actually working.
            // We update conservatively (only the running totals + the users[]
            // array as it grows) so the final reportUpdate write isn't pre-empted.
            await db().collection('migrationWorkspaces').updateOne(
              { _id: batchId },
              {
                $set: {
                  progressUsers: reportUsers.length,
                  progressPages: totalPages,
                  progressConversations: totalConversations,
                  progressErrors: errors,
                  users: reportUsers,        // partial array; final overwrite happens at end
                  lastProgressAt: new Date(),
                },
              }
            ).catch(() => {});
          }

          // Deploy the "Copilot Conversation Agent" to the destination tenant's
          // Teams catalog (mirrors G2C's behavior). Uses the destination admin's
          // delegated token. Dedup: if already published in this tenant, skip.
          if (!isDryRun && totalPages > 0 && destDelegatedAuth?.appUserId) {
            c2cLog('info', '━━━ Deploying Copilot Agent ━━━');
            try {
              const { AgentDeployer } = await import('../../agent/agentDeployer.js');
              const agentName = 'Copilot Conversation Agent';
              const deployer = new AgentDeployer(
                c2cFolderName, destTenantId,
                {
                  accountId: destDelegatedAuth.accountId,
                  agentName,
                  sourceLabel: sourceLabel || 'Copilot',
                  // Universal 2-subfolder layout (Phase 2):
                  //   {c2cFolderName}/Conversations/...docx
                  //   {c2cFolderName}/Migrated from Copilot/...attachments
                  conversationsFolder: `${c2cFolderName}/Conversations`,
                  attachmentsFolder: `${c2cFolderName}/Migrated from Copilot`,
                  declarativeAgentId: 'copilotConversationAgent',
                  starterTopic: `What did I discuss in my migrated Copilot conversations?`,
                  starterCompare: `Summarize my most recent migrated Copilot conversation`,
                },
                destDelegatedAuth.appUserId
              );
              const appInfo = await deployer.deployAgent();
              if (appInfo.alreadyExisted) {
                c2cLog('info', `Agent "${agentName}" already in destination catalog — skipping publish.`);
              } else {
                c2cLog('success', `Agent "${agentName}" published to destination Teams catalog (id: ${appInfo.id}).`);
              }
              c2cLog('info', appInfo.installInstructions);
              await db().collection('agentDeployments').updateOne(
                { appUserId, tenantId: destTenantId, agentName },
                { $set: {
                  appUserId, tenantId: destTenantId, batchId, agentName,
                  catalogId: appInfo.id, alreadyExisted: !!appInfo.alreadyExisted,
                  direction: 'c2c', status: 'deployed', deployedAt: new Date(),
                } },
                { upsert: true }
              );
              dbLog.info(`agentDeployments.upsert — "${agentName}" (catalog id: ${appInfo.id})`);
            } catch (e) {
              c2cLog('warn', `Agent deployment failed (you can deploy manually from Teams admin): ${e.message}`);
              dbLog.warn(`C2C agentDeployer failed: ${e.message}`);
            }
          }

          // Sum of per-user migrated_conversations (0 for failed users) — this
          // is what's actually delivered. Distinct from totalConversations
          // (= count found in source). For dry-runs, force migrated to 0 too
          // since nothing was actually written.
          const migratedConvSum = isDryRun
            ? 0
            : reportUsers.reduce((s, u) => s + (u.migrated_conversations || 0), 0);
          const reportUpdate = {
            status: errors > 0 && totalPages === 0 && !isDryRun ? 'failed' : 'completed',
            endTime: new Date(),
            totalUsers: migPairs.length,
            totalConversations: totalConversations,
            migratedConversations: migratedConvSum,
            migratedUsers: reportUsers.filter(u => u.status === 'success' || u.status === 'partial').length,
            failedUsers: reportUsers.filter(u => u.status === 'failed').length,
            filesUploaded: totalPages,
            pagesCreated: totalPages,
            totalErrors: errors,
            users: reportUsers,
            report: {
              summary: {
                total_users: migPairs.length,
                total_pages_created: totalPages,
                total_files_created: totalPages,
                total_conversations: totalConversations,
                total_migrated_conversations: migratedConvSum,
                total_errors: errors,
              },
              users: reportUsers,
            },
          };
          await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'copilot-copilot', ...reportUpdate } }).catch(() => {});
          dbLog.info(`migrationWorkspaces.update — C2C batch ${batchId} status=${reportUpdate.status} (${totalPages} pages, ${totalConversations} conversations, ${migPairs.length} users)`);
          c2cLog('done', JSON.stringify({
            files: totalPages, pages: totalPages, conversations: totalConversations,
            errors, users: migPairs.length, batchId, batch_id: batchId,
          }));
        } catch (e) {
          log.error('Unhandled error:', e.message);
          c2cLog('error', e.message || String(e));
          await db().collection('migrationWorkspaces').updateOne({ _id: batchId }, { $set: { migDir: 'copilot-copilot', status: 'failed', endTime: new Date(), error: e.message } }).catch(() => {});
          c2cLog('done', JSON.stringify({ files, errors, users: 0, batchId }));
        } finally {
          stopHeartbeat(_heartbeatId);
        }
      }
  }

  router.executeC2CMigration = executeC2CMigration;

  return router;
}

// ─── Tenant consent callback handler ────────────────────────────────
// Exported separately so server.js can register it at /auth/* (outside the /api prefix)
//
export function createTenantConsentCallback(deps) {
  const { db } = deps;
  return async (req, res) => {
    try {
      const { tenant, state, error, error_description, admin_consent } = req.query;

      // Validate state — must match what we stored in session
      const stateMap = req.session?._c2cConsentState || {};
      const stateEntry = state ? stateMap[state] : null;
      if (!stateEntry) {
        return res.status(400).send(_consentResultHtml({
          ok: false,
          message: 'Invalid or expired consent state. Please try again.',
        }));
      }
      delete req.session._c2cConsentState[state];

      if (error || admin_consent !== 'True') {
        return res.status(400).send(_consentResultHtml({
          ok: false,
          message: error_description || error || 'Consent was not granted.',
        }));
      }

      if (!tenant) {
        return res.status(400).send(_consentResultHtml({
          ok: false,
          message: 'Microsoft did not return a tenant id.',
        }));
      }

      // Fetch tenant display name + default domain via Graph (best-effort)
      const info = await fetchTenantInfo(tenant);

      // Upsert into connectedTenants
      await db().collection('connectedTenants').updateOne(
        { appUserId: stateEntry.appUserId, tenantId: tenant },
        {
          $set: {
            appUserId: stateEntry.appUserId,
            tenantId: tenant,
            displayName: info.displayName,
            defaultDomain: info.defaultDomain,
            consentedAt: new Date(),
            consentState: 'active',
          },
        },
        { upsert: true }
      );

      return res.status(200).send(_consentResultHtml({
        ok: true,
        tenantId: tenant,
        displayName: info.displayName,
        defaultDomain: info.defaultDomain,
      }));
    } catch (e) {
      return res.status(500).send(_consentResultHtml({ ok: false, message: e.message }));
    }
  };
}

function _consentResultHtml({ ok, tenantId, displayName, defaultDomain, message }) {
  const payload = ok
    ? { type: 'c2c-tenant-consent-success', tenantId, displayName, defaultDomain }
    : { type: 'c2c-tenant-consent-error', message: message || 'Consent failed' };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Consent ${ok ? 'Successful' : 'Failed'}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#F6F6F6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:white;padding:32px;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:480px;text-align:center}
  h1{margin:0 0 8px;color:${ok ? '#0129AC' : '#FF1F1F'};font-size:20px}
  p{margin:8px 0;color:#555;font-size:14px}
  .meta{margin-top:14px;padding:10px;background:#F0F4FF;border-radius:8px;font-size:13px;font-family:monospace}
</style></head>
<body><div class="card">
  <h1>${ok ? '✓ Tenant Connected' : '✕ Consent Failed'}</h1>
  ${ok
    ? `<p>${displayName ? displayName + ' has been connected.' : 'The tenant has been connected to CloudFuze Migration.'}</p>
       ${tenantId ? `<div class="meta">Tenant ID: ${tenantId}</div>` : ''}
       <p style="font-size:12px;color:#888;margin-top:14px">You can close this window.</p>`
    : `<p>${(message || '').replace(/</g, '&lt;')}</p>
       <p style="font-size:12px;color:#888;margin-top:14px">You can close this window and try again.</p>`}
</div>
<script>
  try { window.opener && window.opener.postMessage(${JSON.stringify(payload)}, '*'); } catch (e) {}
  // Also notify generic MS sign-in listeners (used by Connect Clouds) so the
  // unified OAuth → admin-consent chain completes cleanly in one popup.
  ${ok ? `try { window.opener && window.opener.postMessage({ type: 'auth-success', alreadyConnected: false }, '*'); } catch (e) {}` : ''}
  setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);
</script>
</body></html>`;
}
