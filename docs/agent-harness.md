# Agent Harness — Architecture Reference

How the agentic chat works end-to-end in CloudFuze GEM.

---

## Overview

The right-panel chat is a full LLM agent loop. Every user message (and every step-change navigation) goes through Claude, which reads real migration state, calls tools, and streams back text + UI events. There are no hardcoded responses.

```
Browser (ui/index.html)
  └─ sendToAgent(message, isSystem?)
       └─ POST /api/g2c/chat  (SSE stream)
            └─ runAgentLoop()  (src/agent/agentLoop.js)
                 ├─ buildSystemPrompt()   → describes real state to Claude
                 ├─ callAI()              → Claude API, tool_use enabled
                 ├─ executeTool()         → tool runs, may stream UI events
                 └─ streams text/events back to browser
```

---

## Files

| File | Role |
|---|---|
| `src/agent/agentLoop.js` | Main loop — SSE setup, confirmation flow, tool call loop |
| `src/agent/tools.js` | Tool definitions sent to Claude + destructive tool list |
| `src/agent/toolExecutor.js` | Executes each tool call, returns result JSON |
| `src/agent/systemPrompt.js` | Builds the system prompt from live migration state |
| `src/agent/callAI.js` | Thin wrapper around Anthropic SDK |
| `src/agent/conversationHistory.js` | Load/save conversation history from MongoDB |
| `src/agent/combinations.js` | Per-direction auth/mapping rules used by pre_flight_check |
| `src/modules/g2c/routes.js` | Chat route entry point (`POST /api/g2c/chat`), wires deps |

---

## Request Flow

### 1. Frontend sends message

```js
// ui/index.html — sendToAgent(msg, isSystem?)
fetch('/api/g2c/chat', {
  method: 'POST',
  body: JSON.stringify({ message, migrationState, migrationLogs, isSystemTrigger })
})
// Reads SSE stream, dispatches events to UI
```

`migrationState` is the full React state snapshot sent with every request — this is how Claude knows what step the user is on, which accounts are connected, upload status, mapping counts, etc.

`isSystemTrigger: true` suppresses the user bubble and forces a short 1-2 sentence context response (used for step-change auto-guidance).

### 2. Backend receives, wires executors

`src/modules/g2c/routes.js` extracts `message`, `migrationState`, `migrationLogs`, `isSystemTrigger` from the request body. It attaches `startMigration` and `retryMigration` closures to `req.session._agentDeps` so `toolExecutor.js` can trigger real migrations. Then calls `runAgentLoop()`.

### 3. Agent loop runs

`runAgentLoop()` in `agentLoop.js`:

1. **Confirmation check** — if `req.session.pendingAction` exists, user is answering a confirmation prompt. "Yes, proceed" executes the tool. "Cancel" clears it.
2. **Load history** — reads last N turns from MongoDB (`conversationHistory` collection).
3. **Build messages** — system prompt + history + user message. For system triggers: no history, short instruction appended.
4. **Call Claude** — with `AGENT_TOOLS` list. If `isSystemTrigger`, tools are disabled (null).
5. **Tool loop** — up to 8 iterations. For each `tool_use` response:
   - If tool is in `DESTRUCTIVE_TOOLS` (`start_migration`, `retry_failed`) → pause, ask for confirmation, set `pendingAction` in session, stream chips ["Yes, proceed", "Cancel"].
   - Otherwise → execute immediately via `executeTool()`, feed result back to Claude.
6. **Stream response** — text chunks streamed as `{ type: 'text', content }` SSE events.
7. **Save history** — user + assistant turn saved to MongoDB.

### 4. UI events

Tools can call `streamEvent(eventName, payload)` to push UI actions alongside text:

| Event | Effect in browser |
|---|---|
| `navigate` | Left panel jumps to step N |
| `select_direction` | Sets migDir, advances step |
| `refresh_mapping` | Reloads mapping grid |
| `refresh_reports` | Reloads reports panel |
| `refresh_status` | Reloads migration status |
| `show_widget` | Renders a widget in chat (status card, post-migration guide) |
| `set_config` | Updates migration config options |
| `quick_replies` | Shows chip buttons below the message |

---

## Tools

### UI / Navigation (no confirmation required)

| Tool | What it does |
|---|---|
| `navigate_to_step` | Jump left panel to step 0-5 |
| `select_direction` | Set migration direction + advance step |
| `show_mapping` | Open mapping grid |
| `show_reports` | Open reports panel |
| `show_status_card` | Render a stats widget in chat |
| `show_post_migration_guide` | Show post-migration instructions widget |
| `set_migration_config` | Set folderName, date range, dryRun flag |

### Data / Query

| Tool | What it does |
|---|---|
| `get_migration_status` | Query `migrationWorkspaces` for current run stats |
| `get_auth_status` | Query `authSessions` for Google/Microsoft auth state |
| `auto_map_users` | Match source↔dest users by email, write to `userMappings` |
| `pre_flight_check` | Validate auth + mappings before migration |
| `explain_log` | Parse a log line (keyword match), return explanation |
| `explain_error` | Read error logs, call Claude to summarize in plain English |
| `get_conversation_history` | Load conversation history from MongoDB |
| `set_schedule` | Write a scheduled job to `scheduledJobs` collection |

### Destructive (confirmation required)

| Tool | Confirmation message |
|---|---|
| `start_migration` | Dry run: "Ready to run a dry run — safe, no data written. Proceed?" Live: "Ready to go live — writes real data. Are you sure?" |
| `retry_failed` | "I'll retry all failed items from the last batch. Want me to go ahead?" |

---

## Step-Change Auto-Context

When the user navigates to a new step, the frontend fires:

```js
// ui/index.html ~line 3117
useEffect(() => {
  if (!wsLoaded || agentMode === 'running') return;
  const key = `${step}:${migDir}`;
  if (prevGuideKeyRef.current === key) return;
  prevGuideKeyRef.current = key;
  setTimeout(() => sendToAgentRef.current('__step_context__', true), 400);
}, [wsLoaded, agentMode, step, migDir]);
```

Backend detects `message === '__step_context__'` and sets `isSystemTrigger: true`. Agent loop then:
- Skips conversation history
- Appends short instruction: *"Write 1-2 sentences: what they see right now, what to do next. Be specific to their actual state. Do not ask questions."*
- Disables tools (no widget/navigation calls on auto-context)
- Streams short contextual greeting

---

## Confirmation Flow

For destructive tools, the loop pauses mid-execution:

```
Claude decides → start_migration
agentLoop → store { tool, args } in req.session.pendingAction
agentLoop → stream confirmation message + chips ["Yes, proceed", "Cancel"]

Next request from user:
  message === "Yes, proceed" → execute tool, clear pendingAction
  message === "Cancel"       → clear pendingAction, say cancelled
  anything else              → clear pendingAction, continue as normal message
```

Session-level state (`pendingAction`) means the confirmation persists across page interactions until answered.

---

## Adding a New Tool

1. Add tool definition to `AGENT_TOOLS` in `src/agent/tools.js`
2. Add `case 'tool_name':` to the switch in `src/agent/toolExecutor.js`
3. If destructive, add the name to `DESTRUCTIVE_TOOLS` and add a message to `CONFIRMATION_MESSAGES`
4. If it needs a UI event, add handling in the browser SSE dispatcher in `ui/index.html`
