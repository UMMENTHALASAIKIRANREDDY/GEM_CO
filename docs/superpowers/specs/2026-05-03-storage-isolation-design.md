# Storage Isolation Design

**Date:** 2026-05-03  
**Status:** Approved for implementation  
**Decision method:** grill-me interview

---

## Problem

All app state lived in flat localStorage keys (`gem_step`, `gem_mappings`, etc.) with no user namespace. MongoDB collections were inconsistently namespaced — some had `appUserId`, some used composite email keys, some had no user filter at all. Multiple users on the same browser or same server could see each other's data.

---

## Principles

1. **MongoDB is authoritative** for all data. localStorage is a disposable UI cache — losing it loses nothing.
2. **Every MongoDB document is owned by one user** via `appUserId`. No cross-user queries ever.
3. **Everyone is equal** — there is no admin super-view. CloudFuze creates credentials and hands them to customers. Each customer sees only their own data. The `role` field on `appUsers` only controls who can create new login accounts.
4. **Config is permanent per user but updatable** — tenantId and customerName are saved to MongoDB against the user's account. A user can switch tenants; the new value overwrites their record.
5. **Migration runs create a workspace per run** — history is preserved. Each run gets its own `workspaceId`.
6. **One job per mapped user per run** — granular retry. Failed users are retried individually by `jobId`, not the whole batch.

---

## localStorage — 3 keys only

All namespaced by userId: `gem_<userId>_step`, `gem_<userId>_migDir`, `gem_<userId>_agent_msgs`.

| Key | What | Purpose |
|-----|------|---------|
| `step` | Current UI step (0–5) | Fast render on page refresh |
| `migDir` | Selected migration direction | Fast render on page refresh |
| `agentMsgs` | Chat message array | Fast render, backed by `chatHistory` in DB |

**Everything else is removed from localStorage.** On login, state is loaded from MongoDB.

---

## MongoDB Collections

### `appUsers` (existing)
Login credentials. Unchanged.
```js
{
  _id: ObjectId,
  email: String,        // unique
  password: String,     // bcrypt hash
  name: String,
  role: 'user' | 'admin',  // admin = can create user accounts only
  createdAt: Date,
}
```

### `userConfig` (new)
Permanent per-user settings. One document per user, upserted on change.
```js
{
  appUserId: String,    // unique index
  tenantId: String,
  customerName: String,
  updatedAt: Date,
}
```

### `authSessions` (existing — keep as-is)
Google and Microsoft tokens. Already namespaced by `appUserId`. Already restored on server restart.
```js
{
  appUserId: String,
  provider: 'google' | 'microsoft',
  email: String,
  tokens: Object,
  savedAt: Date,
}
```

### `uploads` (existing — add appUserId)
ZIP file uploads for CL2G migration. Add `appUserId` to every document. All queries must filter by `appUserId`.
```js
{
  _id: String,          // upload ID
  appUserId: String,    // ADD THIS — was missing
  extractPath: String,
  totalUsers: Number,
  totalConversations: Number,
  uploadTime: Date,
}
```

### `migrationWorkspaces` (replaces `reportsWorkspace`)
One document per migration run. History preserved across runs.
```js
{
  workspaceId: String,  // unique, e.g. `ws_<timestamp>`
  appUserId: String,
  migDir: String,       // 'gemini-copilot' | 'copilot-gemini' | 'claude-gemini'
  status: 'running' | 'done' | 'failed' | 'dry_done',
  dryRun: Boolean,
  tenantId: String,
  customerName: String,
  extractPath: String,  // for CL2G
  stats: { users: Number, pages: Number, errors: Number },
  startTime: Date,
  endTime: Date,
  createdAt: Date,
}
```

### `migrationJobs` (new)
One document per mapped user per run. Enables granular per-user retry.
```js
{
  jobId: String,        // unique, e.g. `job_<timestamp>_<random>`
  workspaceId: String,  // parent run
  appUserId: String,
  migDir: String,
  sourceEmail: String,  // source user email
  destEmail: String,    // destination user email
  status: 'pending' | 'running' | 'done' | 'failed' | 'retried',
  pages: Number,
  errors: [{ page: String, message: String }],
  startTime: Date,
  endTime: Date,
}
```

**Retry flow:** Find all `migrationJobs` where `workspaceId = X AND status = 'failed'`. Re-run only those jobs. Update their status to `'retried'`.

### `userMappings` (consolidate 3 collections into 1)
Replaces `userMappings`, `c2gUserMappings`, `cl2gUserMappings`. One collection, `migDir` field distinguishes direction. One document per user per direction — latest mapping overwrites previous.
```js
{
  appUserId: String,
  migDir: String,       // 'gemini-copilot' | 'copilot-gemini' | 'claude-gemini'
  mappings: Object,     // { sourceEmail: destEmail }
  updatedAt: Date,
}
// Unique index: { appUserId: 1, migDir: 1 }
```

### `chatHistory` (existing — keep as-is)
Agent conversation history. Already namespaced by `appUserId`.
```js
{
  appUserId: String,
  role: 'user' | 'assistant',
  content: String,
  migDir: String,
  timestamp: Date,
}
```

### `cachedUsers` (existing — verify appUserId)
Discovered Google/Microsoft users for auto-map. Must have `appUserId` on every doc and all queries must filter by it.
```js
{
  appUserId: String,
  migDir: String,
  role: 'source' | 'dest',
  email: String,
  displayName: String,
  discoveredAt: Date,
}
```

### `scheduledJobs` (existing — keep as-is)
Scheduled migration runs. Already has `appUserId`.

---

## Collections Removed / Eliminated

| Old collection | Replaced by |
|---|---|
| `reportsWorkspace` | `migrationWorkspaces` |
| `userWorkspace` | Eliminated — MongoDB is now directly authoritative; no sync doc needed |
| `c2gUserMappings` | `userMappings` with `migDir: 'copilot-gemini'` |
| `cl2gUserMappings` | `userMappings` with `migDir: 'claude-gemini'` |

---

## Login Flow (new)

1. User POSTs `/api/login` → session created
2. Frontend fetches `/api/me` → gets `appUser`
3. Detect user switch: if `gem_active_user` in localStorage ≠ current `_id` → clear localStorage + reset React state
4. Set `gem_active_user = appUser._id` in localStorage
5. Fetch `/api/init` (new endpoint) → returns `{ config, mappings, latestWorkspace }` in one call
6. Set React state from DB response
7. Restore chat: `agentMsgs` from localStorage (fast) + `chatHistory` from DB (authoritative)

---

## API Changes

| Endpoint | Change |
|---|---|
| `GET /api/init` | New — returns config + mappings + latest workspace per direction in one call |
| `GET /api/config` | New — returns `userConfig` for current user |
| `PUT /api/config` | New — upserts `userConfig` |
| `GET /api/workspaces` | New — returns all `migrationWorkspaces` for current user |
| `GET /api/jobs/:workspaceId` | New — returns all `migrationJobs` for a workspace |
| `POST /api/jobs/:jobId/retry` | New — retries a single failed job |
| `GET /api/workspace` | Removed (was userWorkspace cross-device sync) |
| `PUT /api/workspace` | Removed |

---

## What Does NOT Change

- Auth OAuth flows (Google, Microsoft) — user still clicks buttons
- File upload UI — user still physically uploads ZIP
- SSE agent chat protocol
- COMBINATIONS registry pattern
- agentLoop, toolExecutor, systemPrompt logic (minor updates for new collection names)
