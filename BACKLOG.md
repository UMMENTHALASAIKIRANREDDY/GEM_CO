# GEM_CO — Backlog

Deferred features and known gaps. Not blockers — picked up between sprints.

Last updated: 2026-06-06

---

## High priority

### 1. Switch Copilot-destination from OneNote pages to DOCX files
**Directions affected:** G2C, C2C, CL2C (anything writing to Copilot/M365 as destination).

**Problem:** OneNote pages require a manual one-time setup step per user in the M365 admin console — the user must be "linked" / OneNote provisioned before pages can be created. Customers see this as friction and the migration fails with `ONENOTE_NOT_PROVISIONED` errors until they go fix it.

**Proposal:** Drop OneNote entirely as the destination format. Instead, write a single `.docx` per user (bundling all conversations, similar to how G2G / C2G / CL2G already do for Google Drive) and upload it to the user's OneDrive. No admin console step required — OneDrive is provisioned for every M365 user automatically.

**Touch points:**
- `src/modules/g2c/pagesCreator.js` → replace with DOCX builder + OneDrive upload
- `src/modules/c2c/migration/*` → same
- `src/modules/cl2c/migration/migrate.js` → same
- Reuse the `buildAllConversationsDocx` / `buildMergedBatchDocx` helpers from the Google-destination side
- Update Reports/CSV labels — "Pages Created" no longer applies
- Drop the `ONENOTE_NOT_PROVISIONED` error path

### 2. Parallel migration support (multi-batch)
Currently the tool serializes within a batch and has no guard between batches — two `/migrate` calls will both run but the live log stream and `currentBatchId` get clobbered.

**Two options, pick one based on customer flow:**
- **(a)** Add a "one batch at a time" guard — return `409 Conflict` if a batch is already running.
- **(b)** Build proper multi-batch UI — per-batch progress panels, switchable live log streams, batch queue.

Customer scenario is single-direction, so (a) is simpler and likely enough. Confirm with stakeholder before building.

---

## Medium priority

### 3. One Claude upload usable for both CL2C and CL2G
Today the user has to upload the Claude ZIP separately for each destination. Source data is the same — should be one upload, destination chosen at migrate-step time.

- New endpoints: `POST /api/uploads/claude`, `POST /api/uploads/gemini` (source-scoped, destination-agnostic)
- UI: upload step before direction selection, not after

### 4. G2G + G2C live progress refactor
Live progress events fire per-conversation but the SSE stream architecture is bespoke per direction. Consolidate into a shared progress emitter so the ring/stats animation behaves identically everywhere.

### 5. 504 retry in `g2c/pagesCreator.js`
OneNote API returns 504 Gateway Timeout intermittently. Current code marks the conversation as failed on first 504. Add exponential-backoff retry (3 attempts) before failing.

*Note: if backlog item #1 lands (DOCX instead of OneNote), this becomes obsolete.*

---

## Low priority / polish

### 6. Reports panel refresh button — no spinner
Clicking refresh re-fetches data but shows no visible loading state until the response arrives. Set `loading=true` inside the manual refresh path (not just on `refreshKey` change).

### 7. Clean up orphaned `onChangeDirection` props
The "Change Direction" button was removed but the prop and `handleChangeDirection` handler are still wired everywhere. Harmless but stale.

### 8. G2C `total_files_created` field rename
Renamed to `total_files_uploaded` in the summary but `ui/index.html` still reads the old name in one place. Falls back correctly so no visible bug, but should be cleaned up.

---

## Decisions made (won't do)

- ~~Switch all collections back to per-direction names~~ — consolidated by source (claudeUploads, geminiUploads) is the right model; future ChatGPT source will follow the same pattern.
- ~~Keep `uploads/` filesystem folder as a fallback~~ — DB-only is final; disk extracts are deleted after parse.
- ~~Per-message + per-session blob in same `chatHistory` collection~~ — split into `chatHistory` (agent messages) + `userSessions` (UI state). Don't merge them again.
