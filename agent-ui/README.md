# Agent Harness Monitor

A standalone dark-theme dashboard that monitors the GEM CO agent loop in real time.

## What it shows

- **Sessions panel** — list of recent agent sessions (most recent first)
- **Trace panel** — all audit events for the selected session (session_start → tool calls → LLM responses → session_end)
- **Detail panel** — full JSON payload of the selected event

## Running

```bash
# From the agent-ui/ directory:
npm install
npm start
```

Open http://localhost:4001

The GEM CO server must be running on port 4000.

## Architecture

- `server.js` — Express server on port 4001, proxies `/api/*` → port 4000
- `public/index.html` + `style.css` — dark 3-panel shell
- `public/app.js` — vanilla JS; polls `/api/audit/sessions`, loads traces on click, subscribes to `/api/audit/stream` SSE for live updates

## Event types

| Type | Color | Meaning |
|---|---|---|
| `session_start` | green | New agent session begins |
| `tool_call` | blue | Agent invoked a tool |
| `tool_result` | teal | Tool execution result |
| `llm_response` | purple | LLM returned text (loop ends) |
| `confirmation_gate` | amber | Waiting for user to confirm destructive action |
| `error` | red | Agent loop error |
| `session_end` | green | Session completed |
