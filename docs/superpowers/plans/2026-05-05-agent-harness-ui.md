# Agent Harness Monitor UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone developer/admin UI at `agent-ui/` that visualises every agent session in real-time — tool calls, LLM messages, SSE events, migration state — completely separate from the migration tool.

**Architecture:** Single-page vanilla HTML + JS app served by a tiny Express server (`agent-ui/server.js`) on port 4001. It connects to GEM CO's existing `/api/chat` SSE endpoint on port 4000 using the same session cookie (proxy passthrough). All agent activity is intercepted server-side via an audit middleware injected into GEM CO's chat route — it writes structured events to a MongoDB `agentAuditLog` collection. The UI polls / subscribes to a new `/audit/stream` SSE endpoint on port 4001 to display live sessions.

**Tech Stack:** Node.js + Express (port 4001), vanilla JS + CSS (no framework), MongoDB (`agentAuditLog` collection), SSE for live feed, existing GEM CO session cookie for auth passthrough.

---

## File Structure

```
agent-ui/                          ← entire feature lives here, no files outside
  server.js                        ← Express server on port 4001, proxy + audit SSE
  public/
    index.html                     ← single HTML file, all UI
    style.css                      ← clean dark dashboard styles
    app.js                         ← vanilla JS: session list, live trace, tool inspector
  README.md                        ← how to run + what each panel does

GEM_CO/src/agent/
  auditLogger.js                   ← NEW: writes structured audit events to MongoDB
  agentLoop.js                     ← MODIFY: call auditLogger at key points (tool call, response, error)

GEM_CO/src/db/mongo.js             ← MODIFY: add agentAuditLog collection + index
GEM_CO/server.js                   ← MODIFY: expose /audit/* routes
```

---

## Task 1: Create `agent-ui/` folder and Express server skeleton

**Files:**
- Create: `agent-ui/server.js`
- Create: `agent-ui/package.json`

- [ ] **Step 1: Create `agent-ui/package.json`**

```json
{
  "name": "agent-harness-ui",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "http-proxy-middleware": "^3.0.0"
  }
}
```

- [ ] **Step 2: Run `npm install` inside `agent-ui/`**

```bash
cd agent-ui && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create `agent-ui/server.js`**

```js
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 4001;
const GEM_ORIGIN = process.env.GEM_ORIGIN || 'http://localhost:4000';

// Serve UI static files
app.use(express.static(path.join(__dirname, 'public')));

// Proxy all /api/* and /auth/* to GEM CO on port 4000
// This forwards the session cookie automatically so auth works
app.use(['/api', '/auth'], createProxyMiddleware({
  target: GEM_ORIGIN,
  changeOrigin: false,
  on: {
    error: (err, req, res) => {
      res.status(502).json({ error: 'GEM CO unreachable', detail: err.message });
    }
  }
}));

app.listen(PORT, () => {
  console.log(`Agent Harness UI running at http://localhost:${PORT}`);
  console.log(`Proxying API calls to GEM CO at ${GEM_ORIGIN}`);
});
```

- [ ] **Step 4: Create `agent-ui/public/` directory and empty placeholder files**

```bash
mkdir -p agent-ui/public
touch agent-ui/public/index.html agent-ui/public/style.css agent-ui/public/app.js
```

- [ ] **Step 5: Start the server and verify it starts**

```bash
cd agent-ui && node server.js
```

Expected output:
```
Agent Harness UI running at http://localhost:4001
Proxying API calls to GEM CO at http://localhost:4000
```

- [ ] **Step 6: Commit**

```bash
git add agent-ui/
git commit -m "feat(agent-ui): scaffold Express server on port 4001 with GEM CO proxy"
```

---

## Task 2: Add `auditLogger.js` to GEM CO — write events to MongoDB

**Files:**
- Create: `src/agent/auditLogger.js`
- Modify: `src/db/mongo.js` (add collection)

- [ ] **Step 1: Create `src/agent/auditLogger.js`**

```js
// src/agent/auditLogger.js
import { getDb } from '../db/mongo.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:audit');

/**
 * Write a structured audit event to MongoDB.
 * Called from agentLoop at: session start, each tool call, each tool result,
 * each LLM response, confirmation gates, errors, session end.
 *
 * @param {string} sessionId  - unique per chat request (batchId or timestamp)
 * @param {string} type       - 'session_start'|'llm_call'|'tool_call'|'tool_result'|'llm_response'|'confirmation'|'error'|'session_end'
 * @param {object} payload    - event-specific data
 */
export async function auditLog(sessionId, type, payload = {}) {
  try {
    const db = getDb();
    await db.collection('agentAuditLog').insertOne({
      sessionId,
      type,
      ts: new Date(),
      ...payload,
    });
  } catch (e) {
    // Never crash the agent loop due to audit failure
    logger.warn(`auditLog failed: ${e.message}`);
  }
}
```

- [ ] **Step 2: Add `agentAuditLog` collection to `src/db/mongo.js`**

Find the last collection block (collection 13 `chatHistory`) and add after it:

```js
// 14. agentAuditLog — structured per-session agent trace
if (!existing.has('agentAuditLog')) await _db.createCollection('agentAuditLog');
await _db.collection('agentAuditLog').createIndex({ sessionId: 1, ts: 1 });
await _db.collection('agentAuditLog').createIndex({ ts: -1 }); // for listing recent sessions
```

Also update the log message at the bottom from `'All 15 collections'` to `'All 16 collections'`.

- [ ] **Step 3: Verify server starts without error after these changes**

Restart GEM CO (`node server.js`) and check logs — should see `All 16 collections verified`.

- [ ] **Step 4: Commit**

```bash
git add src/agent/auditLogger.js src/db/mongo.js
git commit -m "feat(agent-ui): add auditLogger and agentAuditLog MongoDB collection"
```

---

## Task 3: Instrument `agentLoop.js` — emit audit events at every key point

**Files:**
- Modify: `src/agent/agentLoop.js`

- [ ] **Step 1: Import `auditLog` at the top of `agentLoop.js`**

```js
import { auditLog } from './auditLogger.js';
```

- [ ] **Step 2: Generate a `sessionId` at the start of `runAgentLoop`**

After the `const appUserId = ...` line, add:

```js
const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

- [ ] **Step 3: Emit `session_start` event**

After `const history = await loadHistory(...)`, add:

```js
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
```

- [ ] **Step 4: Emit `tool_call` event before `executeTool`**

Replace the existing `logger.info` line before `executeTool`:

```js
logger.info(`[agentLoop] iteration=${iterations} tool_call=${toolName}`);
await auditLog(sessionId, 'tool_call', {
  appUserId,
  iteration: iterations,
  toolName,
  toolArgs,
});
```

- [ ] **Step 5: Emit `tool_result` event after `executeTool`**

After `const result = await executeTool(...)`:

```js
logger.info(`[agentLoop] tool_result=${toolName} → ${JSON.stringify(result).slice(0, 200)}`);
await auditLog(sessionId, 'tool_result', {
  appUserId,
  toolName,
  result,
  durationMs: null, // placeholder — add timing later if needed
});
```

- [ ] **Step 6: Emit `llm_response` event when agent produces final text**

After `finalReply = aiMsg.content`:

```js
await auditLog(sessionId, 'llm_response', {
  appUserId,
  iteration: iterations,
  content: finalReply?.slice(0, 500),
  toolCalls: aiMsg.tool_calls?.map(t => t.function?.name) ?? [],
});
```

- [ ] **Step 7: Emit `confirmation_gate` when destructive tool is gated**

After `req.session.pendingAction = { tool: toolName, args: toolArgs }`:

```js
await auditLog(sessionId, 'confirmation_gate', {
  appUserId,
  toolName,
  toolArgs,
  confirmText: confirmText.slice(0, 200),
});
```

- [ ] **Step 8: Emit `error` and `session_end` events**

In the `catch` block:

```js
await auditLog(sessionId, 'error', { appUserId, error: err.message });
```

After `streamDone()`:

```js
await auditLog(sessionId, 'session_end', {
  appUserId,
  finalReplyLength: finalReply?.length ?? 0,
  toolCallCount: iterations - 1,
});
```

- [ ] **Step 9: Restart GEM CO, open http://localhost:4000, send a chat message, then check MongoDB**

In a mongo shell or Compass:
```js
db.agentAuditLog.find().sort({ts:-1}).limit(20)
```
Expected: see `session_start`, `tool_call`, `tool_result`, `llm_response`, `session_end` documents.

- [ ] **Step 10: Commit**

```bash
git add src/agent/agentLoop.js
git commit -m "feat(agent-ui): instrument agentLoop with structured audit events"
```

---

## Task 4: Add `/audit/*` API routes to GEM CO server

**Files:**
- Modify: `src/modules/g2c/routes.js` (add audit routes)
- Modify: `GEM_CO/server.js` (mount audit routes)

- [ ] **Step 1: Add audit routes at the bottom of `src/modules/g2c/routes.js`, before `return router`**

```js
// ── Audit API (for agent-ui) ────────────────────────────────────────────────

// GET /audit/sessions — list recent unique sessions (last 100)
router.get('/audit/sessions', async (req, res) => {
  try {
    const sessions = await db().collection('agentAuditLog').aggregate([
      { $sort: { ts: -1 } },
      { $group: {
        _id: '$sessionId',
        firstEvent: { $last: '$type' },
        lastEvent: { $first: '$type' },
        startTs: { $last: '$ts' },
        endTs: { $first: '$ts' },
        appUserId: { $first: '$appUserId' },
        migDir: { $first: '$migDir' },
        step: { $first: '$step' },
        eventCount: { $sum: 1 },
      }},
      { $sort: { startTs: -1 } },
      { $limit: 100 },
    ]).toArray();
    res.json({ sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /audit/session/:sessionId — all events for one session
router.get('/audit/session/:sessionId', async (req, res) => {
  try {
    const events = await db().collection('agentAuditLog')
      .find({ sessionId: req.params.sessionId })
      .sort({ ts: 1 })
      .toArray();
    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /audit/stream — SSE feed of new audit events (live tail)
router.get('/audit/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { auditEmitter } = req.app.locals;
  if (!auditEmitter) { res.write('data: {"error":"no emitter"}\n\n'); return res.end(); }

  const handler = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  auditEmitter.on('event', handler);
  req.on('close', () => auditEmitter.off('event', handler));
});
```

- [ ] **Step 2: Add `EventEmitter` to `auditLogger.js` so live stream works**

Replace entire `auditLogger.js` with:

```js
import { getDb } from '../db/mongo.js';
import { getLogger } from '../utils/logger.js';
import { EventEmitter } from 'events';

const logger = getLogger('agent:audit');
export const auditEmitter = new EventEmitter();
auditEmitter.setMaxListeners(50);

export async function auditLog(sessionId, type, payload = {}) {
  const event = { sessionId, type, ts: new Date(), ...payload };
  try {
    const db = getDb();
    await db.collection('agentAuditLog').insertOne(event);
    auditEmitter.emit('event', event);
  } catch (e) {
    logger.warn(`auditLog failed: ${e.message}`);
  }
}
```

- [ ] **Step 3: Attach `auditEmitter` to Express app in `GEM_CO/server.js`**

Find where `app` is created (near top of server.js) and after it, add:

```js
import { auditEmitter } from './src/agent/auditLogger.js';
// ... (add this after app is created)
app.locals.auditEmitter = auditEmitter;
```

- [ ] **Step 4: Verify routes work**

With GEM CO running, open browser:
- `http://localhost:4000/audit/sessions` — should return `{ sessions: [] }` (empty at first)
- Send a chat message, then reload — should show 1 session with events

- [ ] **Step 5: Commit**

```bash
git add src/modules/g2c/routes.js src/agent/auditLogger.js server.js
git commit -m "feat(agent-ui): add /audit/sessions, /audit/session/:id, /audit/stream SSE routes"
```

---

## Task 5: Build the UI HTML shell + CSS

**Files:**
- Create: `agent-ui/public/index.html`
- Create: `agent-ui/public/style.css`

- [ ] **Step 1: Create `agent-ui/public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GEM Agent Harness Monitor</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <!-- Header -->
    <header>
      <div class="header-left">
        <span class="logo">⚡ Agent Harness Monitor</span>
        <span id="connection-status" class="badge badge-gray">Connecting...</span>
      </div>
      <div class="header-right">
        <span id="session-count" class="stat-badge">0 sessions</span>
        <button id="btn-clear-filter" class="btn-ghost" style="display:none">Clear filter</button>
      </div>
    </header>

    <!-- Main layout: 3 columns -->
    <div class="layout">

      <!-- LEFT: Session list -->
      <aside id="session-list-panel">
        <div class="panel-header">
          <h2>Sessions</h2>
          <button id="btn-refresh" class="btn-icon" title="Refresh">↺</button>
        </div>
        <div id="session-list">
          <div class="empty-state">No sessions yet. Send a chat message in GEM CO.</div>
        </div>
      </aside>

      <!-- MIDDLE: Event trace for selected session -->
      <main id="trace-panel">
        <div class="panel-header">
          <h2 id="trace-title">Select a session</h2>
          <span id="trace-meta" class="meta-text"></span>
        </div>
        <div id="trace-events">
          <div class="empty-state">Click a session on the left to see its full trace.</div>
        </div>
      </main>

      <!-- RIGHT: Detail inspector for selected event -->
      <aside id="detail-panel">
        <div class="panel-header">
          <h2>Event Detail</h2>
        </div>
        <div id="detail-content">
          <div class="empty-state">Click any event in the trace to inspect it.</div>
        </div>
      </aside>

    </div>

    <!-- Bottom: Live feed bar -->
    <div id="live-feed-bar">
      <span class="live-dot"></span>
      <span id="live-feed-text">Waiting for live events...</span>
    </div>
  </div>

  <script src="app.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create `agent-ui/public/style.css`**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --surface2: #222636;
  --border: #2e3348;
  --text: #e2e8f0;
  --muted: #8892a4;
  --accent: #6366f1;
  --green: #22c55e;
  --yellow: #eab308;
  --red: #ef4444;
  --blue: #3b82f6;
  --purple: #a855f7;
  --orange: #f97316;
}

body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 13px; height: 100vh; overflow: hidden; }

header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border);
  height: 48px; flex-shrink: 0;
}
.logo { font-weight: 700; font-size: 15px; color: var(--text); }
.header-left, .header-right { display: flex; align-items: center; gap: 10px; }

#app { display: flex; flex-direction: column; height: 100vh; }
.layout { display: grid; grid-template-columns: 260px 1fr 300px; flex: 1; overflow: hidden; }

aside, main { border-right: 1px solid var(--border); overflow: hidden; display: flex; flex-direction: column; }
aside:last-child { border-right: none; }

.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  background: var(--surface); flex-shrink: 0;
}
.panel-header h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }

#session-list, #trace-events, #detail-content { overflow-y: auto; flex: 1; }

/* Session list items */
.session-item {
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  cursor: pointer; transition: background 0.1s;
}
.session-item:hover { background: var(--surface2); }
.session-item.active { background: var(--surface2); border-left: 3px solid var(--accent); }
.session-id { font-family: monospace; font-size: 11px; color: var(--muted); }
.session-meta { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.session-user { font-size: 12px; font-weight: 500; }
.session-time { font-size: 11px; color: var(--muted); }

/* Event trace */
.trace-event {
  display: flex; gap: 10px; padding: 8px 14px;
  border-bottom: 1px solid var(--border); cursor: pointer;
  transition: background 0.1s; align-items: flex-start;
}
.trace-event:hover { background: var(--surface2); }
.trace-event.active { background: var(--surface2); }
.event-icon { width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; margin-top: 1px; }
.event-body { flex: 1; min-width: 0; }
.event-type { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.event-summary { font-size: 12px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.event-time { font-size: 10px; color: var(--muted); flex-shrink: 0; margin-top: 4px; }

/* Event type colors */
.type-session_start .event-icon { background: #1e3a5f; color: var(--blue); }
.type-session_end   .event-icon { background: #1a3a2a; color: var(--green); }
.type-tool_call     .event-icon { background: #2d1f4e; color: var(--purple); }
.type-tool_result   .event-icon { background: #1e2d4e; color: var(--accent); }
.type-llm_response  .event-icon { background: #1a3530; color: #14b8a6; }
.type-confirmation_gate .event-icon { background: #3d2e0a; color: var(--yellow); }
.type-error         .event-icon { background: #3d1a1a; color: var(--red); }

/* Badges */
.badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
.badge-gray   { background: var(--surface2); color: var(--muted); }
.badge-green  { background: #14532d; color: var(--green); }
.badge-red    { background: #3d1a1a; color: var(--red); }
.badge-blue   { background: #1e3a5f; color: var(--blue); }
.stat-badge   { font-size: 11px; color: var(--muted); }

/* Direction badges */
.dir-badge { padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; background: var(--surface2); color: var(--accent); }

/* Detail panel */
.detail-section { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.detail-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; }
.detail-value { font-size: 12px; color: var(--text); }
pre.json-block {
  background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; font-size: 11px; font-family: monospace; overflow-x: auto;
  white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto;
  color: #a5f3fc;
}

/* Live feed bar */
#live-feed-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 16px; background: var(--surface); border-top: 1px solid var(--border);
  height: 32px; flex-shrink: 0; font-size: 11px; color: var(--muted);
}
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
.live-dot.active { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{ opacity:1; } 50%{ opacity:0.4; } }

/* Misc */
.empty-state { padding: 24px 14px; color: var(--muted); text-align: center; font-size: 12px; }
.meta-text { font-size: 11px; color: var(--muted); }
.btn-icon { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; cursor: pointer; padding: 2px 6px; font-size: 13px; }
.btn-icon:hover { background: var(--surface2); color: var(--text); }
.btn-ghost { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; }
.btn-ghost:hover { color: var(--text); }

/* Tool call pill in summary */
.tool-pill { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #2d1f4e; color: var(--purple); font-size: 10px; font-weight: 600; font-family: monospace; }
.arg-row { display: flex; gap: 6px; margin-top: 4px; }
.arg-key { color: var(--muted); }
.arg-val { color: var(--text); font-family: monospace; }
```

- [ ] **Step 3: Start agent-ui server and open browser**

```bash
cd agent-ui && node server.js
```

Open `http://localhost:4001` — should see the dark 3-panel dashboard with empty states.

- [ ] **Step 4: Commit**

```bash
git add agent-ui/public/index.html agent-ui/public/style.css
git commit -m "feat(agent-ui): HTML shell and dark dashboard CSS"
```

---

## Task 6: Build `app.js` — session list, trace view, detail inspector, live SSE

**Files:**
- Create: `agent-ui/public/app.js`

- [ ] **Step 1: Create `agent-ui/public/app.js`** — full implementation:

```js
// agent-ui/public/app.js

const EVENT_ICONS = {
  session_start:      '▶',
  session_end:        '✓',
  tool_call:          '⚙',
  tool_result:        '↩',
  llm_response:       '💬',
  confirmation_gate:  '⚠',
  error:              '✕',
};

const EVENT_SUMMARIES = {
  session_start:     e => `step=${e.step ?? '?'} dir=${e.migDir ?? 'none'} history=${e.historyLength ?? 0} msgs`,
  session_end:       e => `${e.toolCallCount ?? 0} tool calls · reply ${e.finalReplyLength ?? 0} chars`,
  tool_call:         e => `${e.toolName}(${formatArgs(e.toolArgs)})`,
  tool_result:       e => `${e.toolName} → ${resultSummary(e.result)}`,
  llm_response:      e => (e.content ?? '').slice(0, 80) + ((e.content?.length ?? 0) > 80 ? '…' : ''),
  confirmation_gate: e => `gating ${e.toolName} — waiting for user confirm`,
  error:             e => e.error ?? 'unknown error',
};

function formatArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
}

function resultSummary(result) {
  if (!result) return 'null';
  if (result.error) return `ERROR: ${result.error}`;
  const keys = Object.keys(result);
  if (keys.length === 0) return '{}';
  return keys.slice(0, 3).map(k => `${k}=${JSON.stringify(result[k])}`).join(', ');
}

function timeAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

// ── State ────────────────────────────────────────────────────────────────────
let sessions = [];
let selectedSessionId = null;
let selectedEventId = null;
let traceEvents = [];
let liveConnected = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const sessionList   = document.getElementById('session-list');
const tracePanel    = document.getElementById('trace-events');
const detailContent = document.getElementById('detail-content');
const traceTitle    = document.getElementById('trace-title');
const traceMeta     = document.getElementById('trace-meta');
const statusBadge   = document.getElementById('connection-status');
const sessionCount  = document.getElementById('session-count');
const liveDot       = document.querySelector('.live-dot');
const liveFeedText  = document.getElementById('live-feed-text');

// ── Session list ─────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const r = await fetch('/audit/sessions');
    const d = await r.json();
    sessions = d.sessions ?? [];
    renderSessionList();
    sessionCount.textContent = `${sessions.length} sessions`;
  } catch (e) {
    sessionList.innerHTML = `<div class="empty-state">Failed to load sessions: ${e.message}</div>`;
  }
}

function renderSessionList() {
  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="empty-state">No sessions yet. Send a chat message in GEM CO.</div>';
    return;
  }
  sessionList.innerHTML = sessions.map(s => `
    <div class="session-item ${s._id === selectedSessionId ? 'active' : ''}" data-id="${s._id}">
      <div class="session-user">${s.appUserId ?? 'unknown user'}</div>
      <div class="session-meta">
        ${s.migDir ? `<span class="dir-badge">${s.migDir}</span>` : ''}
        <span class="badge badge-gray">${s.eventCount} events</span>
        <span class="session-time">${timeAgo(s.startTs)}</span>
      </div>
      <div class="session-id">${s._id}</div>
    </div>
  `).join('');

  sessionList.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
}

// ── Trace view ───────────────────────────────────────────────────────────────
async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  selectedEventId = null;
  renderSessionList();
  tracePanel.innerHTML = '<div class="empty-state">Loading...</div>';
  detailContent.innerHTML = '<div class="empty-state">Click any event to inspect it.</div>';

  try {
    const r = await fetch(`/audit/session/${sessionId}`);
    const d = await r.json();
    traceEvents = d.events ?? [];
    renderTrace();

    const start = traceEvents.find(e => e.type === 'session_start');
    traceTitle.textContent = `Session trace`;
    traceMeta.textContent = `${traceEvents.length} events · ${start ? timeAgo(start.ts) : ''} · ${start?.migDir ?? 'no direction'} · step ${start?.step ?? '?'}`;
  } catch (e) {
    tracePanel.innerHTML = `<div class="empty-state">Failed to load: ${e.message}</div>`;
  }
}

function renderTrace() {
  if (traceEvents.length === 0) {
    tracePanel.innerHTML = '<div class="empty-state">No events for this session.</div>';
    return;
  }
  const startTs = new Date(traceEvents[0]?.ts).getTime();

  tracePanel.innerHTML = traceEvents.map((e, i) => {
    const relMs = new Date(e.ts).getTime() - startTs;
    const summary = (EVENT_SUMMARIES[e.type] ?? (() => ''))(e);
    return `
      <div class="trace-event type-${e.type} ${e._id?.toString() === selectedEventId ? 'active' : ''}" data-idx="${i}">
        <div class="event-icon">${EVENT_ICONS[e.type] ?? '•'}</div>
        <div class="event-body">
          <div class="event-type">${e.type}</div>
          <div class="event-summary">${summary}</div>
        </div>
        <div class="event-time">+${relMs}ms</div>
      </div>
    `;
  }).join('');

  tracePanel.querySelectorAll('.trace-event').forEach(el => {
    el.addEventListener('click', () => {
      const ev = traceEvents[parseInt(el.dataset.idx)];
      selectedEventId = ev._id?.toString();
      renderTrace();
      renderDetail(ev);
    });
  });
}

// ── Detail inspector ─────────────────────────────────────────────────────────
function renderDetail(ev) {
  const sections = [];

  sections.push(`
    <div class="detail-section">
      <div class="detail-label">Type</div>
      <div class="detail-value"><span class="tool-pill">${ev.type}</span></div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Timestamp</div>
      <div class="detail-value">${new Date(ev.ts).toLocaleString()}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">Session</div>
      <div class="detail-value" style="font-family:monospace;font-size:11px">${ev.sessionId}</div>
    </div>
  `);

  if (ev.type === 'tool_call') {
    sections.push(`
      <div class="detail-section">
        <div class="detail-label">Tool Called</div>
        <div class="detail-value"><span class="tool-pill">${ev.toolName}</span></div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Arguments</div>
        <pre class="json-block">${JSON.stringify(ev.toolArgs ?? {}, null, 2)}</pre>
      </div>
    `);
  }

  if (ev.type === 'tool_result') {
    const isError = ev.result?.error;
    sections.push(`
      <div class="detail-section">
        <div class="detail-label">Tool</div>
        <div class="detail-value"><span class="tool-pill">${ev.toolName}</span></div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Result ${isError ? '⚠ ERROR' : '✓ OK'}</div>
        <pre class="json-block">${JSON.stringify(ev.result ?? {}, null, 2)}</pre>
      </div>
    `);
  }

  if (ev.type === 'llm_response') {
    sections.push(`
      <div class="detail-section">
        <div class="detail-label">Response Text</div>
        <div class="detail-value" style="line-height:1.6;white-space:pre-wrap">${ev.content ?? ''}</div>
      </div>
      ${(ev.toolCalls?.length > 0) ? `
        <div class="detail-section">
          <div class="detail-label">Tool Calls Requested</div>
          <div class="detail-value">${ev.toolCalls.map(t => `<span class="tool-pill">${t}</span>`).join(' ')}</div>
        </div>` : ''}
    `);
  }

  if (ev.type === 'session_start') {
    sections.push(`
      <div class="detail-section">
        <div class="detail-label">User Message</div>
        <div class="detail-value" style="white-space:pre-wrap">${ev.message ?? ''}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Migration State</div>
        <pre class="json-block">${JSON.stringify({
          step: ev.step, migDir: ev.migDir,
          googleAuthed: ev.googleAuthed, msAuthed: ev.msAuthed,
          isSystemTrigger: ev.isSystemTrigger, historyLength: ev.historyLength,
        }, null, 2)}</pre>
      </div>
    `);
  }

  if (ev.type === 'error') {
    sections.push(`
      <div class="detail-section">
        <div class="detail-label">Error Message</div>
        <div class="detail-value" style="color:var(--red)">${ev.error ?? 'unknown'}</div>
      </div>
    `);
  }

  if (ev.type === 'confirmation_gate') {
    sections.push(`
      <div class="detail-section">
        <div class="detail-label">Gated Tool</div>
        <div class="detail-value"><span class="tool-pill">${ev.toolName}</span></div>
      </div>
      <div class="detail-section">
        <div class="detail-label">Args</div>
        <pre class="json-block">${JSON.stringify(ev.toolArgs ?? {}, null, 2)}</pre>
      </div>
      <div class="detail-section">
        <div class="detail-label">Confirm Message Shown to User</div>
        <div class="detail-value">${ev.confirmText ?? ''}</div>
      </div>
    `);
  }

  detailContent.innerHTML = sections.join('');
}

// ── Live SSE feed ─────────────────────────────────────────────────────────────
function connectLiveFeed() {
  const es = new EventSource('/audit/stream');

  es.onopen = () => {
    liveConnected = true;
    liveDot.classList.add('active');
    statusBadge.textContent = 'Live';
    statusBadge.className = 'badge badge-green';
    liveFeedText.textContent = 'Connected — watching for new agent activity...';
  };

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      liveFeedText.textContent = `${new Date().toLocaleTimeString()} · ${event.type} · session ${event.sessionId?.slice(-8)}`;

      // Auto-refresh session list on new session_start
      if (event.type === 'session_start') {
        loadSessions();
      }

      // If user is watching this session, append the event live
      if (event.sessionId === selectedSessionId) {
        traceEvents.push(event);
        renderTrace();
        traceMeta.textContent = `${traceEvents.length} events · live`;
      }
    } catch (_) {}
  };

  es.onerror = () => {
    liveConnected = false;
    liveDot.classList.remove('active');
    statusBadge.textContent = 'Disconnected';
    statusBadge.className = 'badge badge-red';
    liveFeedText.textContent = 'Disconnected — retrying...';
    setTimeout(connectLiveFeed, 3000);
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', loadSessions);

loadSessions();
connectLiveFeed();

// Auto-refresh session list every 30s
setInterval(loadSessions, 30000);
```

- [ ] **Step 2: Open http://localhost:4001 and send a chat message in GEM CO (http://localhost:4000)**

Expected:
- Left panel populates with the new session
- Clicking the session shows the full event trace (session_start → tool_call → tool_result → llm_response → session_end)
- Clicking any event shows full JSON in the right panel
- Live feed bar shows green dot and updates in real-time

- [ ] **Step 3: Commit**

```bash
git add agent-ui/public/app.js
git commit -m "feat(agent-ui): session list, trace view, event detail inspector, live SSE feed"
```

---

## Task 7: Add `agent-ui/README.md` and final wiring

**Files:**
- Create: `agent-ui/README.md`

- [ ] **Step 1: Create `agent-ui/README.md`**

```markdown
# Agent Harness Monitor UI

Standalone developer UI for inspecting GEM CO agent sessions in real-time.
Runs on port 4001. Completely separate from the migration tool.

## Start

```bash
# 1. GEM CO must be running first
cd ../  # GEM_CO root
node server.js

# 2. Start the monitor UI
cd agent-ui
npm install   # first time only
npm start
```

Open http://localhost:4001

## What you see

| Panel | What it shows |
|---|---|
| Left — Sessions | Every agent chat session, most recent first. Shows user, direction, step, event count. |
| Middle — Trace | All events in the selected session in order: session_start → tool calls → LLM response → session_end. Relative timing in ms. |
| Right — Detail | Full JSON for the selected event. For tool_call: args. For tool_result: full result. For llm_response: full text + what tools it requested. |
| Bottom bar | Live SSE connection indicator. Flashes when new events arrive. |

## Event types

| Icon | Type | What it means |
|---|---|---|
| ▶ | session_start | User sent a message. Shows migDir, step, auth state. |
| ⚙ | tool_call | Agent called a tool. Shows tool name + arguments. |
| ↩ | tool_result | Tool returned. Shows result or error. |
| 💬 | llm_response | LLM produced text (final or intermediate). |
| ⚠ | confirmation_gate | Destructive tool (start_migration, retry_failed) gated — waiting for user confirm. |
| ✕ | error | Agent loop threw an error. |
| ✓ | session_end | Session complete. Shows tool call count + reply length. |

## Port config

Set `GEM_ORIGIN` env var to change the target:
```bash
GEM_ORIGIN=http://localhost:4000 npm start
```
```

- [ ] **Step 2: Final end-to-end test**

1. Start GEM CO: `node server.js` (port 4000)
2. Start monitor: `cd agent-ui && npm start` (port 4001)
3. Open http://localhost:4001 — see green "Live" badge
4. Open http://localhost:4000 — log in, send "start a Google to Microsoft migration"
5. Back in monitor — left panel shows new session
6. Click session — trace shows: session_start → tool_call(select_direction) → tool_result → llm_response → session_end
7. Click tool_call event — right panel shows `{ toolName: "select_direction", toolArgs: { migDir: "gemini-copilot" } }`
8. Send another message — trace updates live without refresh

- [ ] **Step 3: Commit**

```bash
git add agent-ui/README.md
git commit -m "feat(agent-ui): README with setup guide and event type reference"
```

---

## Self-Review

**Spec coverage:**
- ✅ Separate folder (`agent-ui/`) — no mixing with migration tool
- ✅ Different port (4001) with proxy to 4000
- ✅ Shows tool calls with args and results
- ✅ Shows LLM responses
- ✅ Shows migration state at session start
- ✅ Live SSE feed
- ✅ Clean dark UI — 3 panel layout
- ✅ Session history — list of past sessions
- ✅ All API calls go through existing GEM CO endpoints

**Placeholder scan:** None found — all code is complete.

**Type consistency:** `sessionId` used consistently. `auditLog(sessionId, type, payload)` signature matches all call sites.
