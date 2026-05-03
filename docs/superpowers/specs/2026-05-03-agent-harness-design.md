# Agent Harness Design

**Date:** 2026-05-03  
**Status:** Approved for implementation

---

## Goal

Replace the current signal-based agent (frontend executes actions) with a true agentic backend loop that drives the entire migration process through natural language chat. User never needs to touch the left panel — agent navigates it, executes tools, and streams real-time updates. Works across all current migration combinations (G2C, C2G, CL2G) and is extensible for future ones.

---

## Architecture Overview

```
User types message
       ↓
Frontend sends POST /api/chat with migrationState + message
       ↓
Backend opens SSE stream
       ↓
Agentic Loop (max 8 iterations):
  ├─ Call AI with tools + system prompt + conversation history
  ├─ If text response → stream to chat → break
  └─ If tool_call:
       ├─ If destructive + not confirmed → stream confirmation request → break
       ├─ Execute tool server-side via toolExecutor
       ├─ Stream any UI events (navigate, refresh_mapping, show_widget)
       ├─ Feed tool result back to AI
       └─ Continue loop
       ↓
Stream {type:'done'} → frontend sets typing=false
```

**Key shift:** Frontend drops all action-execution logic. It only sends messages and consumes SSE stream. Backend is the sole executor.

---

## Files

### New Files
- `src/agent/agentLoop.js` — SSE agentic loop, called by `/api/chat`
- `src/agent/toolExecutor.js` — executes all tool calls server-side
- `src/agent/combinations.js` — registry of all migration combinations
- `src/agent/conversationHistory.js` — MongoDB read/write for chat history
- `src/agent/systemPrompt.js` — builds context-aware system prompt (extracted from routes.js)
- `src/agent/tools.js` — all AGENT_TOOLS definitions (extracted from routes.js)

### Modified Files
- `src/modules/g2c/routes.js` — `/api/chat` route delegates to `agentLoop.js`; action-execution routes remain for backward compat during transition
- `ui/index.html` — replace `fetch→json` with SSE stream consumer; remove all frontend action-execution code; remove `pendingAction` state

---

## Combination Registry (`src/agent/combinations.js`)

Each migration direction is a single config entry. Adding a new combination = adding one entry.

```js
export const COMBINATIONS = {
  'gemini-copilot': {
    label: 'Google Workspace → Microsoft 365',
    auth: ['google', 'microsoft'],
    hasUpload: false,
    steps: ['Connect', 'Direction', 'Map Users', 'Options', 'Migration'],
    runMigration: (args, session) => import('../modules/g2c/migrate.js').then(m => m.runG2CMigration(args, session)),
    runAutoMap: (args, session) => import('../modules/g2c/automap.js').then(m => m.autoMapG2C(args, session)),
    getStatus: (batchId, session) => import('../modules/g2c/status.js').then(m => m.getG2CStatus(batchId, session)),
    runRetry: (args, session) => import('../modules/g2c/retry.js').then(m => m.retryG2C(args, session)),
  },
  'copilot-gemini': {
    label: 'Microsoft 365 Copilot → Google Workspace',
    auth: ['microsoft', 'google'],
    hasUpload: false,
    steps: ['Connect', 'Direction', 'Map Users', 'Options', 'Migration'],
    runMigration: (args, session) => import('../modules/c2g/migrate.js').then(m => m.runC2GMigration(args, session)),
    runAutoMap: (args, session) => import('../modules/c2g/automap.js').then(m => m.autoMapC2G(args, session)),
    getStatus: (batchId, session) => import('../modules/c2g/status.js').then(m => m.getC2GStatus(batchId, session)),
    runRetry: (args, session) => import('../modules/c2g/retry.js').then(m => m.retryC2G(args, session)),
  },
  'claude-gemini': {
    label: 'Microsoft Teams/Copilot ZIP → Google Workspace',
    auth: ['google'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Upload ZIP', 'Map Users', 'Options', 'Migration'],
    runMigration: (args, session) => import('../modules/cl2g/migrate.js').then(m => m.runCL2GMigration(args, session)),
    runAutoMap: (args, session) => import('../modules/cl2g/automap.js').then(m => m.autoMapCL2G(args, session)),
    getStatus: (batchId, session) => import('../modules/cl2g/status.js').then(m => m.getCL2GStatus(batchId, session)),
    runRetry: (args, session) => import('../modules/cl2g/retry.js').then(m => m.retryCL2G(args, session)),
  },
};
```

---

## SSE Stream Protocol

Every backend-to-frontend message is a newline-delimited JSON event:

```
data: {"type":"text","content":"Let me check what's connected..."}\n\n
data: {"type":"ui_event","event":"navigate","step":0}\n\n
data: {"type":"ui_event","event":"select_direction","direction":"gemini-copilot","step":2}\n\n
data: {"type":"ui_event","event":"show_widget","widget":{"type":"auth_connect"}}\n\n
data: {"type":"ui_event","event":"quick_replies","replies":["Yes, go live","Not yet"]}\n\n
data: {"type":"ui_event","event":"refresh_mapping"}\n\n
data: {"type":"done"}\n\n
```

**Event types:**

| Event | Payload | Frontend action |
|-------|---------|----------------|
| `navigate` | `{step}` | `setStep(step)` |
| `select_direction` | `{direction, step}` | `setMigDir(direction); setStep(step)` |
| `show_widget` | `{widget}` | `setWidget(widget)` |
| `quick_replies` | `{replies:[]}` | `setQuickReplies(replies)` |
| `refresh_mapping` | — | trigger mapping reload |
| `refresh_reports` | — | trigger reports reload |
| `refresh_status` | `{batchId}` | update progress display |

---

## Agentic Loop (`src/agent/agentLoop.js`)

```js
export async function runAgentLoop(req, res, { message, migrationState, isSystemTrigger }) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const streamText = (content) => res.write(`data: ${JSON.stringify({type:'text', content})}\n\n`);
  const streamEvent = (event, payload) => res.write(`data: ${JSON.stringify({type:'ui_event', event, ...payload})}\n\n`);
  const streamDone = () => { res.write(`data: ${JSON.stringify({type:'done'})}\n\n`); res.end(); };

  const history = await loadConversationHistory(req.session.appUserId);
  const systemPrompt = buildSystemPrompt(migrationState);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message }
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations++ < MAX_ITERATIONS) {
    const aiResponse = await callAI(messages, isSystemTrigger ? null : AGENT_TOOLS);

    if (aiResponse.content) {
      streamText(aiResponse.content);
      await saveConversationHistory(req.session.appUserId, 'user', message);
      await saveConversationHistory(req.session.appUserId, 'assistant', aiResponse.content);
      break;
    }

    if (aiResponse.tool_calls) {
      const call = aiResponse.tool_calls[0];
      const args = JSON.parse(call.function.arguments);

      if (DESTRUCTIVE_TOOLS.includes(call.function.name) && !req.session.pendingConfirmed) {
        const conf = CONFIRMATION_MESSAGES[call.function.name];
        streamText(conf.prompt);
        streamEvent('quick_replies', { replies: ['Yes, proceed', 'Cancel'] });
        req.session.pendingAction = { tool: call.function.name, args };
        break;
      }

      req.session.pendingConfirmed = false;

      const result = await toolExecutor.execute(call.function.name, args, {
        streamEvent,
        session: req.session,
        migrationState,
      });

      messages.push({ role: 'assistant', tool_calls: aiResponse.tool_calls });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  streamDone();
}
```

---

## Tool Executor (`src/agent/toolExecutor.js`)

Handles all 16 tools. UI tools stream events. Execution tools call backend functions.

**Destructive tools** (require prior confirmation):
- `start_migration`
- `retry_failed`

**Execution tools** (run server-side immediately):
- `auto_map_users` → routes via COMBINATIONS registry
- `pre_flight_check` → validates auth, mappings, upload per combination
- `get_migration_status` → queries DB for current batchId status
- `get_auth_status` → queries `authSessions` collection
- `get_conversation_history` → loads from `chatHistory`
- `explain_error` → reads migration logs + calls AI for plain English summary
- `set_schedule` → writes to `scheduledJobs` collection

**UI event tools** (stream events, no DB):
- `navigate_to_step` → `streamEvent('navigate', {step})`
- `select_direction` → `streamEvent('select_direction', {direction, step:2})`
- `show_mapping` → `streamEvent('refresh_mapping', {})`
- `show_reports` → `streamEvent('refresh_reports', {})`
- `show_status_card` → `streamEvent('show_widget', {widget:{type:'status_card', ...data}})`
- `show_post_migration_guide` → `streamEvent('show_widget', {widget:{type:'post_migration_guide'}})`
- `set_migration_config` → stores config in session, streams `navigate` to options step

---

## Conversation History (`src/agent/conversationHistory.js`)

**MongoDB collection:** `chatHistory`

```js
{
  appUserId: String,
  role: 'user' | 'assistant',
  content: String,
  migDir: String,
  timestamp: Date
}
```

- **Load:** last 20 messages for `appUserId`, sorted by timestamp asc
- **Save:** after every completed agent response (both user message + assistant reply)
- **Trim:** keep max 50 per user, delete oldest on insert when over limit

---

## System Prompt Design (`src/agent/systemPrompt.js`)

The system prompt has these sections:

1. **Persona** — Agent is "GEM Migration Assistant". Natural, thoughtful, direct. Thinks out loud. Gives context and reasoning. Varies tone — brief for confirmations, detailed for explanations. Never robotic.

2. **Available combinations** — Built from COMBINATIONS registry. Lists all directions, what auth each needs, whether upload is required.

3. **Current state snapshot** — Auth status, current step, direction, upload state, mapping count, migration status.

4. **UI context** — What the user sees on the left panel right now (same `uiContext` string computed on frontend).

5. **Tool rules** — When to use each tool. Never call destructive tools without asking. Always run pre_flight_check before start_migration.

6. **Response style rules:**
   - Think through the situation before answering
   - Explain *why* not just *what*
   - Suggest what to do next proactively
   - Match response length to situation (2 sentences for simple, full explanation for complex)
   - Use natural language — "Looks like..." / "I notice..." / "Good news —" / "One thing to check..."

---

## Frontend Changes (`ui/index.html`)

### Remove
- `pendingAction` state and all `CONFIRM_ACTIONS` logic
- All `if(action==='start_migration_dry')` blocks in `handleAgentQuickReply`
- `if(action==='auto_map_users')` etc.
- Direct calls to `/api/migrate`, `/api/migrate/retry`, `/api/automap`

### Add
- SSE stream consumer replacing `fetch→json` in `sendToAgent`
- `applyUIEvent(event)` dispatcher that maps event types to React state setters
- Streaming text append (chunk by chunk as AI response streams in)

### Keep
- `migrationState` builder (still sent to backend each message)
- `uiContext` computation (still sent to backend)
- `handleAgentQuickReply` for chip clicks (sends message to agent)
- Upload components (user must physically upload — agent can't do this)
- Auth OAuth buttons (user must click — agent can't do this)

---

## Conversation Flow Example

```
[User opens app, step 0]

Agent: "Hey! I'm your migration assistant. I can see you have Google connected 
        but Microsoft 365 isn't linked yet. You've got a few options:
        → Google → Microsoft 365 (needs both)
        → Microsoft 365 → Google (needs both)  
        → Teams/Copilot ZIP → Google (just needs Google ✓)
        
        Want to start with the Teams ZIP route since you're already set up for it?"

[Chips: "Yes, start Teams→Google" | "Connect Microsoft 365" | "Tell me more"]

[User: "connect microsoft"]

Agent: "Sure — let me pull up the Microsoft connection..."
[streams: ui_event navigate step=0, ui_event show_widget auth_connect]
"The connect panel is open on the left. Click 'Sign in with Microsoft 365' 
 and authorize the app. I'll be here when you're done."

[User connects, returns]

Agent: "Microsoft 365 is connected now. You're all set for any direction.
        Which migration do you want to run?"

[Chips: "Google → Microsoft 365" | "Microsoft 365 → Google" | "Teams ZIP → Google"]
```

---

## Error Handling

- Agent explains error in plain English (via `explain_error` tool if logs available)
- Always asks before retrying: "3 users failed with permission errors. Want me to retry them?"
- If pre_flight_check returns blockers, agent explains each blocker and what to fix
- If agentic loop hits max iterations (8), streams a fallback message and ends

---

## Extensibility

Adding a new migration combination:
1. Add entry to `COMBINATIONS` in `src/agent/combinations.js`
2. Implement the 4 backend functions (`runMigration`, `runAutoMap`, `getStatus`, `runRetry`)
3. System prompt auto-updates (reads from COMBINATIONS)
4. Agent automatically knows the new direction, its auth requirements, and steps

No changes to agentLoop.js, toolExecutor.js, or frontend.

---

## What Is NOT Changing

- Left panel UI components (user still sees and can interact with them)
- Auth OAuth flows (user must click — agent navigates to them, user clicks)
- File upload components (user physically uploads — agent knows when done via migrationState)
- MongoDB schemas for migrations, users, mappings
- Existing `/api/migrate`, `/api/automap` backend routes (kept for direct use if needed)
