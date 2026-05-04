# Storage Architecture — What Lives Where

Single source of truth for every piece of state in CloudFuze GEM.

---

## Rule

**MongoDB is authoritative. localStorage is a disposable UI cache.**

On every login, the browser calls `GET /api/init` to hydrate from MongoDB. If localStorage is cleared or stale, nothing is lost — MongoDB has everything that matters.

---

## MongoDB Collections

### `users`
App-level accounts (created on first login via Google/Microsoft OAuth).

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Primary key |
| `email` | string | Login email |
| `provider` | string | `'google'` or `'microsoft'` |
| `createdAt` | Date | |

**Indexed:** none beyond `_id`.

---

### `authSessions`
OAuth tokens for Google and Microsoft per app user.

| Field | Type | Notes |
|---|---|---|
| `appUserId` | string | `.toString()` of `users._id` |
| `provider` | string | `'google'` or `'microsoft'` / `'azure'` |
| `email` | string | Authenticated account email |
| `accessToken` | string | |
| `refreshToken` | string | |

Used by `get_auth_status` tool to report real auth state to Claude.

---

### `userConfig`
One document per app user. Stores persistent preferences set through the agent or UI.

| Field | Type | Notes |
|---|---|---|
| `appUserId` | string | Unique per user |
| `defaultFolderName` | string | Default dest folder |
| `defaultDryRun` | boolean | |
| `updatedAt` | Date | |

**Index:** `{ appUserId: 1 }` unique.

Returned by `GET /api/init` as `config`.

---

### `userMappings`
One document per user per migration direction. Stores the source→dest email mapping table.

| Field | Type | Notes |
|---|---|---|
| `appUserId` | string | |
| `migDir` | string | `'gemini-copilot'`, `'copilot-gemini'`, `'claude-gemini'` |
| `mappings` | object | `{ sourceEmail: destEmail }` |
| `csvEmails` | array | Raw emails from uploaded CSV |
| `googleEmail` | string | Google account used |
| `msEmail` | string | MS account used (C2G only) |
| `updatedAt` | Date | |

**Index:** `{ appUserId: 1, migDir: 1 }` unique.

Returned by `GET /api/init` as `mappings` (array, all directions).

---

### `uploads`
Metadata for each extracted ZIP uploaded by the user (G2C: Gemini Takeout, CL2G: Claude export).

| Field | Type | Notes |
|---|---|---|
| `_id` | string | e.g. `upload_1234567890` |
| `appUserId` | string | |
| `fileName` | string | Original filename |
| `extractPath` | string | Absolute path on server disk |
| `uploadTime` | Date | |
| `totalUsers` | number | Users found in ZIP |
| `totalConversations` | number | (CL2G) |
| `status` | string | `'ready'` |

**Index:** `{ appUserId: 1, uploadTime: -1 }`.

Stale records (extractPath missing on disk) are auto-purged when `GET /api/uploads` is called.

---

### `migrationWorkspaces`
One document per migration run. Replaced the old `reportsWorkspace` collection.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | UUID (e.g. `3f8a...`) |
| `appUserId` | string | |
| `migDir` | string | Direction |
| `customerName` | string | Dest folder name |
| `startTime` | Date | |
| `endTime` | Date | |
| `status` | string | `'running'`, `'completed'`, `'failed'` |
| `dryRun` | boolean | |
| `totalUsers` | number | |
| `migratedUsers` | number | |
| `failedUsers` | number | |
| `migratedConversations` | number | Files/pages created |
| `totalErrors` | number | |
| `report` | object | Full per-user report (see below) |

`report` structure:
```json
{
  "summary": { "total_users": N, "total_pages_created": N, "total_errors": N },
  "users": [
    {
      "email": "source@example.com",
      "destEmail": "dest@example.com",
      "displayName": "Jane Smith",
      "status": "success" | "partial" | "failed",
      "pages_created": N,
      "conversations_processed": N,
      "error_count": N,
      "errors": [{ "error_message": "..." }]
    }
  ]
}
```

**Index:** `{ appUserId: 1, startTime: -1 }`.

---

### `migrationJobs`
One document per mapped user per migration run (live runs only — not created for dry runs).

| Field | Type | Notes |
|---|---|---|
| `jobId` | string | UUID — unique across all jobs |
| `workspaceId` | string | `migrationWorkspaces._id` |
| `appUserId` | string | |
| `migDir` | string | |
| `sourceEmail` | string | |
| `destEmail` | string | |
| `status` | string | `'pending'`, `'completed'`, `'failed'`, `'retried'` |
| `pages` | number | Files migrated |
| `errors` | array | Error messages |
| `startTime` | Date | null until job starts |
| `endTime` | Date | null until job ends |

**Indexes:**
- `{ workspaceId: 1, appUserId: 1 }`
- `{ jobId: 1 }` unique

---

### `cachedUsers`
Source and destination user lists fetched from Google/Microsoft directories, cached to avoid repeated API calls.

| Field | Type | Notes |
|---|---|---|
| `appUserId` | string | |
| `role` | string | `'source'` or `'dest'` |
| `migDir` | string | |
| `email` | string | |
| `displayName` | string | |

**Index:** `{ appUserId: 1, role: 1, migDir: 1 }`.

Used by `auto_map_users` tool.

---

### `conversationHistory`
Agent chat turns per user (persisted across sessions).

| Field | Type | Notes |
|---|---|---|
| `appUserId` | string | |
| `migDir` | string | |
| `role` | string | `'user'` or `'assistant'` |
| `content` | string | Message text |
| `createdAt` | Date | |

---

### `scheduledJobs`
Agent-created scheduled migration jobs.

| Field | Type | Notes |
|---|---|---|
| `appUserId` | string | |
| `migDir` | string | |
| `dryRun` | boolean | |
| `runAt` | Date | When to execute |
| `status` | string | `'scheduled'` |
| `createdAt` | Date | |

---

## localStorage (3 keys only)

localStorage is **not authoritative**. It is a warm-start cache cleared on user switch and browser reset.

| Key constant | Key string | Stores | Purpose |
|---|---|---|---|
| `LS_UPLOAD` | `gem_upload_cache` | `{ uploadId, fileName, size }` | Lightweight upload ref for UI restore |
| `LS_MAPPING` | `gem_mapping_cache` | `{ g2c: {...}, c2g: {...} }` | Mapping UI snapshot (MongoDB is authoritative) |
| `LS_PREFS` | `gem_ui_prefs` | `{ splitPct, panelSwapped, leftMode }` | Cosmetic panel preferences |

A hidden sentinel `gem_last_user` stores the last authenticated user ID. If a different user logs in, `lsClearAll()` wipes all `gem_*` keys before loading fresh state from `/api/init`.

**Never add new localStorage keys.** Extend the 3 allowed keys' payloads instead.

---

## Server Session (express-session)

Short-lived. Lost on server restart. Used only for:

| Field | What it holds |
|---|---|
| `req.session.appUser` | Logged-in user object (from MongoDB `users`) |
| `req.session.googleEmail` | Authenticated Google email |
| `req.session.msEmail` | Authenticated Microsoft email |
| `req.session.pendingAction` | Confirmation-pending tool call `{ tool, args }` |
| `req.session.agentConfig` | Config overrides set by the agent (`set_migration_config` tool) |
| `req.session._agentDeps` | Migration executor closures wired per-request |

Do not use the session to persist anything that survives a server restart — use MongoDB.

---

## Startup Sequence

```
connectMongo()
  └─ ensureIndexes(db)       ← creates all 7 indexes (idempotent)
  └─ restoreGoogleSessions() ← re-authenticates Google service accounts
  └─ restoreMsSessions()
  └─ app.listen(PORT)
```

---

## Init Endpoint (one-call hydration)

`GET /api/init` — called immediately after login. Returns:

```json
{
  "config":           <userConfig doc or null>,
  "mappings":         [<all userMappings docs for this user>],
  "recentWorkspaces": [<last 10 migrationWorkspaces>],
  "recentUploads":    [<last 5 uploads>]
}
```

All 4 queries run in `Promise.all`. UI uses this to restore state without multiple round-trips.

---

## Per-User Isolation Rule

Every MongoDB document that belongs to a user **must** have `appUserId: string` (the `.toString()` of `users._id`). Every query **must** filter by `appUserId`. No exceptions.

The string coercion is done by `getWorkspaceContext(req)` in routes and by:
```js
session?.appUser?._id?.toString() || session?.appUserId?.toString()
```
in `toolExecutor.js`. Always use `.toString()` — ObjectId comparisons will silently fail.
