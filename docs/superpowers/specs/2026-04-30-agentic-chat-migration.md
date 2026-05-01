# Agentic Chat Migration — Spec
**Date:** 2026-04-30

## Problem
The right panel agent is a passive guide — it tells users what to do but cannot act. Users must manually click through the left panel for every step. The agent cannot drive migration, auto-map users, set options, or navigate the UI on behalf of the user.

## Goal
Make the chat panel a **full control surface** for migration. User can complete the entire migration by chatting — the left panel updates to reflect every agent action. Simultaneously, when the user acts in the left panel, the agent notices and provides contextual guidance and follow-up chips. Both panels are always in sync.

---

## Two Interaction Paths (Both Always Work)

### Path A: Chat-driven
User types → agent decides → tool executes → React state updates → left panel reflects change.

### Path B: Left panel-driven
User clicks → React state updates → targeted notification fires → agent posts contextual message + follow-up chips.

Both paths share the same React state. Switching between them mid-flow works seamlessly.

---

## New Agent Tools (Backend)

### Action tools (new)
| Tool | Args | Effect |
|---|---|---|
| `navigate_to_step` | `step: number` | Sets `step` state in frontend |
| `select_direction` | `migDir: string` | Sets `migDir`, navigates to step 2 |
| `start_migration` | `dryRun: boolean` | Calls existing `runMigration` / `runC2GMigration` / `runCL2GMigration` |
| `retry_failed` | — | Calls existing `retryFailed` |
| `auto_map_users` | — | Fires auto-map logic for current direction |
| `set_migration_config` | `folderName?, fromDate?, toDate?, dryRun?` | Updates config/options state |
| `pre_flight_check` | — | Returns validation result: auth, upload, mapping counts, warnings |

### Existing tools (kept)
`get_migration_status`, `explain_log`, `show_status_card`, `show_reports`, `show_post_migration_guide`, `show_mapping`

### Removed restriction
System prompt currently says: *"Never suggest navigating to a step, starting a migration, or retrying — the user controls those buttons."* This line is removed. Agent is now allowed to act.

---

## Frontend — New Agent Actions

Backend returns `action` field. Frontend `sendToAgent` handler executes:

```js
// New actions added to sendToAgent response handler
if (data.action === 'navigate_to_step') setStep(data.step);
if (data.action === 'select_direction') { setMigDir(data.migDir); setStep(2); }
if (data.action === 'start_migration_dry') { /* existing logic */ }
if (data.action === 'start_migration_live') { /* existing logic */ }
if (data.action === 'retry_failed') retryFailed();
if (data.action === 'auto_map_users') triggerAutoMap();  // new function
if (data.action === 'set_config') applyAgentConfig(data.config); // new function
```

---

## Left Panel → Agent Notifications (Targeted)

Specific events fire a single proactive agent message. Not reactive useEffects — explicit calls after the action completes.

| Event | Where | Agent message |
|---|---|---|
| Google auth success | `handleChatSignInGoogle` success callback | *"Google connected! [next step for state]"* |
| MS auth success | `handleChatSignInMs` success callback | *"Microsoft 365 connected! [next step]"* |
| Upload complete (G2C/CL2G) | after `setCl2gUploadData` / G2C upload handler | *"[N] users found. Want me to auto-map by email?"* + chips |
| Auto-map complete | after auto-map logic sets mappings | *"Mapped [X/N]. [Y] have no match — fill them in on the left."* + chips |
| All users mapped | after mapping state update detects 0 unmapped | *"All [N] users mapped. Ready for a dry run?"* + chips |

Notifications only fire when `agentMode === 'guide'` to avoid noise during migration.

---

## Dynamic Quick Replies

Backend generates `quickReplies` array on every response based on `migrationState`. LLM decides what's contextually relevant. Backend also sends a `suggestedChips` hint for structured states:

| State | Chips |
|---|---|
| Step 0, neither authed | `Connect Google` · `Connect Microsoft 365` · `What do I need?` |
| Step 0, Google only | `Connect Microsoft 365` · `Skip — do Claude → Gemini` |
| Step 1 | `Gemini → Copilot` · `Copilot → Gemini` · `Claude → Gemini` · `What's the difference?` |
| Step 2 CL2G, no upload | `How do I export from Claude?` · `What's in the ZIP?` |
| Upload done | `Yes, auto-map` · `I'll map manually` |
| Mapping partial | `Fill them in` · `Skip unmapped users` |
| Mapping complete | `Start dry run` · `What is a dry run?` · `Go straight to live` |
| Running | `How's it going?` · `How long will this take?` |
| Done dry | `Go live now` · `Show me the report` |
| Done live | `What do I do next?` · `Download report` · `Start another` |
| Error | `Retry failed` · `Why did they fail?` |

`handleAgentQuickReply` handles all chips — direction chips call `select_direction`, action chips call respective functions, question chips call `sendToAgent(chip)`.

---

## Pre-flight Check Logic

Before `start_migration` tool executes, agent calls `pre_flight_check` internally. Backend checks:

1. Required accounts connected for direction (Google for CL2G, both for G2C/C2G)
2. Upload present and `extractPath` exists on disk (CL2G/G2C)
3. At least 1 user mapped
4. Count of unmapped users — warn if >0
5. Migration already running — block if true

Returns structured result to LLM which decides whether to proceed or explain the blocker.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| "Start migration" — unmapped users exist | Pre-flight warns, asks skip or fill |
| "Go live" — dry run not done | Agent warns, asks confirm |
| Already running + user says "start" | Agent says already running, offers status |
| "Stop migration" | No API — agent says honestly, says wait for completion |
| Upload stale (server restart) | Pre-flight detects missing `extractPath`, tells user to re-upload |
| Direction change mid-flow | Agent warns state will reset, confirms, then resets and navigates |
| Vague input ("do it", "go") | Agent asks clarifying question with chips |
| Auth popup opened, user asks something | Agent answers, popup stays open |
| "Retry" — nothing failed | Agent says nothing to retry |
| Running mode — user asks question | Agent answers, never interferes with migration |

---

## System Prompt Changes

Remove: `"Never suggest navigating to a step, starting a migration, or retrying — the user controls those buttons."`

Add:
```
You CAN take actions on behalf of the user using tools:
- navigate_to_step: move the left panel to a specific step
- select_direction: choose migration direction and advance to upload step
- start_migration: start a dry run or live migration
- retry_failed: retry failed items from last run
- auto_map_users: automatically map users by email match
- set_migration_config: set folder name, date range, or dry/live toggle
- pre_flight_check: validate state before starting migration

Always run pre_flight_check before start_migration.
Always confirm before going live (dryRun: false) if last run was not a dry run.
When user intent is ambiguous, ask a clarifying question with chips rather than guessing.
Generate contextual quickReplies on every response based on the current state.
```

---

## Files Changed

| File | Change |
|---|---|
| `src/modules/g2c/routes.js` | Add 7 new tools to `AGENT_TOOLS`, handle in switch, update system prompt, return new action types |
| `ui/index.html` | Handle new actions in `sendToAgent`, add `triggerAutoMap()`, add `applyAgentConfig()`, add notification calls in auth/upload/mapping handlers, update `handleAgentQuickReply` for direction chips |

No new files needed. All changes are additive to existing patterns.
