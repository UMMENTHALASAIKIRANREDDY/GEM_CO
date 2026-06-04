// src/agent/agentLoop.js
import { callAI } from './callAI.js';
import { AGENT_TOOLS, DESTRUCTIVE_TOOLS, CONFIRMATION_MESSAGES } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { loadHistory, saveHistory } from './conversationHistory.js';
import { executeTool } from './toolExecutor.js';
import { getLogger } from '../utils/logger.js';
import { auditLog } from './auditLogger.js';

const logger = getLogger('agent:loop');
const MAX_ITERATIONS = 8;

/**
 * Generate 3 contextual quick-reply chips using a fast LLM call.
 * Chips are based on the agent's last reply + current migration state.
 * Falls back to defaultChips on any error so the main flow is never blocked.
 */
async function generateChips(agentReply, migrationState) {
  const s = migrationState ?? {};
  const stateCtx = [
    `step=${s.step ?? 0}`,
    `dir=${s.migDir || 'none'}`,
    `google=${s.googleAuthed ? 'connected' : 'not connected'}`,
    `ms=${s.msAuthed ? 'connected' : 'not connected'}`,
    s.migDir === 'claude-gemini' ? `zip_users=${s.cl2g_upload_users ?? 0}` : null,
    s.migDir === 'copilot-gemini' ? `mapped=${s.c2g_mappings_count ?? 0}` : null,
    s.migDir === 'claude-gemini' ? `mapped=${s.cl2g_mappings_count ?? 0}` : null,
    s.migDir === 'gemini-gemini' ? `mapped=${s.g2g_mappings_count ?? 0}` : null,
    s.migDir === 'claude-copilot' ? `mapped=${s.cl2c_mappings_count ?? 0}` : null,
    s.migDir === 'copilot-copilot' ? `mapped=${s.c2c_mappings_count ?? 0}` : null,
    (s.migDone || s.c2g_done || s.cl2g_done || s.g2g_done || s.cl2c_done || s.c2c_done) ? 'migration=done' : null,
    (s.live || s.c2g_live || s.cl2g_live || s.g2g_live || s.cl2c_live || s.c2c_live) ? 'migration=running' : null,
  ].filter(Boolean).join(', ');

  const snippet = (agentReply || '').slice(-300);

  try {
    const res = await callAI([
      {
        role: 'system',
        content: `You generate exactly 3 short quick-reply chips for a migration assistant chat UI.
Rules:
- Each chip max 6 words, starts with a verb or noun (action-oriented)
- Chips must directly follow up on what the assistant just said OR unblock the current step
- Never repeat the agent's exact words
- No generic chips like "What do I do next?" or "Tell me more"
- Chips must be specific to the current migration state
- Return ONLY a JSON array of 3 strings, nothing else. Example: ["Auto-map all users", "Upload Claude ZIP", "Start dry run"]`,
      },
      {
        role: 'user',
        content: `State: ${stateCtx}\nAssistant just said: "${snippet}"\n\nReturn 3 chips as JSON array:`,
      },
    ], null, { model: 'gpt-4.1-mini', maxTokens: 80 });

    const raw = (res.content || '').trim();
    // Extract JSON array from response (LLM sometimes wraps in markdown)
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const chips = JSON.parse(match[0]);
      if (Array.isArray(chips) && chips.length > 0) {
        return chips.slice(0, 4).map(c => String(c).trim()).filter(Boolean);
      }
    }
  } catch (e) {
    logger.warn(`[agentLoop] generateChips failed: ${e.message}`);
  }
  return null; // caller falls back to defaultChips
}

function defaultChips(migrationState) {
  // Alias so the various `state.foo ?? 0` reads below work without per-line refactor.
  const state = migrationState ?? {};
  const { step = 0, migDir, googleAuthed = false, msAuthed = false,
    mappings_count = 0, selected_users_count = 0,
    c2g_mappings_count = 0, cl2g_mappings_count = 0,
    cl2g_upload_users = 0, uploadData = null,
    migDone = false, c2g_done = false, cl2g_done = false,
    lastRunWasDry = false, c2gLastDry = false, cl2gLastDry = false,
    stats = {}, c2g_stats = {}, cl2g_stats = {} } = migrationState ?? {};

  const dryRunDone = migDir === 'copilot-gemini' ? (c2g_done && c2gLastDry)
    : migDir === 'claude-gemini' ? (cl2g_done && cl2gLastDry)
    : (migDone && lastRunWasDry);
  const activeErrors = (migDir === 'copilot-gemini' ? c2g_stats : migDir === 'claude-gemini' ? cl2g_stats : stats).errors ?? 0;

  // No direction yet — guide toward picking one
  if (!migDir) {
    if (!googleAuthed && !msAuthed) return [
      'Migrate Google Workspace → Microsoft 365',
      'Migrate Claude AI → Google Workspace',
      'Help me choose the right migration',
    ];
    if (googleAuthed && !msAuthed) return [
      'Migrate Claude AI → Google Workspace',
      'Migrate Google → Google (Vault export)',
      'Connect Microsoft 365 to unlock more migrations',
    ];
    if (!googleAuthed && msAuthed) return [
      'Migrate Claude AI → Microsoft Copilot',
      'Migrate Copilot → Copilot (cross-tenant)',
      'Connect Google Workspace to unlock more migrations',
    ];
    if (googleAuthed && msAuthed) return [
      'Migrate Google Workspace → Microsoft 365',
      'Migrate Microsoft 365 → Google Workspace',
      'Migrate Claude AI → Google Workspace',
    ];
    return ['Help me pick the right migration path'];
  }

  // Auth missing — guide to connect what's needed (C2C uses tenant consent, not OAuth)
  const needsGoogle = ['gemini-copilot', 'copilot-gemini', 'claude-gemini', 'gemini-gemini'].includes(migDir);
  const needsMs = ['gemini-copilot', 'copilot-gemini', 'claude-copilot'].includes(migDir);
  const missingGoogle = needsGoogle && !googleAuthed;
  const missingMs = needsMs && !msAuthed;
  if (missingGoogle && missingMs) return [
    'Connect Google Workspace first',
    'Connect Microsoft 365 first',
    'Tell me what each connection does',
  ];
  if (missingGoogle) return [
    'Connect Google Workspace to continue',
    'Explain why Google Workspace is needed',
  ];
  if (missingMs) return [
    'Connect Microsoft 365 to continue',
    'Explain why Microsoft 365 is needed',
  ];

  // G2G needs TWO Google accounts (source + destination). If only one is
  // connected, the next action is "+ Add Another Google account" — NOT
  // "connect Microsoft" or any other cloud.
  if (migDir === 'gemini-gemini' && !state.multiGoogle) return [
    'Connect another Google Workspace account',
    'Why does Google → Google need two accounts?',
  ];
  // C2C needs TWO consented Microsoft tenants. If only one is connected/consented,
  // the next action is "+ Add Another Microsoft tenant" — NOT "connect Google".
  if (migDir === 'copilot-copilot' && !state.multiMs) return [
    'Connect another Microsoft 365 tenant',
    'Why does Copilot → Copilot need two tenants?',
  ];

  // Build the "switch direction" alternatives for the current cloud setup.
  // MUST match the UI direction-picker filter rules so chip suggestions never
  // include directions that the UI's Choose Direction step hides:
  //   - both clouds connected: ONLY Gemini↔Copilot
  //   - Google only:            ONLY Claude→Gemini
  //   - Microsoft only:         ONLY Claude→Copilot
  //   - multi-Google accounts:  also G2G
  //   - multi-Microsoft accounts: also C2C
  // (Multi-account state isn't exposed in agent state today, so for now we
  // only offer G2G/C2C if the user explicitly switched to those previously.)
  function altDirectionChips(currentDir) {
    const multiGoogle = !!state.multiGoogle;
    const multiMs     = !!state.multiMs;
    const alts = [];
    if (googleAuthed && msAuthed) {
      // Both clouds connected → only the cross-cloud directions
      if (currentDir !== 'gemini-copilot') alts.push('Switch to Gemini → Copilot');
      if (currentDir !== 'copilot-gemini') alts.push('Switch to Copilot → Gemini');
    } else if (googleAuthed && !msAuthed) {
      // Google only — single account: Claude→Gemini. Multi-account: G2G instead.
      if (!multiGoogle && currentDir !== 'claude-gemini') alts.push('Switch to Claude → Gemini');
      if (multiGoogle  && currentDir !== 'gemini-gemini') alts.push('Switch to Gemini → Gemini');
    } else if (!googleAuthed && msAuthed) {
      if (!multiMs && currentDir !== 'claude-copilot')  alts.push('Switch to Claude → Copilot');
      if (multiMs  && currentDir !== 'copilot-copilot') alts.push('Switch to Copilot → Copilot (cross-tenant)');
    }
    return alts.slice(0, 2);
  }

  // ─── Shared chip helpers ────────────────────────────────────────────────
  // Group chips by SOURCE-TYPE (not combo) so flows are identical wherever the
  // source repeats: Google = G2C + G2G, Copilot = C2G + C2C, Claude = CL2G + CL2C.

  /** Google source — Vault export or ZIP upload. Used by G2C and G2G. */
  const googleSourceChips = (hasUpload, totalUsers) =>
    hasUpload
      ? [`${totalUsers||'?'} users imported — continue to Map Users`, 'Upload a different Vault ZIP', 'Show me what was imported']
      : ['I have a Vault ZIP — open the upload area', 'Export Vault for ALL users in my Workspace', 'Export Vault for specific users I pick', 'How do I export from Google Vault step by step?'];

  /** Claude source — ZIP upload only. Used by CL2G and CL2C. */
  const claudeSourceChips = (hasUpload, totalUsers) =>
    hasUpload
      ? [`${totalUsers||'?'} users loaded — continue to Map Users`, 'Upload a different Claude ZIP', 'Show me the conversation counts']
      : ['I have a Claude export ZIP — open the upload widget', 'How do I export from Claude.ai step by step?'];

  /** Copilot source — pulls from Graph API live. Used by C2G and C2C. */
  const copilotSourceChips = () =>
    ['Continue to Map Users', 'What gets pulled from Copilot?'];

  /** G2G extra step — Select source + destination Google accounts. */
  const g2gAccountChips = (sourceId, destId) => {
    if (sourceId && destId) return ['Continue to Upload Data', 'Change source account', 'Change destination account'];
    if (sourceId && !destId) return ['Set destination account', 'Show available Google accounts'];
    if (!sourceId && destId) return ['Set source account', 'Show available Google accounts'];
    return ['Show me my connected Google accounts', 'Help me pick source and destination'];
  };

  /** C2C extra step — Pick consented source + destination tenants.
   *  IMPORTANT distinction:
   *    - msAccountsList = tenants the admin has CONSENTED to (via /api/c2c admin-consent)
   *    - sourceId / destId  = which two of those tenants the user has PICKED for this migration
   *  Showing "Grant consent" when 2+ tenants are already consented just confuses the user.
   */
  const c2cTenantChips = (sourceId, destId) => {
    const tenants = Array.isArray(state.msAccountsList) ? state.msAccountsList : [];
    const consentedCount = tenants.length;

    // Both picked → ready to move on
    if (sourceId && destId) return ['Continue to Map Users', 'Change source tenant', 'Change destination tenant'];

    // Not enough tenants consented yet — point user back to Step 0 to add more.
    if (consentedCount < 2) return ['Connect another Microsoft 365 tenant', 'Show me consented tenants'];

    // 2+ consented but selection incomplete. Offer source/dest picks from real
    // consented emails so the user can click directly. Falls back to a generic
    // prompt if we don't have enough emails to construct labels.
    const labelOf = (idx) => tenants[idx]?.email || tenants[idx]?.displayName || `Tenant ${idx + 1}`;
    if (consentedCount >= 2) {
      // If exactly one side is picked, ask the user to pick the other.
      if (sourceId && !destId) return [`Use ${labelOf(0)} as destination`, `Use ${labelOf(1)} as destination`, 'Show me consented tenants'];
      if (!sourceId && destId) return [`Use ${labelOf(0)} as source`, `Use ${labelOf(1)} as source`, 'Show me consented tenants'];
      // Neither side picked — offer the two natural orderings of the first two tenants.
      return [
        `${labelOf(0)} as source, ${labelOf(1)} as destination`,
        `${labelOf(1)} as source, ${labelOf(0)} as destination`,
        'Show me consented tenants',
      ];
    }
    return ['Show me consented tenants', 'Help me pick source and destination'];
  };

  /**
   * Map Users step — TWO phases:
   *   A. No mappings yet  → Auto-map / CSV / Manual
   *   B. Mappings done, no selection → Select-all / Pick-specific / Adjust
   *   C. Ready (mappings + selection) → Continue to Options
   */
  const mapStepChips = (mappedCount, selectedCount = 0) => {
    if (mappedCount === 0) {
      return ['Auto-map all users by email', 'I have a mapping CSV — open the upload widget', 'I\'ll map users manually in the table'];
    }
    if (selectedCount === 0) {
      return [
        `${mappedCount} users mapped — now select which to migrate`,
        `Select ALL ${mappedCount} mapped users`,
        `Let me pick specific users to migrate`,
        'I have a mapping CSV — open the upload widget',
        'Clear mappings and start over',
      ];
    }
    return [
      `${selectedCount} of ${mappedCount} selected — continue to Options`,
      `Select all ${mappedCount} mapped users`,
      'Deselect everyone and pick again',
      'I have a mapping CSV — open the upload widget',
    ];
  };

  const optionsStepChips = () => dryRunDone
    ? ['Run the live migration now', 'What happened in the dry run?', 'Change the folder name', 'Set a date range']
    : ['Run a dry run first — safe preview', 'Change the folder name', 'Set a date range (e.g. last 7 days)', 'I understand the risk — go live now'];

  const postMigrationChips = (isDryDone, errs) => {
    if (isDryDone) {
      return errs > 0
        ? ['Retry failed users, then go live', 'Skip errors and run live migration', 'Download dry run report']
        : ['Everything looks good — start live migration', 'Download dry run report', 'Migrate another set of users'];
    }
    return errs > 0
      ? ['Retry the failed items now', 'Download report with error details', 'Migrate another set of users']
      : ['Download the migration report', 'Migrate another set of users', 'Change migration direction'];
  };

  // Pull commonly-needed counts up-front. Each combo uses its own state key.
  const c2g_selected_users_count = state.c2g_selected_users_count ?? 0;
  const cl2g_selected_users_count = state.cl2g_selected_users_count ?? 0;
  const cl2c_upload_users = state.cl2c_upload_users ?? 0;
  const cl2c_mappings_count = state.cl2c_mappings_count ?? 0;
  const cl2c_selected_users_count = state.cl2c_selected_users_count ?? 0;
  const cl2c_done = state.cl2c_done;
  const g2g_source_account_id = state.g2g_source_account_id || '';
  const g2g_dest_account_id   = state.g2g_dest_account_id || '';
  const g2g_upload_users = state.g2g_upload_users ?? 0;
  const g2g_mappings_count = state.g2g_mappings_count ?? 0;
  const g2g_selected_users_count = state.g2g_selected_users_count ?? 0;
  const g2g_done = state.g2g_done;
  const c2c_source_tenant_id = state.c2c_source_tenant_id || '';
  const c2c_dest_tenant_id   = state.c2c_dest_tenant_id || '';
  const c2c_mappings_count = state.c2c_mappings_count ?? 0;
  const c2c_selected_users_count = state.c2c_selected_users_count ?? 0;
  const c2c_done = state.c2c_done;

  // ─── G2C (Google → Copilot) — Google source ─────────────────────────────
  if (migDir === 'gemini-copilot') {
    if (step <= 1) return ['Continue to Import Data (Gemini → Copilot)', ...altDirectionChips('gemini-copilot')];
    if (step === 2) return googleSourceChips(!!uploadData, uploadData?.total_users);
    if (step === 3) return mapStepChips(mappings_count, selected_users_count);
    if (step === 4) return optionsStepChips();
    if (migDone) return postMigrationChips(dryRunDone, activeErrors);
  }

  // ─── C2G (Copilot → Gemini) — Copilot source (no upload step) ──────────
  if (migDir === 'copilot-gemini') {
    if (step <= 1) return ['Continue to Map Users (Copilot → Gemini)', ...altDirectionChips('copilot-gemini')];
    if (step === 2) return mapStepChips(c2g_mappings_count, c2g_selected_users_count);
    if (step === 3) return optionsStepChips();
    if (c2g_done) return postMigrationChips(dryRunDone, activeErrors);
  }

  // ─── CL2G (Claude → Gemini) — Claude source ─────────────────────────────
  if (migDir === 'claude-gemini') {
    if (step <= 1) return ['Continue to Upload ZIP (Claude → Gemini)', ...altDirectionChips('claude-gemini')];
    if (step === 2) return claudeSourceChips(cl2g_upload_users > 0, cl2g_upload_users);
    if (step === 3) return mapStepChips(cl2g_mappings_count, cl2g_selected_users_count);
    if (step === 4) return optionsStepChips();
    if (cl2g_done) return postMigrationChips(dryRunDone, activeErrors);
  }

  // ─── CL2C (Claude → Copilot) — Claude source ────────────────────────────
  if (migDir === 'claude-copilot') {
    if (step <= 1) return ['Continue to Upload ZIP (Claude → Copilot)', ...altDirectionChips('claude-copilot')];
    if (step === 2) return claudeSourceChips(cl2c_upload_users > 0, cl2c_upload_users);
    if (step === 3) return mapStepChips(cl2c_mappings_count, cl2c_selected_users_count);
    if (step === 4) return optionsStepChips();
    if (cl2c_done) return postMigrationChips(dryRunDone, activeErrors);
  }

  // ─── G2G (Google → Google) — Google source + extra Select-Accounts step ─
  if (migDir === 'gemini-gemini') {
    if (step <= 1) return ['Continue to Select Accounts (Google → Google)', ...altDirectionChips('gemini-gemini')];
    if (step === 2) return g2gAccountChips(g2g_source_account_id, g2g_dest_account_id);
    if (step === 3) return googleSourceChips(g2g_upload_users > 0, g2g_upload_users);
    if (step === 4) return mapStepChips(g2g_mappings_count, g2g_selected_users_count);
    if (step === 5) return optionsStepChips();
    if (g2g_done) return postMigrationChips(dryRunDone, activeErrors);
  }

  // ─── C2C (Copilot → Copilot) — Copilot source + extra Select-Tenants step
  if (migDir === 'copilot-copilot') {
    if (step <= 1) return ['Continue to Select Tenants (Copilot → Copilot cross-tenant)', ...altDirectionChips('copilot-copilot')];
    if (step === 2) return c2cTenantChips(c2c_source_tenant_id, c2c_dest_tenant_id);
    if (step === 3) return mapStepChips(c2c_mappings_count, c2c_selected_users_count);
    if (step === 4) return optionsStepChips();
    if (c2c_done) return postMigrationChips(dryRunDone, activeErrors);
  }

  return ['Show me the current migration status', 'What do I need to do next?'];
}

function buildStepContextInstruction(state) {
  const { step = 0, migDir, googleAuthed = false, msAuthed = false,
    uploadData = null, mappings_count = 0, c2g_mappings_count = 0,
    cl2g_upload_users = 0, cl2g_mappings_count = 0,
    migDone = false, c2g_done = false, cl2g_done = false,
    live = false, c2g_live = false, cl2g_live = false,
    lastRunWasDry = false, c2gLastDry = false, cl2gLastDry = false } = state ?? {};

  const dryRunDone = (migDir === 'copilot-gemini' ? c2g_done && c2gLastDry
    : migDir === 'claude-gemini' ? cl2g_done && cl2gLastDry
    : migDone && lastRunWasDry);

  const needsGoogle = migDir && migDir !== 'claude-copilot' && migDir !== 'copilot-copilot';
  const needsMs = migDir && (migDir === 'gemini-copilot' || migDir === 'copilot-gemini' || migDir === 'claude-copilot');
  const missingGoogle = needsGoogle && !googleAuthed;
  const missingMs = needsMs && !msAuthed;

  // Auth missing — agent must redirect (but NOT if migration is actively running or done)
  const isRunning = live || c2g_live || cl2g_live || (state.g2g_live ?? false) || (state.cl2c_live ?? false);
  const isDone = migDone || c2g_done || cl2g_done || (state.g2g_done ?? false) || (state.cl2c_done ?? false);
  if (migDir && step >= 2 && !isRunning && !isDone && (missingGoogle || missingMs)) {
    const missing = [missingGoogle && 'Google Workspace', missingMs && 'Microsoft 365'].filter(Boolean).join(' and ');
    return `\n\n[AUTO CONTEXT — AUTH GATE] User is at step ${step} with direction "${migDir}" but ${missing} is NOT connected. You MUST: (1) call navigate_to_step with step=0, (2) tell them which account(s) to connect and why. Be direct: "You need to connect X first." Do not proceed with the current step.`;
  }

  if (!migDir) {
    return `\n\n[AUTO CONTEXT] User hasn't selected a direction yet. Google: ${googleAuthed ? 'connected' : 'not connected'}. MS365: ${msAuthed ? 'connected' : 'not connected'}. Tell them what options are available based on their connected accounts. Be brief and specific.`;
  }

  if (step === 0) return `\n\n[AUTO CONTEXT] User is on Connect Clouds. Direction: ${migDir}. Google: ${googleAuthed ? '✓' : '✗'}. MS365: ${msAuthed ? '✓' : '✗'}. Tell them exactly which button to click next. 1 sentence max.`;
  if (step === 1) return `\n\n[AUTO CONTEXT] User is choosing direction. Direction "${migDir}" is already selected. Tell them to confirm or change it. 1 sentence.`;

  if (migDir === 'gemini-copilot') {
    if (step === 2) {
      if (!uploadData) return `\n\n[BLOCKER] User is at Import Data but has NOT uploaded anything yet. Explain clearly: "Before mapping users or starting migration, you need to import your Google Workspace data. You can either select users directly from Google Workspace (left tab) or upload a Google Vault export ZIP file (right tab). Without this, there's nothing to migrate." Then tell them which option is easier.`;
      return `\n\n[AUTO CONTEXT] Import Data done — ${uploadData.total_users} users loaded. Tell them the import is complete and they can click "Continue →" to map users. DO NOT call navigate_to_step.`;
    }
    if (step === 3) {
      if (mappings_count === 0) return `\n\n[BLOCKER] User is at Map Users but 0 users are mapped. Explain: "You need to match each Google Workspace user to their Microsoft 365 account. Without mappings, migration can't start — the system won't know where to send each person's data. I can auto-map everyone by email right now, or you can set them manually." Offer auto-map as the fast option.`;
      return `\n\n[AUTO CONTEXT] Map Users — ${mappings_count} users mapped. Tell them mappings look good and they can click "Continue →" when ready. DO NOT call navigate_to_step — let the user click the button themselves.`;
    }
    if (step === 4) return `\n\n[AUTO CONTEXT] Options step. ${dryRunDone ? 'Dry run already done — primary action is live migration now.' : 'First time here — explain dry run briefly: it previews what will happen without writing any data. Recommend it before going live.'}`;
  }
  if (migDir === 'copilot-gemini') {
    if (step === 2) {
      if (c2g_mappings_count === 0) return `\n\n[BLOCKER] User is at Map Users (Copilot→Gemini) but 0 users mapped. Explain: "You need to match each Microsoft 365 user to their Google Workspace destination. Without this, the migration engine doesn't know which Google account to write data into. Auto-map will match them by email instantly." Offer auto-map.`;
      return `\n\n[AUTO CONTEXT] Map Users (C2G) — ${c2g_mappings_count} users mapped. Tell them mappings look good and they can click "Continue →" when ready. DO NOT call navigate_to_step — let the user click the button themselves.`;
    }
    if (step === 3) return `\n\n[AUTO CONTEXT] Options (C2G). ${dryRunDone ? 'Dry run done — offer live migration.' : 'Recommend dry run first — safe preview with no data written.'}`;
  }
  if (migDir === 'claude-gemini') {
    if (step === 2) {
      if (cl2g_upload_users === 0) return `\n\n[BLOCKER] User is at Upload ZIP but hasn't uploaded anything. Explain: "To migrate your Claude AI conversations, you first need to export them from Claude.ai. Go to claude.ai → Settings → Account → Export Data, download the ZIP file, then upload it here. This ZIP contains all your conversation history." Give them the steps clearly.`;
      return `\n\n[AUTO CONTEXT] ZIP uploaded — ${cl2g_upload_users} users found. Tell them upload is done and they can click "Continue →" to map users. DO NOT call navigate_to_step.`;
    }
    if (step === 3) {
      if (cl2g_mappings_count === 0) return `\n\n[BLOCKER] User is at Map Users (CL2G) but 0 mapped. Explain: "Each Claude user in your export needs to be matched to a Google Workspace account. This tells the system which Google Drive to put the conversations into. Auto-map will match by email automatically." Offer auto-map.`;
      return `\n\n[AUTO CONTEXT] Map Users (CL2G) — ${cl2g_mappings_count} mapped. Tell them mappings look good and they can click "Continue →" when ready. DO NOT call navigate_to_step — let the user click the button themselves.`;
    }
    if (step === 4) return `\n\n[AUTO CONTEXT] Options (CL2G). ${dryRunDone ? 'Dry run done — offer live migration.' : 'Recommend dry run — safe preview first.'}`;
  }

  if (migDir === 'gemini-gemini') {
    const { g2g_upload_users = 0, g2g_mappings_count = 0, g2g_done = false, g2gLastDry = false } = state;
    const dryRunDone = g2g_done && g2gLastDry;
    if (step === 2) return `\n\n[AUTO CONTEXT] G2G: Select source and destination Google accounts. Tell user to pick two different accounts and click "Continue →". DO NOT call navigate_to_step.`;
    if (step === 3) {
      if (g2g_upload_users === 0) return `\n\n[BLOCKER] G2G: No Vault ZIP uploaded. Tell user to upload their Google Vault export ZIP. Without this there's nothing to migrate.`;
      return `\n\n[AUTO CONTEXT] G2G: Vault ZIP loaded — ${g2g_upload_users} users. They can click "Continue →" to map users. DO NOT call navigate_to_step.`;
    }
    if (step === 4) {
      if (g2g_mappings_count === 0) return `\n\n[BLOCKER] G2G: 0 users mapped. Auto-map will match source→dest by email. Offer auto-map.`;
      return `\n\n[AUTO CONTEXT] G2G: ${g2g_mappings_count} users mapped. They can click "Continue →". DO NOT call navigate_to_step.`;
    }
    if (step === 5) return `\n\n[AUTO CONTEXT] G2G Options. ${dryRunDone ? 'Dry run done — offer live run.' : 'Recommend dry run first.'}`;
  }

  if (migDir === 'claude-copilot') {
    const { cl2c_upload_users = 0, cl2c_mappings_count = 0, cl2c_done = false, cl2cLastDry = false } = state;
    const dryRunDone = cl2c_done && cl2cLastDry;
    if (step === 2) {
      if (cl2c_upload_users === 0) return `\n\n[BLOCKER] CL2C: No Claude ZIP uploaded. Tell user: go to claude.ai → Settings → Export Data, download ZIP, upload here.`;
      return `\n\n[AUTO CONTEXT] CL2C: ZIP loaded — ${cl2c_upload_users} users. Click "Continue →" to map users. DO NOT call navigate_to_step.`;
    }
    if (step === 3) {
      if (cl2c_mappings_count === 0) return `\n\n[BLOCKER] CL2C: 0 users mapped. Each Claude user needs a Microsoft 365 destination email. Auto-map by email. Offer it.`;
      return `\n\n[AUTO CONTEXT] CL2C: ${cl2c_mappings_count} users mapped. Click "Continue →". DO NOT call navigate_to_step.`;
    }
    if (step === 4) return `\n\n[AUTO CONTEXT] CL2C Options. ${dryRunDone ? 'Dry run done — offer live run.' : 'Recommend dry run first.'}`;
  }

  return `\n\n[AUTO CONTEXT] User just navigated to step ${step} (${migDir}). Tell them exactly what to do next. 1-2 sentences, no questions.`;
}

/**
 * Detect direction intent from a user message and return the canonical migDir
 * code, or null if no direction phrase is recognized. This runs BEFORE the LLM
 * so chip generation and prompt context already know the new direction —
 * prevents the case where the agent's text says "switched to G2G" but it
 * forgot to call select_direction, leaving stale C2C chips.
 */
function detectDirectionFromMessage(msg) {
  if (!msg || typeof msg !== 'string') return null;
  const m = msg.toLowerCase();
  // Order matters — more specific patterns first
  if (/(gemini|google)\s*(→|->|to)\s*(gemini|google)\b/.test(m) || /\bg2g\b|gemini.{0,5}gemini|google.{0,5}google/i.test(m)) return 'gemini-gemini';
  if (/(copilot|microsoft|ms365|m365)\s*(→|->|to)\s*(copilot|microsoft|ms365|m365)\b/.test(m) || /\bc2c\b|copilot.{0,5}copilot|cross.?tenant/i.test(m)) return 'copilot-copilot';
  if (/(gemini|google).*(→|->|to).*(copilot|microsoft|ms365|m365|onenote)/i.test(m) || /\bg2c\b|gemini.{0,30}copilot|google.{0,30}microsoft/i.test(m)) return 'gemini-copilot';
  if (/(copilot|microsoft|ms365|m365).*(→|->|to).*(gemini|google|drive)/i.test(m) || /\bc2g\b|copilot.{0,30}gemini|microsoft.{0,30}google/i.test(m)) return 'copilot-gemini';
  if (/claude.*(→|->|to).*(gemini|google|drive)/i.test(m) || /\bcl2g\b|claude.{0,30}gemini|claude.{0,30}google/i.test(m)) return 'claude-gemini';
  if (/claude.*(→|->|to).*(copilot|microsoft|onenote|ms365|m365)/i.test(m) || /\bcl2c\b|claude.{0,30}copilot|claude.{0,30}microsoft/i.test(m)) return 'claude-copilot';
  return null;
}

export async function runAgentLoop(req, res, { message, migrationState: _migrationState, migrationLogs, isSystemTrigger, db, agentDeps }) {
  let migrationState = _migrationState;
  // Pre-LLM direction detection: if the user clearly named a direction in
  // this message, update migrationState so chips + prompt match the user's
  // intent even if the LLM forgets to call select_direction.
  if (!isSystemTrigger && message) {
    const detected = detectDirectionFromMessage(message);
    if (detected && detected !== migrationState?.migDir) {
      migrationState = { ...migrationState, migDir: detected };
    }
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const appUserId = req.session?.appUser?._id || req.session?.appUser?.email || req.session?.appUserId;
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const streamText = (content) => res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
  const streamEvent = (event, payload = {}) => res.write(`data: ${JSON.stringify({ type: 'ui_event', event, ...payload })}\n\n`);
  const streamQuickReplies = (replies) => streamEvent('quick_replies', { replies });
  const streamDone = () => { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); res.end(); };

  const toolCtx = { streamEvent, session: req.session, migrationState, migrationLogs, db, agentDeps };

  try {
    // Handle pending confirmation — user replied "Yes, proceed" or "Cancel"
    if (req.session.pendingAction) {
      if (message === 'Yes, proceed' || message === 'Yes') {
        const { tool, args } = req.session.pendingAction;
        req.session.pendingAction = null;
        req.session.pendingConfirmed = true;
        const result = await executeTool(tool, args, toolCtx);
        const replyMsg = await callAI([
          { role: 'system', content: buildSystemPrompt(migrationState, migrationLogs) },
          { role: 'user', content: `I confirmed. Tool ${tool} completed with result: ${JSON.stringify(result)}. Tell me what happened in a natural, friendly way.` },
        ], null);
        streamText(replyMsg.content ?? 'Done!');
        streamQuickReplies(defaultChips(migrationState));
        await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
        await saveHistory(db, appUserId, 'assistant', replyMsg.content ?? 'Done!', migrationState?.migDir);
        return streamDone();
      }

      if (message === 'Cancel') {
        req.session.pendingAction = null;
        streamText("No problem — cancelled. What would you like to do instead?");
        streamQuickReplies(defaultChips(migrationState));
        await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
        await saveHistory(db, appUserId, 'assistant', 'Cancelled.', migrationState?.migDir);
        return streamDone();
      }

      // Non-confirmation message while pending — clear the pending action and continue normally
      req.session.pendingAction = null;
    }

    const history = await loadHistory(db, appUserId);
    const isReturningUser = history.length > 0;
    await auditLog(sessionId, 'session_start', {
      appUserId,
      message: isSystemTrigger ? '__step_context__' : message,
      isSystemTrigger,
      step: migrationState?.step,
      migDir: migrationState?.migDir,
      googleAuthed: migrationState?.googleAuthed,
      msAuthed: migrationState?.msAuthed,
      historyLength: history.length,
    });
    const systemPrompt = buildSystemPrompt(migrationState, migrationLogs, { isReturningUser });

    const stepContextInstruction = isSystemTrigger
      ? buildStepContextInstruction(migrationState)
      : '';

    // Greeting only fires on __step_context__ when this is truly the first message (no history)
    const isFirstMessage = message === '__step_context__' && !isReturningUser;
    const isReturnGreet  = message === '__step_context__' && isReturningUser && history.length === 0;

    const greetingInstruction = isFirstMessage
      ? `\n\n[GREETING — FIRST VISIT] Welcome ${migrationState.appUserName ?? 'the user'} by name. Introduce yourself as GEM, CloudFuze's migration assistant. In 3-4 sentences: (1) greet them by first name, (2) say what GEM can do — migrate Google Workspace, Microsoft 365 Copilot, and Claude AI conversations, (3) tell them the first step is connecting their cloud accounts on the ${migrationState.panelSwapped ? 'left' : 'right'} panel. Professional, warm, not robotic.`
      : isReturnGreet
        ? `\n\n[GREETING — RETURNING USER] Welcome ${migrationState.appUserName ?? 'back'} back by name. 1 sentence warm greeting, then immediately tell them where they left off based on current state. Be specific. No generic intros.`
        : '';

    const messages = [
      { role: 'system', content: systemPrompt + stepContextInstruction + greetingInstruction },
      ...(isSystemTrigger ? [] : history),
      { role: 'user', content: (isFirstMessage || isReturnGreet) ? 'Greet me.' : isSystemTrigger ? 'What should I do on this step?' : message },
    ];

    // System trigger gets safe navigation tools so agent can redirect user (e.g. back to connect clouds)
    const SAFE_TOOLS = AGENT_TOOLS.filter(t => ['navigate_to_step', 'select_direction', 'show_upload_widget', 'explain_error'].includes(t.function?.name));

    logger.info(`[agentLoop] user=${appUserId} msg="${message?.slice(0, 80)}" step=${migrationState?.step} migDir=${migrationState?.migDir}`);

    let iterations = 0;
    let toolCallsMade = 0;
    let finalReply = null;

    while (iterations++ < MAX_ITERATIONS) {
      const aiMsg = await callAI(messages, isSystemTrigger ? SAFE_TOOLS : AGENT_TOOLS);

      // Text-only response — loop ends
      if (aiMsg.content && (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0)) {
        finalReply = aiMsg.content;
        await auditLog(sessionId, 'llm_response', {
          appUserId,
          iteration: iterations,
          content: finalReply?.slice(0, 500),
          toolCalls: aiMsg.tool_calls?.map(t => t.function?.name) ?? [],
        });
        req.session.pendingConfirmed = false;
        break;
      }

      // Tool call
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        const call = aiMsg.tool_calls[0];
        const toolName = call.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(call.function.arguments || '{}'); } catch (_) {}

        toolCallsMade++;
        logger.info(`[agentLoop] iteration=${iterations} tool_call=${toolName}`);
        await auditLog(sessionId, 'tool_call', {
          appUserId,
          iteration: iterations,
          toolName,
          toolArgs,
        });

        // Gate destructive tools on confirmation
        if (DESTRUCTIVE_TOOLS.includes(toolName) && !req.session.pendingConfirmed) {
          const conf = CONFIRMATION_MESSAGES[toolName];
          const confirmText = toolName === 'start_migration'
            ? (toolArgs.dryRun ? conf.dry : conf.live)
            : conf.default;
          req.session.pendingAction = { tool: toolName, args: toolArgs };
          await auditLog(sessionId, 'confirmation_gate', {
            appUserId,
            toolName,
            toolArgs,
            confirmText: confirmText.slice(0, 200),
          });
          streamText(confirmText);
          streamQuickReplies(['Yes, proceed', 'Cancel']);
          await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
          await saveHistory(db, appUserId, 'assistant', confirmText, migrationState?.migDir);
          await auditLog(sessionId, 'session_end', { appUserId, finalReplyLength: confirmText.length, toolCallCount: toolCallsMade });
          return streamDone();
        }

        req.session.pendingConfirmed = false;

        const result = await executeTool(toolName, toolArgs, toolCtx);
        logger.info(`[agentLoop] tool_result=${toolName} → ${JSON.stringify(result).slice(0, 200)}`);
        await auditLog(sessionId, 'tool_result', {
          appUserId,
          toolName,
          result,
        });

        // Keep migrationState in sync so defaultChips() uses current direction/step
        if (toolName === 'select_direction' && result.selected && toolArgs.migDir) {
          migrationState = { ...migrationState, migDir: toolArgs.migDir };
        }
        if (toolName === 'navigate_to_step' && result.navigated && toolArgs.step != null) {
          migrationState = { ...migrationState, step: toolArgs.step };
        }

        // Feed result back to AI. Only include the tool_call we actually executed —
        // if the LLM returned multiple parallel tool_calls, we'd otherwise push
        // them ALL into history but only reply to the first, leaving the rest
        // orphaned, which makes the next OpenAI call fail with a 400
        // ("tool_call_id without response messages"). The model will retry any
        // skipped tool calls on the next iteration anyway.
        messages.push({ role: 'assistant', tool_calls: [call] });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        continue;
      }

      // AI returned neither content nor tool_calls
      finalReply = aiMsg.content || "I couldn't generate a response. Please try again.";
      break;
    }

    if (!finalReply) {
      finalReply = "I've been working through this but ran into a limit. Could you rephrase?";
    }

    streamText(finalReply);

    // AI-generated chips — contextual to agent reply + state. Falls back to rule-based.
    const aiChips = isSystemTrigger ? null : await generateChips(finalReply, migrationState);
    streamQuickReplies(aiChips ?? defaultChips(migrationState));

    if (!isSystemTrigger) {
      await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
      await saveHistory(db, appUserId, 'assistant', finalReply, migrationState?.migDir);
    }

    await auditLog(sessionId, 'session_end', {
      appUserId,
      finalReplyLength: finalReply?.length ?? 0,
      toolCallCount: toolCallsMade,
    });

  } catch (err) {
    logger.error(`[agentLoop] error: ${err.message}`);
    await auditLog(sessionId, 'error', { appUserId, error: err.message });
    streamText(`I ran into a problem: ${err.message}. Please try again.`);
  }

  streamDone();
}
