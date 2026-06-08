// src/agent/toolExecutor.js
import { getLogger } from '../utils/logger.js';
import { COMBINATIONS } from './combinations.js';
import { callAI } from './callAI.js';
import { loadHistory } from './conversationHistory.js';

const logger = getLogger('agent:executor');

/**
 * Resolve a natural-language date phrase to ISO YYYY-MM-DD using today's
 * actual server date. Falls through if already ISO.
 *
 * @param {string|null|undefined} raw     value from the LLM (may be ISO, natural, or empty)
 * @param {'from'|'to'} bound             whether this is the start or end of a range
 * @returns {string}                       ISO date or empty string
 */
function resolveDateExpression(raw, bound = 'from') {
  if (raw == null) return '';
  const s = String(raw).trim().toLowerCase();
  if (!s) return ''; // explicit clear

  // Already ISO? (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const now = new Date();
  // Truncate to date (midnight UTC)
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

  // Monday-of-week helper (ISO: Mon=1 .. Sun=7)
  const startOfWeek = (d) => {
    const day = d.getUTCDay() || 7; // Sun=0 → 7
    return addDays(d, -(day - 1));
  };
  const endOfWeek = (d) => addDays(startOfWeek(d), 6);

  if (s === 'today' || s === 'now') return iso(today);
  if (s === 'yesterday') return iso(addDays(today, -1));
  if (s === 'tomorrow') return iso(addDays(today, 1));
  if (s === 'this week' || s === 'current week') {
    return iso(bound === 'from' ? startOfWeek(today) : endOfWeek(today));
  }
  if (s === 'last week' || s === 'previous week') {
    const lastMon = addDays(startOfWeek(today), -7);
    return iso(bound === 'from' ? lastMon : addDays(lastMon, 6));
  }
  if (s === 'this month' || s === 'current month') {
    if (bound === 'from') return iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
    return iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))); // last day this month
  }
  if (s === 'last month' || s === 'previous month') {
    if (bound === 'from') return iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)));
    return iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))); // last day prev month
  }

  // "last N days" / "past N days"
  const lastNDays = s.match(/^(?:last|past)\s+(\d+)\s+days?$/);
  if (lastNDays) {
    const n = parseInt(lastNDays[1], 10);
    return iso(bound === 'from' ? addDays(today, -n) : today);
  }

  // "N days ago"
  const nAgo = s.match(/^(\d+)\s+days?\s+ago$/);
  if (nAgo) {
    return iso(addDays(today, -parseInt(nAgo[1], 10)));
  }

  // Fall back: try Date.parse (catches "March 1 2026" / "2026-03-01T..." / etc.)
  const ts = Date.parse(raw);
  if (!isNaN(ts)) return new Date(ts).toISOString().slice(0, 10);

  // Couldn't resolve — return raw (UI date input will reject if invalid, no harm)
  return raw;
}

function checkStepPrerequisites(targetStep, migDir, migrationState) {
  const {
    uploadData = null,
    mappings_count = 0, selected_users_count = 0,
    c2g_mappings_count = 0, cl2g_mappings_count = 0,
    cl2g_upload_users = 0,
    g2g_source_account_id = '', g2g_upload_users = 0, g2g_mappings_count = 0,
    cl2c_upload_users = 0, cl2c_mappings_count = 0,
    c2c_source_tenant_id = '', c2c_dest_tenant_id = '', c2c_mappings_count = 0,
    googleAuthed = false, msAuthed = false,
  } = migrationState ?? {};

  // Universal: can't skip past Step 0 (Connect Clouds) if required clouds aren't connected.
  if (targetStep >= 1 && !migDir) {
    return 'Pick a migration direction first (Step 1 — Choose Migration Direction).';
  }
  if (targetStep >= 1) {
    const needsGoogle = ['gemini-copilot', 'copilot-gemini', 'claude-gemini', 'gemini-gemini'].includes(migDir);
    const needsMs    = ['gemini-copilot', 'copilot-gemini', 'claude-copilot'].includes(migDir);
    if (needsGoogle && !googleAuthed) return 'Connect Google Workspace first (Step 0 — Connect Clouds).';
    if (needsMs && !msAuthed)         return 'Connect Microsoft 365 first (Step 0 — Connect Clouds).';
  }

  if (migDir === 'gemini-copilot') {
    if (targetStep >= 3 && !uploadData)
      return 'Upload your Google Workspace data first (Step 2 — Import Data).';
    // Allow if either explicit mappings OR users have been selected
    if (targetStep >= 4 && mappings_count === 0 && selected_users_count === 0)
      return 'Map your users first (Step 3 — Map Users). Select at least one user to migrate.';
  }

  if (migDir === 'copilot-gemini') {
    if (targetStep >= 3 && c2g_mappings_count === 0)
      return 'Map your users first (Step 2 — Map Users). At least one mapping is required.';
  }

  if (migDir === 'claude-gemini') {
    if (targetStep >= 3 && cl2g_upload_users === 0)
      return 'Upload your Claude export ZIP first (Step 2 — Upload ZIP).';
    if (targetStep >= 4 && cl2g_mappings_count === 0)
      return 'Map your users first (Step 3 — Map Users). At least one mapping is required.';
  }

  if (migDir === 'gemini-gemini') {
    if (targetStep >= 3 && !g2g_source_account_id)
      return 'Select your source Google account first (Step 2 — Select Accounts).';
    if (targetStep >= 4 && g2g_upload_users === 0)
      return 'Upload your Google Vault data first (Step 3 — Upload Data).';
    if (targetStep >= 5 && g2g_mappings_count === 0)
      return 'Map your users first (Step 4 — Map Users). At least one mapping is required.';
  }

  if (migDir === 'claude-copilot') {
    if (targetStep >= 3 && cl2c_upload_users === 0)
      return 'Upload your Claude export ZIP first (Step 2 — Upload ZIP).';
    if (targetStep >= 4 && cl2c_mappings_count === 0)
      return 'Map your users first (Step 3 — Map Users). At least one mapping is required.';
  }

  if (migDir === 'copilot-copilot') {
    if (targetStep >= 3 && (!c2c_source_tenant_id || !c2c_dest_tenant_id))
      return 'Select source AND destination tenants first (Step 2 — Select Tenants). Connect tenants via admin consent if not yet connected.';
    if (targetStep >= 4 && c2c_mappings_count === 0)
      return 'Map your users first (Step 3 — Map Users). At least one mapping is required.';
  }

  return null; // no blocker
}

export async function executeTool(toolName, args, { streamEvent, session, migrationState, migrationLogs, db, agentDeps }) {
  const migDir = migrationState?.migDir;
  const appUserId = session?.appUser?._id?.toString() || session?.appUserId?.toString() || null;

  switch (toolName) {

    // ── UI event tools ─────────────────────────────────────────────────────
    case 'navigate_to_step': {
      const step = typeof args.step === 'number' ? args.step : parseInt(args.step, 10);
      const blocker = checkStepPrerequisites(step, migDir, migrationState);
      if (blocker) return { navigated: false, blocked: true, reason: blocker };
      streamEvent('navigate', { step });
      return { navigated: true, step };
    }

    case 'select_direction': {
      const dir = args.migDir;
      const { googleAuthed = false, msAuthed = false } = migrationState ?? {};
      // C2C is fully app-only (per-tenant admin consent); CL2C only needs MS; others need Google
      const needsGoogle = dir !== 'claude-copilot' && dir !== 'copilot-copilot';
      const needsMs = dir === 'gemini-copilot' || dir === 'copilot-gemini' || dir === 'claude-copilot';
      const missingGoogle = needsGoogle && !googleAuthed;
      const missingMs = needsMs && !msAuthed;
      const targetStep = (missingGoogle || missingMs) ? 0 : 2;

      // Set direction first so UI shows the right context
      streamEvent('select_direction', { direction: dir, step: targetStep });

      // Map step number → human-readable name for the chosen direction so the agent
      // describes the right step in its reply (avoids "Map Users" hallucination).
      const stepNames = {
        'gemini-copilot':  ['Connect Clouds','Choose Direction','Import Data (Upload ZIP)','Map Users','Options','Migration'],
        'copilot-gemini':  ['Connect Clouds','Choose Direction','Map Users','Options','Migration'],
        'claude-gemini':   ['Connect Clouds','Choose Direction','Upload ZIP','Map Users','Options','Migration'],
        'gemini-gemini':   ['Connect Clouds','Choose Direction','Select Accounts','Upload Data','Map Users','Options','Migration'],
        'claude-copilot':  ['Connect Clouds','Choose Direction','Upload ZIP','Map Users','Options','Migration'],
        'copilot-copilot': ['Connect Tenants','Choose Direction','Select Tenants','Map Users','Options','Migration'],
      };
      const nextStepName = stepNames[dir]?.[targetStep] || 'next step';

      if (missingGoogle || missingMs) {
        const missing = [missingGoogle && 'Google Workspace', missingMs && 'Microsoft 365'].filter(Boolean).join(' and ');
        return { selected: true, direction: dir, authRequired: missing, navigatedToStep: 0, nextStepName: 'Connect Clouds', note: `Direction set to ${dir} but ${missing} must be connected first. User sent back to Connect Clouds step.` };
      }
      return { selected: true, direction: dir, navigatedToStep: targetStep, nextStepName, note: `UI navigated to step ${targetStep} (${nextStepName}). Describe THIS step in your reply, not later steps.` };
    }

    case 'show_reports': {
      streamEvent('refresh_reports', {});
      return { shown: true };
    }

    case 'show_mapping': {
      streamEvent('refresh_mapping', {});
      return { shown: true };
    }

    case 'show_upload_widget': {
      const { widgetType = 'zip', label } = args;
      streamEvent('show_upload_widget', {
        widgetType,
        label: label || (widgetType === 'zip' ? 'Upload your export ZIP file' : 'Import user mappings from CSV'),
        migDir,
      });
      return { shown: true, widgetType };
    }

    case 'show_post_migration_guide': {
      streamEvent('show_widget', { widget: { type: 'post_migration_guide', migDir } });
      return { shown: true };
    }

    case 'show_connect_clouds_widget': {
      // Inline auth buttons in the chat — user clicks and OAuth popup opens
      // without leaving the conversation. The UI's AuthConnectWidget hides
      // whichever cloud is already authed, so we always emit the same widget
      // and let the UI filter.
      const { which = 'both' } = args;
      streamEvent('show_widget', { widget: { type: 'auth_connect', which } });
      return { shown: true, which };
    }

    case 'show_status_card': {
      streamEvent('show_widget', {
        widget: {
          type: 'status_card',
          users: args.users ?? 0,
          files: args.files ?? 0,
          errors: args.errors ?? 0,
          label: args.label ?? 'Migration Results',
        },
      });
      return { shown: true };
    }

    case 'get_mappings': {
      const pairs = Array.isArray(migrationState?.mappingPairs) ? migrationState.mappingPairs : [];
      if (pairs.length === 0) {
        return { mappings: [], total: 0, note: 'No user mappings exist yet. Offer auto-map (auto_map_users), CSV upload, or manual mapping.' };
      }
      const filter = String(args?.userEmail || '').trim().toLowerCase();
      let rows = pairs;
      if (filter) {
        const local = filter.split('@')[0];
        rows = pairs.filter(p => p.source === filter || p.source.startsWith(local + '@') || p.source.split('@')[0] === local);
        if (rows.length === 0) {
          return { mappings: [], total: pairs.length, matched: 0, note: `No mapping found for "${args.userEmail}". ${pairs.length} pairs exist — they can ask to see all.` };
        }
      }
      const selectedCount = pairs.filter(p => p.selected).length;
      return {
        mappings: rows.map(p => ({ source: p.source, destination: p.dest, selected: p.selected })),
        total: pairs.length,
        selected: selectedCount,
        note: `${pairs.length} mapped, ${selectedCount} selected for migration. Only SELECTED pairs migrate.`,
      };
    }

    case 'get_user_conversation_count': {
      const users = Array.isArray(migrationState?.availableUsers) ? migrationState.availableUsers : [];
      const liveDirections = ['copilot-gemini', 'copilot-copilot'];
      const hasCounts = users.some(u => typeof u.conversations === 'number');
      if (!hasCounts) {
        if (liveDirections.includes(migDir)) {
          return { available: false, note: `Conversation counts for ${migDir} are pulled live from the source API during migration — they aren't known until the run starts. Suggest running a dry run to get exact numbers.` };
        }
        return { available: false, note: 'No conversation counts loaded yet. The source data (ZIP/Vault) must be uploaded first.' };
      }
      const filter = String(args?.userEmail || '').trim().toLowerCase();
      if (filter) {
        const local = filter.split('@')[0];
        const hit = users.find(u => u.email === filter || u.email.startsWith(local + '@') || u.email.split('@')[0] === local);
        if (!hit) return { available: false, note: `No loaded user matches "${args.userEmail}".` };
        return { user: hit.email, conversations: hit.conversations ?? 0, name: hit.name || undefined };
      }
      const withCounts = users.filter(u => typeof u.conversations === 'number');
      const total = withCounts.reduce((s, u) => s + (u.conversations || 0), 0);
      return { totalConversations: total, userCount: withCounts.length, note: `${total} conversations across ${withCounts.length} loaded users.` };
    }

    case 'set_migration_config': {
      // Resolve natural-language dates server-side. LLMs unreliably anchor to
      // "today" — relying on prompt instructions alone gives stale 2023 dates.
      // We accept ISO ("2026-05-27"), natural ("today", "yesterday",
      // "this week", "last week", "last 7 days", "last month", "this month"),
      // or empty string (clears the field).
      const resolved = { ...args };
      if (resolved.fromDate !== undefined) resolved.fromDate = resolveDateExpression(resolved.fromDate, 'from');
      if (resolved.toDate   !== undefined) resolved.toDate   = resolveDateExpression(resolved.toDate, 'to');
      session.agentConfig = { ...(session.agentConfig ?? {}), ...resolved };
      streamEvent('set_config', { config: resolved });
      return { set: true, config: resolved };
    }

    case 'select_g2g_accounts': {
      if (migDir !== 'gemini-gemini') {
        return { error: 'select_g2g_accounts only applies to Gemini→Gemini. Current direction: ' + (migDir || 'none') };
      }
      const { sourceAccountId, destAccountId } = args || {};
      if (!sourceAccountId || !destAccountId) {
        return { error: 'Both sourceAccountId and destAccountId are required' };
      }
      if (sourceAccountId === destAccountId) {
        return { error: 'Source and destination must be different Google accounts' };
      }
      streamEvent('set_g2g_accounts', { sourceAccountId, destAccountId, step: 3 });
      return { set: true, sourceAccountId, destAccountId, note: 'G2G accounts selected. UI advanced to Step 3 — Upload Data.' };
    }

    case 'select_c2c_tenants': {
      if (migDir !== 'copilot-copilot') {
        return { error: 'select_c2c_tenants only applies to Copilot→Copilot (cross-tenant). Current direction: ' + (migDir || 'none') };
      }
      let { sourceTenantId, destTenantId } = args || {};
      if (!sourceTenantId || !destTenantId) {
        return { error: 'Both sourceTenantId and destTenantId are required' };
      }

      // Self-correct when the LLM passes an email instead of the tenantId GUID.
      // The agent saw email→tenantId pairs in msAccountsList but sometimes still
      // sends back the email. Look up the actual GUID before persisting.
      const isGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
      const msAccountsList = migrationState?.msAccountsList || [];
      const resolveTenantId = (raw) => {
        if (isGuid(raw)) return raw;
        // Match by email (case-insensitive) or by display name
        const hit = msAccountsList.find(a =>
          (a.email && a.email.toLowerCase() === String(raw).toLowerCase()) ||
          (a.displayName && a.displayName.toLowerCase() === String(raw).toLowerCase())
        );
        return hit?.tenantId || raw;
      };
      sourceTenantId = resolveTenantId(sourceTenantId);
      destTenantId = resolveTenantId(destTenantId);

      // Final check — both must now be GUIDs
      if (!isGuid(sourceTenantId) || !isGuid(destTenantId)) {
        const known = msAccountsList.map(a => `${a.email} → ${a.tenantId}`).join(', ');
        return { error: `Could not resolve tenant IDs. Pass the literal tenantId GUID from msAccountsList, not the email. Known tenants: ${known || '(none)'}` };
      }
      if (sourceTenantId === destTenantId) {
        return { error: 'Source and destination tenants must be different' };
      }
      streamEvent('set_c2c_tenants', { sourceTenantId, destTenantId, step: 3 });
      return { set: true, sourceTenantId, destTenantId, note: 'C2C tenants selected. UI advanced to Step 3 — Map Users.' };
    }

    case 'trigger_vault_export': {
      if (migDir !== 'gemini-copilot' && migDir !== 'gemini-gemini') {
        return { error: 'trigger_vault_export only applies to G2C (Vault→Copilot) or G2G (Google→Google). Current direction: ' + (migDir || 'none') };
      }
      const scope = args?.scope === 'selected' ? 'selected' : 'all';
      const emails = Array.isArray(args?.emails) ? args.emails : [];
      if (scope === 'selected' && emails.length === 0) {
        return { error: 'emails array required when scope is "selected"' };
      }
      // Navigate to the right step + emit the trigger event
      const targetStep = migDir === 'gemini-gemini' ? 3 : 2;
      streamEvent('trigger_vault_export', { scope, emails, migDir, step: targetStep });
      return {
        triggered: true,
        scope, emailCount: emails.length || 'all',
        note: 'Vault export started. The UI is now running the export — this typically takes 1–10 minutes. The user list will load automatically when done.',
      };
    }

    case 'initiate_tenant_consent': {
      if (migDir !== 'copilot-copilot') {
        return { error: 'initiate_tenant_consent only applies to Copilot→Copilot. Current direction: ' + (migDir || 'none') };
      }
      const role = args?.role === 'destination' ? 'destination' : 'source';
      streamEvent('initiate_tenant_consent', { role });
      return { triggered: true, role, note: `Tenant consent popup opened for ${role} tenant. After admin approves, call select_c2c_tenants.` };
    }

    // ── Execution tools ────────────────────────────────────────────────────
    case 'get_auth_status': {
      try {
        const sessions = await db.collection('authSessions')
          .find({ appUserId })
          .toArray();
        const googleSession = sessions.find(s => s.provider === 'google');
        const msSession = sessions.find(s => s.provider === 'microsoft' || s.provider === 'azure');
        return {
          google: googleSession ? { connected: true, email: googleSession.email } : { connected: false },
          microsoft: msSession ? { connected: true, email: msSession.email } : { connected: false },
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_migration_status': {
      const dir = migrationState.migDir;
      const isRunning = migrationState.live || migrationState.c2g_live || migrationState.cl2g_live
        || migrationState.g2g_live || migrationState.cl2c_live;
      const isDone = migrationState.migDone || migrationState.c2g_done || migrationState.cl2g_done
        || migrationState.g2g_done || migrationState.cl2c_done;
      // Pick direction-specific stats
      const activeStats = dir === 'copilot-gemini' ? migrationState.c2g_stats
        : dir === 'claude-gemini' ? migrationState.cl2g_stats
        : dir === 'gemini-gemini' ? migrationState.g2g_stats
        : dir === 'claude-copilot' ? migrationState.cl2c_stats
        : migrationState.stats;
      const currentBatchId = migrationState.currentBatchId;
      const logTail = migrationLogs?.slice(-20) ?? [];
      let dbStatus = null;
      if (currentBatchId) {
        try {
          dbStatus = await db.collection('migrationWorkspaces').findOne({ _id: currentBatchId, appUserId });
        } catch (e) { logger.warn(`get_migration_status DB query failed: ${e.message}`); }
      }
      return {
        step: migrationState.step, direction: dir ?? 'none', running: isRunning, done: isDone,
        users: activeStats?.users ?? dbStatus?.progressUsers ?? 0,
        pages: activeStats?.pages ?? activeStats?.files ?? dbStatus?.progressPages ?? 0,
        errors: activeStats?.errors ?? dbStatus?.progressErrors ?? 0,
        recentLogs: logTail,
      };
    }

    case 'pre_flight_check': {
      const combo = COMBINATIONS[migDir];
      const blockers = [];
      const warnings = [];
      if (!migDir) {
        blockers.push('No migration direction selected');
      } else {
        blockers.push(...combo.authCheck(migrationState));
        const effectiveMappings = combo.mappingsCount(migrationState);
        if (combo.hasUpload && migDir === 'gemini-copilot' && !migrationState.uploadData) {
          blockers.push('No data uploaded or imported yet');
        }
        if (migDir === 'claude-gemini' && (migrationState.cl2g_upload_users ?? 0) === 0) {
          blockers.push('No ZIP uploaded yet');
        }
        if (migDir === 'gemini-gemini' && (migrationState.g2g_upload_users ?? 0) === 0) {
          blockers.push('No Google Vault data uploaded yet (Step 3 — Upload Data).');
        }
        if (migDir === 'claude-copilot' && (migrationState.cl2c_upload_users ?? 0) === 0) {
          blockers.push('No Claude export ZIP uploaded yet (Step 2 — Upload ZIP).');
        }
        if (effectiveMappings === 0) blockers.push('No users mapped');
        if (combo.isLive(migrationState)) blockers.push('Migration already running');
        const selectedCount = migrationState.selected_users_count;
        if (migDir === 'gemini-copilot' && selectedCount != null && selectedCount < effectiveMappings) {
          warnings.push(`${effectiveMappings - selectedCount} users have no destination — they will be skipped`);
        }
      }
      return { blockers, warnings, ready: blockers.length === 0 };
    }

    case 'auto_map_users': {
      if (!migDir) return { error: 'No direction selected' };
      // The UI owns the source-of-truth user lists (Google API, MS Graph, ZIP parse).
      // Trigger the UI's auto-map button via event; UI reports back via state on next turn.
      streamEvent('trigger_auto_map', { migDir });
      return { triggered: true, note: 'Auto-map running in UI. Result will appear in mappings_count on next turn.' };
    }

    case 'select_mapping_users': {
      if (!migDir) return { error: 'No direction selected — select_direction first.' };
      const action = args?.action;
      const emails = Array.isArray(args?.emails) ? args.emails.map(e => String(e).toLowerCase()) : [];
      if (!['all', 'none', 'only_mapped', 'add', 'remove'].includes(action)) {
        return { error: 'action must be one of: all, none, only_mapped, add, remove' };
      }
      if ((action === 'add' || action === 'remove') && emails.length === 0) {
        return { error: 'emails array required for add/remove action' };
      }
      streamEvent('set_mapping_selection', { migDir, action, emails });
      return { triggered: true, action, emailCount: emails.length, note: 'Selection updated in UI. New count appears in selected_users_count / *_mappings_count on next turn.' };
    }

    case 'set_user_mapping': {
      if (!migDir) return { error: 'No direction selected — select_direction first.' };
      const sourceEmail = String(args?.sourceEmail || '').trim();
      const destEmail   = String(args?.destEmail || '').trim();
      if (!sourceEmail) return { error: 'sourceEmail is required' };
      streamEvent('set_user_mapping', { migDir, sourceEmail, destEmail });
      return { set: true, sourceEmail, destEmail, note: destEmail ? `${sourceEmail} → ${destEmail} applied in UI.` : `Cleared mapping for ${sourceEmail}.` };
    }

    case 'clear_uploaded_csv': {
      if (!migDir) return { error: 'No direction selected — select_direction first.' };
      // Also delete the DB record server-side so it doesn't restore on next mount.
      try {
        await db.collection('userMappings').deleteOne({ appUserId, migDir });
      } catch (e) { logger.warn(`clear_uploaded_csv DB delete failed: ${e.message}`); }
      streamEvent('clear_uploaded_csv', { migDir });
      return { cleared: true, migDir, note: 'CSV mapping removed. Mappings reverted to auto-match defaults and no users are selected. User can upload a new CSV anytime.' };
    }

    case 'get_user_migration_status': {
      const userEmail = String(args?.userEmail || '').trim().toLowerCase();
      if (!userEmail) return { error: 'userEmail is required' };
      const batchId = args?.batchId;
      try {
        const query = { appUserId };
        if (batchId) query._id = batchId;
        // Find batches whose report contains this user, newest first.
        const batches = await db.collection('migrationWorkspaces')
          .find(query, { projection: { report: 1, migDir: 1, status: 1, startTime: 1, endTime: 1, totalUsers: 1 } })
          .sort({ startTime: -1 })
          .limit(20)
          .toArray();

        for (const b of batches) {
          const userRow = (b.report?.users || []).find(u =>
            (u.email || '').toLowerCase() === userEmail ||
            (u.destEmail || '').toLowerCase() === userEmail
          );
          if (userRow) {
            return {
              found: true,
              batchId: b._id,
              migDir: b.migDir,
              batchStatus: b.status,
              startTime: b.startTime,
              endTime: b.endTime,
              user: {
                email: userRow.email,
                destEmail: userRow.destEmail,
                displayName: userRow.displayName,
                status: userRow.status, // success | partial | failed
                conversations_processed: userRow.conversations_processed || 0,
                pages_created: userRow.pages_created || 0,
                error_count: userRow.error_count || 0,
                errors: (userRow.errors || []).map(e => e.error_message || e).slice(0, 5),
                fileCount: (userRow.files || []).length,
              },
            };
          }
        }
        return { found: false, userEmail, note: `No migration record found for ${userEmail} in the last 20 batches for this account.` };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_migration_report': {
      // Whole-batch results so the agent can summarise a run: who succeeded /
      // failed, file counts, and the failures with reasons. Works for all
      // directions (report.users[] / users[] are consistent in migrationWorkspaces).
      try {
        const batchId = args?.batchId || session.currentBatchId;
        const query = { appUserId };
        if (batchId) query._id = batchId;
        if (migDir && !batchId) query.migDir = migDir; // latest run for this direction
        const batch = await db.collection('migrationWorkspaces')
          .find(query)
          .sort({ startTime: -1 })
          .limit(1)
          .toArray()
          .then(a => a[0]);
        if (!batch) return { found: false, note: 'No migration run found yet for this account/direction. Run a dry run or migration first.' };

        const users = batch.report?.users || batch.users || [];
        const norm = users.map(u => ({
          email: u.email || u.sourceEmail || '',
          destEmail: u.destEmail || '',
          status: u.status || 'unknown', // success | partial | failed
          conversations: u.conversations_processed ?? u.conversationCount ?? 0,
          files: u.pages_created ?? (u.files || []).length ?? 0,
          errorCount: u.error_count ?? (u.errors || []).length ?? 0,
          errors: (u.errors || []).map(e => e.error_message || e).slice(0, 3),
        }));
        const tally = (s) => norm.filter(u => u.status === s).length;
        const failed = norm.filter(u => u.status === 'failed' || u.errorCount > 0);
        return {
          found: true,
          batchId: batch._id,
          migDir: batch.migDir,
          batchStatus: batch.status,
          dryRun: batch.dryRun ?? batch.report?.config?.dryRun ?? null,
          startTime: batch.startTime,
          endTime: batch.endTime,
          summary: {
            totalUsers: norm.length,
            succeeded: tally('success'),
            partial: tally('partial'),
            failed: tally('failed'),
            totalFiles: norm.reduce((s, u) => s + (u.files || 0), 0),
            totalConversations: norm.reduce((s, u) => s + (u.conversations || 0), 0),
            totalErrors: norm.reduce((s, u) => s + (u.errorCount || 0), 0),
          },
          // Cap rows to keep the response bounded; failures listed first.
          users: [...failed, ...norm.filter(u => !failed.includes(u))].slice(0, 40),
          note: failed.length > 0
            ? `${failed.length} user(s) had errors — list them with reasons and offer Retry failed.`
            : 'All users completed without errors.',
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'explain_log': {
      const line = args.log_line ?? '';
      const isErr = /error|fail|exception/i.test(line);
      const isWarn = /warn|skip|flag/i.test(line);
      const isSuc = /success|created|complet/i.test(line);
      if (isErr) return { explanation: 'This is an error — the migration engine hit a problem. Check user permissions and retry failed items after migration completes.' };
      if (isWarn) return { explanation: 'This is a warning — something was skipped but migration continued. Review skipped items in the report.' };
      if (isSuc) return { explanation: 'This is a success message — the item migrated correctly.' };
      return { explanation: 'This is an informational message showing normal migration progress.' };
    }

    case 'explain_error': {
      const recentErrors = migrationLogs?.filter(l => /error|fail/i.test(l)).slice(-10) ?? [];
      if (recentErrors.length === 0) return { explanation: 'No errors found in recent logs.' };
      try {
        const msg = await callAI([
          { role: 'system', content: 'You are a migration error analyst. Explain the errors in 2-3 plain English sentences with actionable fixes. Be concise.' },
          { role: 'user', content: `Migration errors:\n${recentErrors.join('\n')}` },
        ], null);
        return { explanation: msg.content ?? 'Could not analyze errors.' };
      } catch (e) {
        return { explanation: `Errors found: ${recentErrors.join('; ')}` };
      }
    }

    case 'get_conversation_history': {
      try {
        const history = await loadHistory(db, appUserId);
        return { messages: history, count: history.length };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'set_schedule': {
      try {
        const runAt = new Date(args.runAt);
        if (isNaN(runAt.getTime())) return { error: 'Invalid date format. Use ISO string like 2026-05-03T02:00:00Z' };
        const job = {
          appUserId,
          migDir,
          dryRun: args.dryRun ?? true,
          runAt,
          status: 'scheduled',
          createdAt: new Date(),
        };
        const result = await db.collection('scheduledJobs').insertOne(job);
        return { scheduled: true, jobId: result.insertedId.toString(), runAt: runAt.toISOString() };
      } catch (e) {
        return { error: e.message };
      }
    }

    // ── Destructive tools — executed after agentLoop confirmation ──────────
    case 'start_migration': {
      if (!migDir) return { error: 'No migration direction selected. Pick a direction first.' };
      if (typeof args.dryRun !== 'boolean') {
        return { error: 'dryRun must be specified explicitly (true for preview, false for live)' };
      }
      const dryRun = args.dryRun;
      const batchId = `batch_${Date.now()}`;
      session.currentBatchId = batchId;
      // Optional server-side starter (legacy hook) — call if present, ignore if not.
      const { startMigration } = agentDeps ?? session._agentDeps ?? {};
      if (typeof startMigration === 'function') {
        startMigration({ dryRun, batchId, migDir, appUserId }).catch(e => {
          logger.error(`Background migration failed: ${e.message}`);
        });
      }
      // The UI is the actual migration runner — it listens for this event and
      // kicks off the appropriate /api/<combo>/migrate POST. Always emit.
      streamEvent('migration_started', { batchId, migDir, dryRun });
      return { started: true, batchId, dryRun, migDir };
    }

    case 'retry_failed': {
      const batchId = session.currentBatchId;
      if (!batchId) return { error: 'No migration batch found to retry — start a migration first.' };
      const { retryMigration } = agentDeps ?? session._agentDeps ?? {};
      if (typeof retryMigration === 'function') {
        retryMigration({ batchId, appUserId }).catch(e => {
          logger.error(`Background retry failed: ${e.message}`);
        });
      }
      streamEvent('refresh_status', { batchId });
      return { retrying: true, batchId };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
