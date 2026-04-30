# Agent Chat Panel Redesign — Spec
**Date:** 2026-04-30

## Problem
Current agent has two conflicting roles: chat assistant AND UI controller. The `navigate_to_step` tool causes the left panel to jump unexpectedly mid-workflow. Auto-trigger `useEffect` hooks fire agent messages on every step/auth/data change, creating noise and navigation loops. Hardcoded SSE milestone messages interrupt the user during active migration.

## Goal
Agent is a **page-aware guide and Q&A assistant**. It tells users what to do on each step, answers questions, explains errors, and gives post-migration setup instructions. It never drives the left panel.

---

## Agent Modes

| Mode | When | Behavior |
|---|---|---|
| `guide` | Steps 0–4, not running | Shows page instruction, answers questions |
| `running` | Migration actively running | Silent — responds only if user asks |
| `done` | Migration finished | One summary message + next steps |
| `post_setup` | User asks "what now?" after done | Tool call → inline setup widget in chat |

### Mode Transitions
- `guide` → `running`: Start Migration pressed
- `running` → `done`: SSE `done` event
- `done` → `guide`: "New Migration" / "Start Another" clicked (chat context resets)
- `done` → `running`: "Retry Failed" clicked
- Any → `guide` step 0: Logo click (full reset)

---

## Edge Cases

- **Back/forward navigation:** Agent updates guide message when step changes, only in `guide` mode. Guard: only fires if mode is `guide` AND step genuinely changed.
- **Direction change:** `migDir` reset → step 1 → fresh guide message for new direction.
- **New migration after done:** Stats/step/migDir reset → mode back to `guide` → fresh step 1 message. Chat history preserved (user can scroll), but agent context resets.
- **Retry after errors:** Mode → `running`. After done → new summary appended.
- **Dry run → live:** Dry done → summary + "Ready to go live?" quick reply. Live start → `running`. Live done → summary + post-setup quick reply.
- **Page refresh:** On load, check persisted `migDone`/`live` state → post appropriate mode message once.

---

## Per-Step Guide Messages

### Shared
- Step 0: "Connect your cloud accounts. Google Workspace and Microsoft 365 are needed for Gemini↔Copilot migration. Only Google is needed for Claude → Gemini."
- Step 1: "Choose your migration direction. Gemini→Copilot and Copilot→Gemini require both accounts connected."

### Gemini → Copilot
- Step 2: "Import your Gemini data — upload a Vault ZIP or export directly from Google Drive."
- Step 3: "Map each Google user to their Microsoft 365 destination. Auto-map fills matches by email."
- Step 4: "All set. Start with a dry run first to preview — no data changes until you go live."

### Copilot → Gemini
- Step 2: "Map each Microsoft 365 user to their Google Drive destination. Auto-map works by email match."
- Step 3: "Set folder name and date range. Dry run first is strongly recommended."

### Claude → Gemini
- Step 2: "Upload your Claude export ZIP. You can export it from Claude Settings → Data Export."
- Step 3: "Map each Claude user to their Google destination email. Auto-map fills by email match."
- Step 4: "Set the Google Drive folder name where files will land. Start with a dry run to preview."

---

## Post-Migration Guide Tool

**Tool name:** `show_post_migration_guide`

Triggered when: `mode === done` AND (`migDir === claude-gemini` OR `migDir === copilot-gemini`) AND user asks about next steps OR clicks "What do I do next?" quick reply.

**gemini-copilot:** No widget needed. Agent explains in text: users open Microsoft Copilot or Teams — the CloudFuze agent is already pinned in their sidebar with all migrated conversations.

**copilot-gemini / claude-gemini:** Tool renders inline chat widget with:
1. Open Gemini Gems (gemini.google.com → Gems → New Gem)
2. Add Google Drive folder as Knowledge
3. Paste Gem instructions (copy button)
4. Name and save the Gem
- Copyable GEM_INSTRUCTIONS text
- Tip: add all files (conversations, memory, projects) for best results

Agent answers follow-up Gem questions verbally via LLM.

---

## Code Changes

### Removed
- All `sendToAgent(msg, isSystem=true)` useEffect auto-triggers
- `navigate_to_step` from AGENT_TOOLS
- `start_migration` from AGENT_TOOLS
- `retry_failed` from AGENT_TOOLS
- Hardcoded SSE milestone agent messages (`firstUser`, `firstError` guards)

### Kept
- `get_migration_status`
- `explain_log`
- `show_status_card`
- `show_reports`

### Added
- `show_post_migration_guide` tool (backend + frontend widget)
- `agentMode` state in App component
- `STEP_GUIDE` lookup table (step × migDir → message string)
- Single `useEffect` watching `[agentMode, step, migDir]` — fires guide message only in `guide` mode on genuine change
- Mode transition logic replacing existing scattered `useEffect` hooks
