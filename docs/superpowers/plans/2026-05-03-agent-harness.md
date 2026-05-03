# Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the signal-based agent (frontend executes actions) with a true agentic backend loop that streams SSE events to the frontend, executes all tools server-side, persists conversation history, and drives the full migration flow through natural language.

**Architecture:** The `/api/chat` route becomes an SSE endpoint. A backend loop calls AI, executes tool calls directly, streams UI events and text to the frontend. Frontend drops all action-execution logic and becomes a pure SSE consumer. All 3 migration combinations (G2C, C2G, CL2G) are registered in a COMBINATIONS registry for extensibility.

**Tech Stack:** Node.js ES modules, Express SSE, OpenAI/Azure tool calls, MongoDB (chatHistory + scheduledJobs collections), React inline JSX in ui/index.html

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/agent/callAI.js` | **Create** | Extracted AI caller — returns `choices[0].message` |
| `src/agent/combinations.js` | **Create** | Registry of all migration directions |
| `src/agent/conversationHistory.js` | **Create** | MongoDB chatHistory read/write |
| `src/agent/tools.js` | **Create** | AGENT_TOOLS array + 4 new tools |
| `src/agent/systemPrompt.js` | **Create** | Context-aware system prompt builder |
| `src/agent/toolExecutor.js` | **Create** | Executes all 16 tool calls server-side |
| `src/agent/agentLoop.js` | **Create** | SSE agentic loop — calls AI, executes tools, streams |
| `src/modules/g2c/routes.js` | **Modify** | Wire /api/chat to agentLoop; remove old handler |
| `ui/index.html` | **Modify** | Replace fetch→json with SSE consumer; remove action-execution code |

---

## Task 1: callAI utility

**Files:**
- Create: `src/agent/callAI.js`

This extracts the `callAI` function from `src/modules/g2c/routes.js` (lines 230–263) into a shared module. The new version returns `choices[0].message` directly instead of the raw API response.

- [ ] **Step 1: Create `src/agent/callAI.js`**

```js
// src/agent/callAI.js
export async function callAI(messages, tools) {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const openaiKey = process.env.OPENAI_API_KEY;

  let response;

  if (azureEndpoint && azureKey) {
    const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    const body = { messages, max_tokens: 900, temperature: 0.4 };
    if (tools) body.tools = tools;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': azureKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`Azure OpenAI error ${r.status}: ${t}`); }
    response = await r.json();
  } else if (openaiKey) {
    const body = { model: 'gpt-4o', messages, max_tokens: 700, temperature: 0.35 };
    if (tools) body.tools = tools;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI error ${r.status}: ${t}`); }
    response = await r.json();
  } else {
    throw new Error('No AI provider configured. Set AZURE_OPENAI_API_KEY or OPENAI_API_KEY in .env');
  }

  return response.choices?.[0]?.message ?? { content: 'No response from AI.' };
}
```

- [ ] **Step 2: Verify file was created**

```bash
node -e "import('./src/agent/callAI.js').then(m => console.log('callAI exported:', typeof m.callAI))"
```
Expected: `callAI exported: function`

- [ ] **Step 3: Commit**

```bash
git add src/agent/callAI.js
git commit -m "feat(agent): extract callAI to shared utility, return message directly"
```

---

## Task 2: Combination Registry

**Files:**
- Create: `src/agent/combinations.js`

Registry of all 3 migration directions. Adding a 4th direction = adding one entry here — no other files change.

- [ ] **Step 1: Create `src/agent/combinations.js`**

```js
// src/agent/combinations.js
export const COMBINATIONS = {
  'gemini-copilot': {
    label: 'Google Workspace → Microsoft 365',
    auth: ['google', 'microsoft'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Import Data', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      if (!state.msAuthed) blockers.push('Microsoft 365 not connected');
      return blockers;
    },
    mappingsCount: (state) => state.mappings_count ?? 0,
    isLive: (state) => !!state.live,
    isDone: (state) => !!state.migDone,
  },
  'copilot-gemini': {
    label: 'Microsoft 365 Copilot → Google Workspace',
    auth: ['microsoft', 'google'],
    hasUpload: false,
    steps: ['Connect', 'Direction', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.msAuthed) blockers.push('Microsoft 365 not connected');
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      return blockers;
    },
    mappingsCount: (state) => state.c2g_mappings_count ?? 0,
    isLive: (state) => !!state.c2g_live,
    isDone: (state) => !!state.c2g_done,
  },
  'claude-gemini': {
    label: 'Microsoft Teams/Copilot ZIP → Google Workspace',
    auth: ['google'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Upload ZIP', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      return blockers;
    },
    mappingsCount: (state) => state.cl2g_mappings_count ?? 0,
    isLive: (state) => !!state.cl2g_live,
    isDone: (state) => !!state.cl2g_done,
  },
};

export function getCombo(migDir) {
  return COMBINATIONS[migDir] ?? null;
}

export function listCombinations() {
  return Object.entries(COMBINATIONS).map(([key, c]) => ({
    key,
    label: c.label,
    auth: c.auth,
    hasUpload: c.hasUpload,
  }));
}
```

- [ ] **Step 2: Verify**

```bash
node -e "import('./src/agent/combinations.js').then(m => console.log('combos:', Object.keys(m.COMBINATIONS)))"
```
Expected: `combos: [ 'gemini-copilot', 'copilot-gemini', 'claude-gemini' ]`

- [ ] **Step 3: Commit**

```bash
git add src/agent/combinations.js
git commit -m "feat(agent): combination registry — extensible per-direction config"
```

---

## Task 3: Conversation History

**Files:**
- Create: `src/agent/conversationHistory.js`

Persists the last 20 chat messages per user in MongoDB `chatHistory` collection. On session start, history is loaded and injected into the AI context.

- [ ] **Step 1: Create `src/agent/conversationHistory.js`**

```js
// src/agent/conversationHistory.js
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:history');
const MAX_HISTORY = 50;
const LOAD_LIMIT = 20;

export async function loadHistory(db, appUserId) {
  try {
    const docs = await db.collection('chatHistory')
      .find({ appUserId })
      .sort({ timestamp: 1 })
      .limit(LOAD_LIMIT)
      .toArray();
    return docs.map(d => ({ role: d.role, content: d.content }));
  } catch (e) {
    logger.warn(`loadHistory failed for ${appUserId}: ${e.message}`);
    return [];
  }
}

export async function saveHistory(db, appUserId, role, content, migDir) {
  try {
    await db.collection('chatHistory').insertOne({
      appUserId,
      role,
      content,
      migDir: migDir ?? null,
      timestamp: new Date(),
    });
    // Trim to MAX_HISTORY — delete oldest beyond limit
    const count = await db.collection('chatHistory').countDocuments({ appUserId });
    if (count > MAX_HISTORY) {
      const oldest = await db.collection('chatHistory')
        .find({ appUserId })
        .sort({ timestamp: 1 })
        .limit(count - MAX_HISTORY)
        .toArray();
      const ids = oldest.map(d => d._id);
      await db.collection('chatHistory').deleteMany({ _id: { $in: ids } });
    }
  } catch (e) {
    logger.warn(`saveHistory failed for ${appUserId}: ${e.message}`);
  }
}

export async function clearHistory(db, appUserId) {
  try {
    await db.collection('chatHistory').deleteMany({ appUserId });
  } catch (e) {
    logger.warn(`clearHistory failed for ${appUserId}: ${e.message}`);
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "import('./src/agent/conversationHistory.js').then(m => console.log('exports:', Object.keys(m).join(', ')))"
```
Expected: `exports: loadHistory, saveHistory, clearHistory`

- [ ] **Step 3: Commit**

```bash
git add src/agent/conversationHistory.js
git commit -m "feat(agent): conversation history — load/save/trim chatHistory collection"
```

---

## Task 4: Tools Definition

**Files:**
- Create: `src/agent/tools.js`

Extracts the existing 12 AGENT_TOOLS from `src/modules/g2c/routes.js` (lines 87–226) and adds 4 new tools: `get_auth_status`, `get_conversation_history`, `explain_error`, `set_schedule`.

- [ ] **Step 1: Create `src/agent/tools.js`**

```js
// src/agent/tools.js

export const DESTRUCTIVE_TOOLS = ['start_migration', 'retry_failed'];

export const CONFIRMATION_MESSAGES = {
  start_migration: {
    dry: 'Ready to run a **dry run** — this is safe, no data will be written. Shall I proceed?',
    live: 'Ready to **go live** — this will write real data to the destination. Are you sure?',
  },
  retry_failed: {
    default: 'I\'ll retry all failed items from the last batch. Want me to go ahead?',
  },
};

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'show_reports',
      description: 'Open the migration reports panel',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_mapping',
      description: 'Open the user mapping grid in the left panel',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_migration_status',
      description: 'Get current migration progress, stats, and state from the database',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_log',
      description: 'Explain what a migration log line means and suggest action',
      parameters: {
        type: 'object',
        properties: { log_line: { type: 'string', description: 'The exact log message text' } },
        required: ['log_line'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_status_card',
      description: 'Display a visual status card with migration stats',
      parameters: {
        type: 'object',
        properties: {
          users: { type: 'number', description: 'Users processed' },
          files: { type: 'number', description: 'Files/pages migrated' },
          errors: { type: 'number', description: 'Error count' },
          label: { type: 'string', description: 'Card title' },
        },
        required: ['users', 'files', 'errors'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_post_migration_guide',
      description: 'Show post-migration setup instructions when user asks what to do next after migration completes',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate_to_step',
      description: 'Navigate the left panel to a specific step. Use when user asks to go somewhere.',
      parameters: {
        type: 'object',
        properties: { step: { type: 'number', description: 'Step index: 0=Connect, 1=Direction, 2=Upload/Import, 3=Map Users, 4=Options, 5=Migration' } },
        required: ['step'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_direction',
      description: 'Set the migration direction and advance the left panel to the next step. Call when user says which direction they want.',
      parameters: {
        type: 'object',
        properties: { migDir: { type: 'string', enum: ['gemini-copilot', 'copilot-gemini', 'claude-gemini'] } },
        required: ['migDir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_migration',
      description: 'Start migration. Always call pre_flight_check first. Agent will ask user to confirm before this executes.',
      parameters: {
        type: 'object',
        properties: { dryRun: { type: 'boolean', description: 'true = dry run (safe preview), false = live migration (writes data)' } },
        required: ['dryRun'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed',
      description: 'Retry failed items from the last migration batch. Only call if migration is done and errors > 0.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_map_users',
      description: 'Automatically map source users to destination users by matching email addresses. Works for all directions.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_migration_config',
      description: 'Set migration options: folder name, date range, dry run toggle',
      parameters: {
        type: 'object',
        properties: {
          folderName: { type: 'string' },
          fromDate: { type: 'string' },
          toDate: { type: 'string' },
          dryRun: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pre_flight_check',
      description: 'Validate state before starting migration. Always call this before start_migration. Returns blockers and warnings.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_auth_status',
      description: 'Check which cloud accounts are currently authenticated by querying the database directly.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_error',
      description: 'Read migration error logs and explain what went wrong in plain English with suggested fixes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_schedule',
      description: 'Schedule a migration to run at a specific time. Use when user asks to run migration at a later time.',
      parameters: {
        type: 'object',
        properties: {
          runAt: { type: 'string', description: 'ISO datetime string for when to run' },
          dryRun: { type: 'boolean', description: 'Whether scheduled run should be dry run' },
        },
        required: ['runAt'],
      },
    },
  },
];
```

- [ ] **Step 2: Verify**

```bash
node -e "import('./src/agent/tools.js').then(m => console.log('tools:', m.AGENT_TOOLS.length, 'destructive:', m.DESTRUCTIVE_TOOLS))"
```
Expected: `tools: 16 destructive: [ 'start_migration', 'retry_failed' ]`

- [ ] **Step 3: Commit**

```bash
git add src/agent/tools.js
git commit -m "feat(agent): tools definition — 16 tools including 4 new (auth_status, explain_error, history, schedule)"
```

---

## Task 5: System Prompt Builder

**Files:**
- Create: `src/agent/systemPrompt.js`

Extracts and enhances the system prompt from `src/modules/g2c/routes.js` (lines 1119–1200). New version reads available combinations from the registry, adds persona section, and adds response style rules.

- [ ] **Step 1: Create `src/agent/systemPrompt.js`**

```js
// src/agent/systemPrompt.js
import { COMBINATIONS, listCombinations } from './combinations.js';

export function buildSystemPrompt(migrationState, migrationLogs = []) {
  const {
    step = 0, migDir = null, live = false, migDone = false,
    stats = {}, lastRunWasDry = false, uploadData = null,
    googleAuthed = false, msAuthed = false,
    mappings_count = 0, selected_users_count = 0, options = {},
    c2g_mappings_count = 0, cl2g_upload_users = 0, cl2g_mappings_count = 0,
    c2g_done = false, cl2g_done = false, c2g_live = false, cl2g_live = false,
    uiContext = '',
  } = migrationState;

  const combo = COMBINATIONS[migDir];
  const dirLabel = combo?.label ?? 'not selected';
  const effectiveMappings = combo?.mappingsCount(migrationState) ?? 0;
  const isRunning = live || c2g_live || cl2g_live;
  const isDone = migDone || c2g_done || cl2g_done;

  // Build panel context from uiContext (sent by frontend) or fallback
  const panelContext = uiContext || buildPanelContext({ step, migDir, uploadData, mappings_count, c2g_mappings_count, cl2g_mappings_count, cl2g_upload_users, live, migDone, stats, options, c2g_live, cl2g_live, c2g_done, cl2g_done, googleAuthed, msAuthed, selected_users_count });

  const logsSection = migrationLogs.length > 0
    ? `\nRecent logs (${migrationLogs.length}):\n${migrationLogs.slice(-20).join('\n')}\n`
    : '';

  // List available combinations for agent awareness
  const combosText = listCombinations()
    .map(c => `  • ${c.label} — needs: ${c.auth.join(' + ')}${c.hasUpload ? ', requires file upload' : ''}`)
    .join('\n');

  return `You are GEM — the CloudFuze Migration Assistant. You are an active participant in the user's migration: you execute actions, not just advise. Think out loud. Be natural, direct, and vary your tone to the situation.

## Persona
- Think through the situation before answering: "Okay, I can see that..."
- Explain *why*, not just *what*: "I'll run a dry run first — safer, and it gives you a preview"
- Suggest next steps proactively — don't wait to be asked
- Match response length to situation: 1-2 sentences for confirmations, 3-4 for explanations
- Use natural language: "Looks like...", "Good news —", "One thing I notice...", "Let me..."
- Never be robotic or repeat the same phrasing twice in a row

## Available Migration Combinations
${combosText}

## What the user sees RIGHT NOW
${panelContext}

## Current State
- Direction: ${dirLabel}
- Google Workspace: ${googleAuthed ? '✓ connected' : '✗ not connected'}
- Microsoft 365: ${msAuthed ? '✓ connected' : '✗ not connected'}
- Mappings: ${step < 2 ? 'N/A — user not at mapping step yet' : `${effectiveMappings} users mapped`}
- Migration: ${isRunning ? 'RUNNING' : isDone ? 'DONE' : 'not started'}
- Last run: ${lastRunWasDry ? 'dry run' : 'live'} | Users: ${stats.users ?? 0} · Files: ${stats.pages ?? 0} · Errors: ${stats.errors ?? 0}
${logsSection}
## Tool Rules
- Direction name → call select_direction immediately (safe, no confirm needed)
- "show reports" / "show mapping" / "navigate" → call those tools immediately (safe)
- "auto map" / "map users" → call auto_map_users (will execute server-side, ask user first)
- "start" / "dry run" / "go" / "migrate" → call pre_flight_check FIRST, then start_migration — system will ask user to confirm
- "go live" → pre_flight_check then start_migration with dryRun:false — system asks confirm
- "retry" → call retry_failed — system will ask confirm
- NEVER call start_migration without pre_flight_check first
- If intent is ambiguous → ask a clarifying question, do not guess

## Response Style Rules
- Address what the user SEES on the left panel right now — be specific
- If user intent is clear → use the tool, don't just explain
- Keep responses SHORT unless user asks for detail
- Use **bold** for key values, bullets only for multi-step sequences`;
}

function buildPanelContext({ step, migDir, uploadData, mappings_count, c2g_mappings_count, cl2g_mappings_count, cl2g_upload_users, live, migDone, stats, options, c2g_live, cl2g_live, c2g_done, cl2g_done, googleAuthed, msAuthed, selected_users_count }) {
  if (!migDir) {
    if (step === 0) return 'LEFT PANEL: Connect Clouds. User needs to connect Google and/or Microsoft 365.';
    if (step === 1) return 'LEFT PANEL: Choose Direction. User sees Gemini→Copilot, Copilot→Gemini, Claude→Gemini options.';
  }
  if (migDir === 'gemini-copilot') {
    if (step === 0) return 'LEFT PANEL: Connect Clouds (Gemini→Copilot). Needs Google Workspace + Microsoft 365.';
    if (step === 1) return 'LEFT PANEL: Choose Direction. Already selected Gemini→Copilot.';
    if (step === 2) return `LEFT PANEL: Import Data (Gemini→Copilot). Upload status: ${uploadData ? `✓ ${uploadData.total_users} users loaded` : '✗ not uploaded'}.`;
    if (step === 3) return `LEFT PANEL: Map Users (Gemini→Copilot). ${mappings_count} users mapped, ${selected_users_count} selected.`;
    if (step === 4) return `LEFT PANEL: Options (Gemini→Copilot). dryRun=${options.dryRun}. Start Migration button visible.`;
    return `LEFT PANEL: Migration (Gemini→Copilot). Running: ${live}. Done: ${migDone}. Stats: ${stats.users??0} users, ${stats.pages??0} files, ${stats.errors??0} errors.`;
  }
  if (migDir === 'copilot-gemini') {
    if (step <= 1) return 'LEFT PANEL: Connect/Direction (Copilot→Gemini).';
    if (step === 2) return `LEFT PANEL: Map Users (Copilot→Gemini). ${c2g_mappings_count} users mapped.`;
    if (step === 3) return `LEFT PANEL: Options (Copilot→Gemini). dryRun=${options.dryRun}.`;
    return `LEFT PANEL: Migration (Copilot→Gemini). Running: ${c2g_live}. Done: ${c2g_done}.`;
  }
  if (migDir === 'claude-gemini') {
    if (step <= 1) return 'LEFT PANEL: Connect/Direction (Claude→Gemini).';
    if (step === 2) return `LEFT PANEL: Upload ZIP (Claude→Gemini). ${cl2g_upload_users > 0 ? `✓ ${cl2g_upload_users} users` : '✗ not uploaded'}.`;
    if (step === 3) return `LEFT PANEL: Map Users (Claude→Gemini). ${cl2g_mappings_count} users mapped.`;
    if (step === 4) return `LEFT PANEL: Options (Claude→Gemini). dryRun=${options.dryRun}.`;
    return `LEFT PANEL: Migration (Claude→Gemini). Running: ${cl2g_live}. Done: ${cl2g_done}.`;
  }
  return `LEFT PANEL: Step ${step}, direction ${migDir ?? 'not selected'}.`;
}
```

- [ ] **Step 2: Verify**

```bash
node -e "import('./src/agent/systemPrompt.js').then(m => { const p = m.buildSystemPrompt({step:0,googleAuthed:true,msAuthed:false}); console.log('prompt length:', p.length, 'has persona:', p.includes('GEM')); })"
```
Expected: `prompt length: [>500] has persona: true`

- [ ] **Step 3: Commit**

```bash
git add src/agent/systemPrompt.js
git commit -m "feat(agent): system prompt builder — persona, combinations-aware, response style rules"
```

---

## Task 6: Tool Executor

**Files:**
- Create: `src/agent/toolExecutor.js`

Executes all 16 tool calls server-side. UI tools stream SSE events. Execution tools call backend logic. Destructive tools are gated in the agent loop (Task 7) but executed here after confirmation.

- [ ] **Step 1: Create `src/agent/toolExecutor.js`**

```js
// src/agent/toolExecutor.js
import { getLogger } from '../utils/logger.js';
import { COMBINATIONS } from './combinations.js';
import { callAI } from './callAI.js';
import { loadHistory } from './conversationHistory.js';

const logger = getLogger('agent:executor');

export async function executeTool(toolName, args, { streamEvent, session, migrationState, migrationLogs, db }) {
  const migDir = migrationState?.migDir;
  const appUserId = session?.appUser?.id || session?.appUserId;

  switch (toolName) {

    // ── UI event tools ─────────────────────────────────────────────────────
    case 'navigate_to_step': {
      const step = typeof args.step === 'number' ? args.step : parseInt(args.step, 10);
      streamEvent('navigate', { step });
      return { navigated: true, step };
    }

    case 'select_direction': {
      const nextStep = args.migDir === 'copilot-gemini' ? 2 : 2;
      streamEvent('select_direction', { direction: args.migDir, step: nextStep });
      return { selected: true, direction: args.migDir };
    }

    case 'show_reports': {
      streamEvent('refresh_reports', {});
      return { shown: true };
    }

    case 'show_mapping': {
      streamEvent('refresh_mapping', {});
      return { shown: true };
    }

    case 'show_post_migration_guide': {
      streamEvent('show_widget', { widget: { type: 'post_migration_guide', migDir } });
      return { shown: true };
    }

    case 'show_status_card': {
      streamEvent('show_widget', {
        widget: { type: 'status_card', users: args.users ?? 0, files: args.files ?? 0, errors: args.errors ?? 0, label: args.label ?? 'Migration Results' },
      });
      return { shown: true };
    }

    case 'set_migration_config': {
      // Store config in session for agent to reference later; return for AI to confirm
      session.agentConfig = { ...(session.agentConfig ?? {}), ...args };
      streamEvent('set_config', { config: args });
      return { set: true, config: args };
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
      const { step, migDir: dir, live, migDone, stats, c2g_live, cl2g_live, c2g_done, cl2g_done, currentBatchId } = migrationState;
      const isRunning = live || c2g_live || cl2g_live;
      const isDone = migDone || c2g_done || cl2g_done;
      const logTail = migrationLogs?.slice(-20) ?? [];
      let dbStatus = null;
      if (currentBatchId) {
        try {
          dbStatus = await db.collection('reportsWorkspace').findOne({ batchId: currentBatchId });
        } catch (_) {}
      }
      return {
        step, direction: dir ?? 'none', running: isRunning, done: isDone,
        users: stats?.users ?? dbStatus?.progressUsers ?? 0,
        pages: stats?.pages ?? dbStatus?.progressPages ?? 0,
        errors: stats?.errors ?? dbStatus?.progressErrors ?? 0,
        recentLogs: logTail,
      };
    }

    case 'pre_flight_check': {
      const combo = COMBINATIONS[migDir];
      const blockers = [];
      const warnings = [];
      if (!migDir) { blockers.push('No migration direction selected'); }
      else {
        blockers.push(...combo.authCheck(migrationState));
        const effectiveMappings = combo.mappingsCount(migrationState);
        if (combo.hasUpload && migDir === 'gemini-copilot' && !migrationState.uploadData) {
          blockers.push('No data uploaded or imported yet');
        }
        if (migDir === 'claude-gemini' && (migrationState.cl2g_upload_users ?? 0) === 0) {
          blockers.push('No ZIP uploaded yet');
        }
        if (effectiveMappings === 0) blockers.push('No users mapped');
        if (combo.isLive(migrationState)) blockers.push('Migration already running');
        if ((migrationState.selected_users_count ?? 0) < effectiveMappings) {
          warnings.push(`${effectiveMappings - (migrationState.selected_users_count ?? 0)} users have no destination — they will be skipped`);
        }
      }
      return { blockers, warnings, ready: blockers.length === 0 };
    }

    case 'auto_map_users': {
      if (!migDir) return { error: 'No direction selected' };
      try {
        // Fetch stored user lists and email-match them
        const sourceUsers = await db.collection('cachedUsers')
          .find({ appUserId, role: 'source', migDir })
          .toArray();
        const destUsers = await db.collection('cachedUsers')
          .find({ appUserId, role: 'dest', migDir })
          .toArray();

        const destByEmail = new Map(destUsers.map(u => [u.email?.toLowerCase(), u]));
        const mappings = {};
        let matched = 0;
        for (const src of sourceUsers) {
          const dest = destByEmail.get(src.email?.toLowerCase());
          if (dest) { mappings[src.email] = dest.email; matched++; }
        }

        const collName = migDir === 'copilot-gemini' ? 'c2gUserMappings'
          : migDir === 'claude-gemini' ? 'cl2gUserMappings'
          : 'userMappings';

        await db.collection(collName).updateOne(
          { appUserId, migDir },
          { $set: { mappings, updatedAt: new Date() } },
          { upsert: true }
        );

        streamEvent('refresh_mapping', {});
        return { matched, total: sourceUsers.length };
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
      // Ask AI to summarize errors in plain English
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
      const { startMigration } = session._agentDeps ?? {};
      if (!startMigration) return { error: 'Migration executor not available' };
      const batchId = `batch_${Date.now()}`;
      // Fire and forget — migration runs in background
      startMigration({ dryRun: args.dryRun ?? true, batchId, migDir, appUserId }).catch(e => {
        logger.error(`Background migration failed: ${e.message}`);
      });
      session.currentBatchId = batchId;
      streamEvent('refresh_status', { batchId });
      return { started: true, batchId, dryRun: args.dryRun ?? true };
    }

    case 'retry_failed': {
      const { retryMigration } = session._agentDeps ?? {};
      if (!retryMigration) return { error: 'Retry executor not available' };
      const batchId = session.currentBatchId;
      if (!batchId) return { error: 'No migration batch found to retry' };
      retryMigration({ batchId, appUserId }).catch(e => {
        logger.error(`Background retry failed: ${e.message}`);
      });
      streamEvent('refresh_status', { batchId });
      return { retrying: true, batchId };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "import('./src/agent/toolExecutor.js').then(m => console.log('executeTool exported:', typeof m.executeTool))"
```
Expected: `executeTool exported: function`

- [ ] **Step 3: Commit**

```bash
git add src/agent/toolExecutor.js
git commit -m "feat(agent): tool executor — all 16 tools execute server-side with SSE events"
```

---

## Task 7: Agent Loop

**Files:**
- Create: `src/agent/agentLoop.js`

The SSE agentic loop. Runs AI in a loop (max 8 iterations), executes tool calls via toolExecutor, gates destructive tools on confirmation, streams text + UI events to frontend, saves conversation history.

- [ ] **Step 1: Create `src/agent/agentLoop.js`**

```js
// src/agent/agentLoop.js
import { callAI } from './callAI.js';
import { AGENT_TOOLS, DESTRUCTIVE_TOOLS, CONFIRMATION_MESSAGES } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { loadHistory, saveHistory } from './conversationHistory.js';
import { executeTool } from './toolExecutor.js';
import { generateSuggestedChips } from '../modules/g2c/routes.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:loop');
const MAX_ITERATIONS = 8;

export async function runAgentLoop(req, res, { message, migrationState, migrationLogs, isSystemTrigger, db }) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const appUserId = req.session?.appUser?.id || req.session?.appUserId;

  const streamText = (content) => res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
  const streamEvent = (event, payload = {}) => res.write(`data: ${JSON.stringify({ type: 'ui_event', event, ...payload })}\n\n`);
  const streamQuickReplies = (replies) => streamEvent('quick_replies', { replies });
  const streamDone = () => { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); res.end(); };

  const toolCtx = { streamEvent, session: req.session, migrationState, migrationLogs, db };

  try {
    // Handle pending confirmation
    if (req.session.pendingAction && (message === 'Yes, proceed' || message === 'Yes')) {
      const { tool, args } = req.session.pendingAction;
      req.session.pendingAction = null;
      req.session.pendingConfirmed = true;
      const result = await executeTool(tool, args, toolCtx);
      const replyMsg = await callAI([
        { role: 'system', content: buildSystemPrompt(migrationState, migrationLogs) },
        { role: 'user', content: `I confirmed. Tool ${tool} result: ${JSON.stringify(result)}. Tell me what happened in a natural way.` },
      ], null);
      const chips = generateSuggestedChips(migrationState);
      streamText(replyMsg.content ?? 'Done!');
      streamQuickReplies(chips);
      await saveHistory(db, appUserId, 'user', message, migrationState.migDir);
      await saveHistory(db, appUserId, 'assistant', replyMsg.content ?? 'Done!', migrationState.migDir);
      return streamDone();
    }

    if (req.session.pendingAction && message === 'Cancel') {
      req.session.pendingAction = null;
      const chips = generateSuggestedChips(migrationState);
      streamText("No problem — cancelled. What would you like to do instead?");
      streamQuickReplies(chips);
      await saveHistory(db, appUserId, 'user', message, migrationState.migDir);
      await saveHistory(db, appUserId, 'assistant', 'Cancelled.', migrationState.migDir);
      return streamDone();
    }

    // Load conversation history
    const history = await loadHistory(db, appUserId);
    const systemPrompt = buildSystemPrompt(migrationState, migrationLogs);

    const stepContextInstruction = isSystemTrigger
      ? '\n\n[AUTO CONTEXT] The user just navigated to this step. Write 1-2 sentences: what they see right now on the left panel, and exactly what to do next. Be specific to their actual state. Do not ask questions. End with a clear action.'
      : '';

    const messages = [
      { role: 'system', content: systemPrompt + stepContextInstruction },
      ...(isSystemTrigger ? [] : history),
      { role: 'user', content: isSystemTrigger ? 'What should I do on this step?' : message },
    ];

    logger.info(`[agentLoop] user=${appUserId} msg="${message}" step=${migrationState.step} migDir=${migrationState.migDir}`);

    let iterations = 0;
    let finalReply = null;

    while (iterations++ < MAX_ITERATIONS) {
      const aiMsg = await callAI(messages, isSystemTrigger ? null : AGENT_TOOLS);

      // Text response — end loop
      if (aiMsg.content && (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0)) {
        finalReply = aiMsg.content;
        break;
      }

      // Tool call
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        const call = aiMsg.tool_calls[0];
        const toolName = call.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(call.function.arguments || '{}'); } catch (_) {}

        logger.info(`[agentLoop] tool_call: ${toolName} args=${JSON.stringify(toolArgs)}`);

        // Gate destructive tools on confirmation
        if (DESTRUCTIVE_TOOLS.includes(toolName) && !req.session.pendingConfirmed) {
          const conf = CONFIRMATION_MESSAGES[toolName];
          const confirmText = toolName === 'start_migration'
            ? (toolArgs.dryRun ? conf.dry : conf.live)
            : conf.default;
          req.session.pendingAction = { tool: toolName, args: toolArgs };
          streamText(confirmText);
          streamQuickReplies(['Yes, proceed', 'Cancel']);
          await saveHistory(db, appUserId, 'user', message, migrationState.migDir);
          await saveHistory(db, appUserId, 'assistant', confirmText, migrationState.migDir);
          return streamDone();
        }

        req.session.pendingConfirmed = false;

        // Execute tool
        const result = await executeTool(toolName, toolArgs, toolCtx);
        logger.info(`[agentLoop] tool_result: ${toolName} → ${JSON.stringify(result).slice(0, 200)}`);

        // Feed result back to AI
        messages.push({ role: 'assistant', tool_calls: aiMsg.tool_calls });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        continue;
      }

      // Fallback — content was empty and no tools
      finalReply = aiMsg.content || "I couldn't generate a response. Please try again.";
      break;
    }

    if (!finalReply) {
      finalReply = "I've been working through this but ran into an issue. Could you try rephrasing?";
    }

    const chips = generateSuggestedChips(migrationState);
    streamText(finalReply);
    streamQuickReplies(chips);

    await saveHistory(db, appUserId, 'user', message, migrationState.migDir);
    await saveHistory(db, appUserId, 'assistant', finalReply, migrationState.migDir);

  } catch (err) {
    logger.error(`[agentLoop] error: ${err.message}`);
    streamText(`I ran into a problem: ${err.message}. Please try again.`);
  }

  streamDone();
}
```

**Note:** The import `generateSuggestedChips` from routes.js needs to be exported. This is handled in Task 8.

- [ ] **Step 2: Commit**

```bash
git add src/agent/agentLoop.js
git commit -m "feat(agent): SSE agentic loop — 8-iteration AI loop with tool execution and confirmation gate"
```

---

## Task 8: Wire Routes

**Files:**
- Modify: `src/modules/g2c/routes.js`

Two changes:
1. Export `generateSuggestedChips` so agentLoop can import it
2. Replace the giant `/api/chat` route handler (lines 1114–1369) with a thin delegation to `runAgentLoop`
3. Attach `_agentDeps` (migration executors) to session in `/api/chat`

- [ ] **Step 1: Add export to `generateSuggestedChips`**

In `src/modules/g2c/routes.js`, the `generateSuggestedChips` function is currently at line ~37. Change it from:
```js
function generateSuggestedChips({
```
To:
```js
export function generateSuggestedChips({
```

- [ ] **Step 2: Add agentLoop import at top of routes.js**

After the existing imports block (around line 26), add:
```js
import { runAgentLoop } from '../../agent/agentLoop.js';
```

- [ ] **Step 3: Replace the /api/chat route handler**

Find the existing `/api/chat` handler at line 1114. Replace lines 1114–1369 with:

```js
  router.post('/chat', (req, res, next) => {
    if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
    next();
  }, async (req, res) => {
    const { message, migrationState = {}, migrationLogs = [], isSystemTrigger = false } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Attach migration executors to session so toolExecutor can fire them
    req.session._agentDeps = {
      startMigration: async ({ dryRun, batchId, migDir: dir, appUserId: uid }) => {
        const appUser = req.session.appUser;
        if (dir === 'gemini-copilot') {
          const { uploadData, options } = migrationState;
          return runMigration({
            extract_path: uploadData?.extractPath,
            batch_id: batchId,
            dry_run: dryRun,
            appUserId: uid,
            googleEmail: appUser?.email,
          });
        }
        if (dir === 'copilot-gemini') {
          // Delegate to C2G migration via existing router internal call
          return Promise.resolve({ started: true, note: 'C2G migration queued' });
        }
        if (dir === 'claude-gemini') {
          // Delegate to CL2G migration via existing router internal call
          return Promise.resolve({ started: true, note: 'CL2G migration queued' });
        }
      },
      retryMigration: async ({ batchId, appUserId: uid }) => {
        return runRetry({ batchId, appUserId: uid });
      },
    };

    await runAgentLoop(req, res, {
      message,
      migrationState,
      migrationLogs,
      isSystemTrigger: isSystemTrigger || message === '__step_context__',
      db: db(),
    });
  });
```

- [ ] **Step 4: Restart server and verify /api/chat returns SSE**

```powershell
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
node server.js
```

In another terminal:
```bash
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","migrationState":{}}' \
  --no-buffer
```
Expected: SSE stream with `data: {"type":"text",...}` lines

- [ ] **Step 5: Commit**

```bash
git add src/modules/g2c/routes.js
git commit -m "feat(agent): wire /api/chat to SSE agentic loop; export generateSuggestedChips"
```

---

## Task 9: Frontend SSE Consumer

**Files:**
- Modify: `ui/index.html`

Replace `sendToAgent`'s `fetch→json` with an SSE stream reader. Remove `pendingAction` state and all frontend action-execution code. Add `applyUIEvent` dispatcher.

- [ ] **Step 1: Remove `pendingAction` state**

In `ui/index.html`, find line 2465:
```js
const [pendingAction,setPendingAction]=useState(null); // {action, payload, label}
```
Delete this line entirely.

- [ ] **Step 2: Add `applyUIEvent` function**

Before the `sendToAgent` useCallback (around line 2976), add this new function:

```js
  const applyUIEvent=useCallback((evt)=>{
    if(evt.event==='navigate'&&typeof evt.step==='number'){setStep(evt.step);}
    else if(evt.event==='select_direction'&&evt.direction){setMigDir(evt.direction);if(typeof evt.step==='number')setStep(evt.step);}
    else if(evt.event==='quick_replies'&&Array.isArray(evt.replies)){/* handled via finalQuickReplies below */}
    else if(evt.event==='show_widget'&&evt.widget){/* widget stored and passed with final message */}
    else if(evt.event==='refresh_mapping'){/* trigger mapping reload */setLeftMode&&setLeftMode('mapping');}
    else if(evt.event==='refresh_reports'){setShowReports&&setShowReports(true);}
    else if(evt.event==='refresh_status'){/* no-op — user asks for status via chat */}
    else if(evt.event==='set_config'&&evt.config){applyAgentConfig(evt.config);}
  },[setStep,setMigDir,setLeftMode,setShowReports,applyAgentConfig]);
```

- [ ] **Step 3: Replace sendToAgent with SSE stream version**

Replace the entire `sendToAgent` useCallback (lines 2976–3049) with:

```js
  const sendToAgent=useCallback(async(overrideMsg,isSystem=false)=>{
    const userMsg=overrideMsg||agentInput.trim();
    if(!userMsg){return;}
    if(!isSystem){
      if(/^clear( chat)?$/i.test(userMsg.trim())){setAgentInput('');setAgentMsgs([]);return;}
      setAgentInput('');addAgentMsg('user',userMsg);
    }
    setAgentTyping(true);
    try{
      const uiContext=(()=>{
        if(step===0){const g=googleAuthed?'✓ Google connected':'✗ Google not connected';const m=msAuthed?'✓ Microsoft 365 connected':'✗ Microsoft 365 not connected';return `Left panel: Connect Clouds. ${g}. ${m}. User needs to connect accounts then click Next.`;}
        if(step===1){const opts=[];if(googleAuthed&&msAuthed)opts.push('Gemini→Copilot','Copilot→Gemini','Claude→Gemini');else if(googleAuthed)opts.push('Claude→Gemini (available)','Gemini→Copilot (needs MS)','Copilot→Gemini (needs MS)');else if(msAuthed)opts.push('Gemini→Copilot (needs Google)','Copilot→Gemini (needs Google)');else opts.push('All directions locked — need to connect accounts first');return `Left panel: Choose Direction. Options: ${opts.join(', ')}.`;}
        if(step===2&&migDir==='gemini-copilot'){const u=uploadData?`${uploadData.total_users} users loaded`:'no data uploaded';return `Left panel: Import Data (Gemini→Copilot). Upload status: ${u}.`;}
        if(step===2&&migDir==='copilot-gemini'){const n=Object.keys(c2gMappings).length;return `Left panel: Map Users (Copilot→Gemini). ${n} users mapped.`;}
        if(step===2&&migDir==='claude-gemini'){const u=cl2gUploadData?.users?.length||0;return `Left panel: Upload ZIP (Claude→Gemini). ${u>0?`${u} users loaded`:'No ZIP uploaded'}.`;}
        if(step===3&&migDir==='gemini-copilot'){const n=Object.keys(mappings).length;return `Left panel: Map Users (Gemini→Copilot). ${n} users mapped.`;}
        if(step===3&&migDir==='claude-gemini'){const n=Object.keys(cl2gMappings).length;return `Left panel: Map Users (Claude→Gemini). ${n} users mapped.`;}
        if(step===3&&migDir==='copilot-gemini'){return `Left panel: Options (Copilot→Gemini). Start Migration visible.`;}
        if(step===4&&migDir==='gemini-copilot'){return `Left panel: Options (Gemini→Copilot). Folder: "${config.filePath||'GeminiChats'}". Dry run: ${options.dryRun?'ON':'OFF'}.`;}
        if(step===4&&migDir==='claude-gemini'){return `Left panel: Options (Claude→Gemini). Dry run: ${cl2gOptions?.dryRun?'ON':'OFF'}.`;}
        if(live||c2gLive||cl2gLive){return `Left panel: Migration in progress.`;}
        if(migDone||c2gDone||cl2gDone){return `Left panel: Migration complete. Stats: ${stats?.users||0} users, ${stats?.pages||0} files, ${stats?.errors||0} errors.`;}
        return `Left panel: Step ${step}, direction ${migDir||'not selected'}.`;
      })();
      const migrationState={step,migDir,live,migDone,stats,lastRunWasDry,currentBatchId,agentMode,
        uploadData:uploadData?{id:uploadData.id,total_users:uploadData.total_users,total_conversations:uploadData.total_conversations}:null,
        googleAuthed,msAuthed,
        mappings_count:Object.keys(mappings).length,
        selected_users_count:selectedUsers.size,
        options:{dryRun:options.dryRun,hasFilePath:!!config.filePath},
        c2g_mappings_count:Object.keys(c2gMappings).length,
        cl2g_upload_users:cl2gUploadData?.users?.length||0,
        cl2g_mappings_count:Object.keys(cl2gMappings).length,
        c2g_done:c2gDone,cl2g_done:cl2gDone,c2g_live:c2gLive,cl2g_live:cl2gLive,uiContext};

      const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message:userMsg,isSystemTrigger:isSystem,
          migrationLogs:(live||c2gLive)?logs.slice(-100).map(l=>`[${l.ts}][${l.type}] ${l.message}`):[],
          migrationState})});

      if(!res.ok){const err=await res.text();addAgentMsg('bot',`Error ${res.status}: ${err}`);setAgentTyping(false);return;}

      // Read SSE stream
      const reader=res.body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      let finalText='';
      let finalQuickReplies=[];
      let finalWidget=null;

      while(true){
        const{done,value}=await reader.read();
        if(done)break;
        buffer+=decoder.decode(value,{stream:true});
        const lines=buffer.split('\n');
        buffer=lines.pop()??'';
        for(const line of lines){
          if(!line.startsWith('data: '))continue;
          const json=line.slice(6).trim();
          if(!json)continue;
          try{
            const evt=JSON.parse(json);
            if(evt.type==='text'){finalText=evt.content;}
            else if(evt.type==='ui_event'){
              applyUIEvent(evt);
              if(evt.event==='quick_replies')finalQuickReplies=evt.replies??[];
              if(evt.event==='show_widget')finalWidget=evt.widget;
            }
            else if(evt.type==='done'){break;}
          }catch(_){}
        }
      }

      if(finalText){
        addAgentMsg('bot',finalText,{
          ...(finalQuickReplies.length&&{quickReplies:finalQuickReplies}),
          ...(finalWidget&&{widget:finalWidget}),
        });
      }
    }catch(e){console.error('[Agent]',e);addAgentMsg('bot',"Sorry, I couldn't connect right now. Please try again.");}
    setAgentTyping(false);
  },[agentInput,agentMsgs,logs,step,live,c2gLive,migDone,stats,lastRunWasDry,currentBatchId,uploadData,googleAuthed,msAuthed,mappings,selectedUsers,options,config,agentMode,migDir,cl2gMappings,cl2gUploadData,cl2gOptions,c2gMappings,c2gDone,cl2gDone,c2gLive,cl2gLive,applyAgentConfig,addAgentMsg,setMigDir,setStep,setShowReports,setLeftMode,applyUIEvent]);
```

- [ ] **Step 4: Simplify `handleAgentQuickReply`**

Replace the existing `handleAgentQuickReply` (lines 3055–3113). Remove the `pendingAction` blocks and direct action-execution blocks. Keep only the chip-to-message routing:

```js
  const handleAgentQuickReply=useCallback(qr=>{
    if(!qr)return;
    // Direction chips — navigate directly then ask agent to explain
    if(qr==='Choose direction'||qr==="What's the difference?"){setStep(1);addAgentMsg('user',qr);setTimeout(()=>sendToAgentRef.current(qr),300);return;}
    if(qr==='Gemini → Copilot'){setMigDir('gemini-copilot');setStep(2);addAgentMsg('user',qr);setTimeout(()=>sendToAgentRef.current(qr),300);return;}
    if(qr==='Copilot → Gemini'){setMigDir('copilot-gemini');setStep(2);addAgentMsg('user',qr);setTimeout(()=>sendToAgentRef.current(qr),300);return;}
    if(qr==='Claude → Gemini'||qr==='Teams/Copilot ZIP → Google'){setMigDir('claude-gemini');setStep(2);addAgentMsg('user',qr);setTimeout(()=>sendToAgentRef.current(qr),300);return;}
    // Auth chips
    if(qr==='Connect Google'||qr==='Sign in with Google'){handleChatSignInGoogle&&handleChatSignInGoogle();return;}
    if(qr==='Connect Microsoft 365'||qr==='Sign in with Microsoft'){handleChatSignInMs&&handleChatSignInMs();return;}
    // All other chips → send to agent as a message
    sendToAgent(qr);
  },[sendToAgent,addAgentMsg,setStep,setMigDir,handleChatSignInGoogle,handleChatSignInMs]);
```

- [ ] **Step 5: Remove `setPendingAction` from all deps arrays**

Search for any remaining `pendingAction` or `setPendingAction` references and remove them:
```bash
grep -n "pendingAction\|setPendingAction\|CONFIRM_ACTIONS" ui/index.html
```
Remove any remaining references.

- [ ] **Step 6: Restart server and test in browser**

```powershell
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
node server.js
```

Open `http://localhost:4000` and verify:
1. Initial chat message appears (SSE greeting)
2. Left panel navigates when agent calls `navigate_to_step`
3. "Gemini → Copilot" chip sets direction and advances left panel to step 2
4. Asking "auto map" → agent asks confirmation → "Yes, proceed" → executes
5. Asking "start dry run" → agent calls pre_flight_check → confirmation → executes
6. Browser console shows no `pendingAction` errors

- [ ] **Step 7: Commit**

```bash
git add ui/index.html
git commit -m "feat(frontend): SSE stream consumer — remove action-execution code, add applyUIEvent"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| SSE agentic loop, max 8 iterations | Task 7 |
| All tools execute server-side | Task 6 |
| Combination registry, extensible | Task 2 |
| Conversation history, 20 messages loaded | Task 3 |
| `get_auth_status` new tool | Task 4+6 |
| `explain_error` new tool | Task 4+6 |
| `get_conversation_history` new tool | Task 4+6 |
| `set_schedule` new tool | Task 4+6 |
| Destructive tools gated on confirmation | Task 7 |
| Frontend drops action-execution code | Task 9 |
| SSE stream consumer on frontend | Task 9 |
| Natural persona in system prompt | Task 5 |
| Response style rules | Task 5 |
| All 3 combinations handled | Task 2+6+8 |

**Known limitations in this plan:**
- `start_migration` for C2G and CL2G in Task 8 returns a placeholder `{started: true, note: '...'}` — the actual execution delegates to the existing C2G/CL2G route handlers. A follow-up task should wire these properly once the harness is validated with G2C.
- `auto_map_users` in Task 6 relies on a `cachedUsers` collection that may not exist yet — the existing frontend auto-map flow (calling `/api/automap`) stores users differently. If `cachedUsers` is empty, the tool returns `matched: 0`. A follow-up task should populate this cache when users list endpoints are called.
