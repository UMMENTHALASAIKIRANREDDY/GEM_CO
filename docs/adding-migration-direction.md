# Adding a New Migration Direction

Step-by-step reference for adding a new source→destination migration path to GEM CO.
Every section maps to an exact file and what to change.

---

## Example

Throughout this doc the new direction is used as an example:
**`teams-gemini`** — Microsoft Teams → Google Workspace

---

## 1. `src/agent/combinations.js`

Add an entry to the `COMBINATIONS` object.

```js
'teams-gemini': {
  label: 'Microsoft Teams → Google Workspace',
  auth: ['microsoft', 'google'],   // which providers are required
  hasUpload: false,                // true if user must upload a ZIP/file before mapping
  steps: ['Connect', 'Direction', 'Map Users', 'Options', 'Migration'],
  authCheck: (state) => {
    const blockers = [];
    if (!state.msAuthed)     blockers.push('Microsoft 365 not connected');
    if (!state.googleAuthed) blockers.push('Google Workspace not connected');
    return blockers;
  },
  // Pick a unique state key for mappings count (add it to migrationState in the UI)
  mappingsCount: (state) => state.t2g_mappings_count ?? 0,
  isLive:        (state) => !!state.t2g_live,
  isDone:        (state) => !!state.t2g_done,
},
```

**Rules:**
- `auth` drives the auth gate everywhere — list every provider the direction needs.
- `hasUpload: true` means step 2 is an upload step (like `claude-gemini`). `false` means step 2 is Map Users (like `copilot-gemini`).
- State keys (`t2g_mappings_count`, `t2g_live`, `t2g_done`, `t2g_stats`) must be unique across all directions. Use a short prefix (e.g. `t2g_`).

---

## 2. `src/agent/agentLoop.js`

### 2a. `defaultChips()` — quick reply suggestions

Add a block inside `defaultChips()` after the other direction blocks:

```js
if (migDir === 'teams-gemini') {
  if (step <= 1) return ['Map my users', 'How does this work?'];
  if (step === 2) return t2g_mappings_count > 0
    ? ['Review mappings', 'Go to options']
    : ['Auto-map my users', 'How do I map users?'];
  if (step === 3) return ['Run a dry run first', 'Go live now', 'What is a dry run?'];
  if (state.t2g_done) return ['Download report', 'Start another migration'];
}
```

Also add the new state keys to the destructured variables at the top of `defaultChips()`:

```js
const { ..., t2g_mappings_count = 0, t2g_done = false } = migrationState ?? {};
```

### 2b. `buildStepContextInstruction()` — auto-context messages

Add inside `buildStepContextInstruction()` after the last direction block:

```js
if (migDir === 'teams-gemini') {
  if (step === 2) return `\n\n[AUTO CONTEXT] Map Users step (Teams→Gemini). ${t2g_mappings_count} users mapped. ${t2g_mappings_count === 0 ? 'Suggest auto-mapping.' : 'Tell them to proceed to options.'}`;
  if (step === 3) return `\n\n[AUTO CONTEXT] Options step (Teams→Gemini). Recommend dry run first.`;
}
```

Add `t2g_mappings_count = 0` to the destructure at the top of `buildStepContextInstruction()`.

---

## 3. `src/agent/systemPrompt.js`

### 3a. Direction Recognition Rules

In `buildSystemPrompt()`, find `## Direction Recognition Rules` and add a line:

```
- "Teams to Google", "Microsoft Teams to Google", "T2G", "teams gemini" → migDir = "teams-gemini"
```

### 3b. Current State block

The existing code already reads direction-scoped stats from `migrationState` using the
`migDir` check. Add a case for the new direction:

```js
const activeStats = migDir === 'copilot-gemini' ? c2g_stats
  : migDir === 'claude-gemini' ? cl2g_stats
  : migDir === 'teams-gemini'  ? t2g_stats       // ← add
  : stats;

const activeLastDry = migDir === 'copilot-gemini' ? c2gLastDry
  : migDir === 'claude-gemini' ? cl2gLastDry
  : migDir === 'teams-gemini'  ? t2gLastDry       // ← add
  : lastRunWasDry;
```

Add `t2g_stats = {}, t2gLastDry = false` to the destructure at the top of `buildSystemPrompt()`.

### 3c. Auth Gate — `buildAuthGateSection()`

The function reads from `combinations.js` via `needsMs` check. If your new direction needs
Microsoft, add it:

```js
const needsMs = migDir === 'gemini-copilot' || migDir === 'copilot-gemini' || migDir === 'teams-gemini';
```

### 3d. `## Migration Directions` section — human-readable label

Add a bullet:

```
- **teams-gemini** → "Microsoft Teams to Google Workspace". Requires: Microsoft 365 + Google Workspace (both).
```

### 3e. `buildPanelContext()` — panel descriptions

Add a block describing each step's UI:

```js
if (migDir === 'teams-gemini') {
  if (step <= 1) return `PANEL: Connect/Direction setup for Teams→Gemini. MS365: ${msAuthed ? '✅' : '✗'}. Google: ${googleAuthed ? '✅' : '✗'}.`;
  if (step === 2) return `PANEL: "Map Users" (Microsoft Teams → Google)
- Table: Microsoft email (source) → Google Workspace email (destination)
- ${t2g_mappings_count} users mapped
- "Auto-map" button visible
- "Continue →": ${t2g_mappings_count > 0 ? 'ENABLED' : 'DISABLED'}`;
  if (step === 3) return `PANEL: "Migration Options" (Teams→Google)
- Folder name, dry run checkbox, date range fields
- Main button: "Start Dry Run" or "Start Migration"`;
  return `PANEL: Migration (T2G) ${state.t2g_live ? 'RUNNING 🔄' : state.t2g_done ? 'COMPLETE ✅' : 'status unknown'}
- Stats: ${(state.t2g_stats ?? {}).users ?? 0} users · ${(state.t2g_stats ?? {}).files ?? 0} files`;
}
```

---

## 4. `src/agent/tools.js`

The `select_direction` tool's `enum` must include the new key:

```js
migDir: {
  type: 'string',
  enum: ['gemini-copilot', 'copilot-gemini', 'claude-gemini', 'teams-gemini'],  // ← add
  description: '...'
}
```

---

## 5. `src/agent/toolExecutor.js`

### 5a. `pre_flight_check` case

Add upload/mapping check for the new direction if it has special rules:

```js
if (migDir === 'teams-gemini' && effectiveMappings === 0) {
  blockers.push('No users mapped');
}
```

### 5b. `get_migration_status` case

Add direction-scoped stats selection:

```js
const activeStats = dir === 'copilot-gemini' ? migrationState.c2g_stats
  : dir === 'claude-gemini'  ? migrationState.cl2g_stats
  : dir === 'teams-gemini'   ? migrationState.t2g_stats   // ← add
  : migrationState.stats;
```

### 5c. `start_migration` case

The executor calls `session._agentDeps.startMigration`. That function lives in
`src/modules/g2c/routes.js`. Add a branch for the new direction there (see §6).

---

## 6. `src/modules/<new-dir>/routes.js` — backend migration module

Create a new module folder (e.g. `src/modules/t2g/`) with:

- `routes.js` — Express router for `/api/t2g/*` endpoints
- `migration/migrate.js` — core migration logic

In `src/modules/g2c/routes.js` (the agent chat route), inside `startMigration`:

```js
if (dir === 'teams-gemini') {
  const mappingDoc = await db().collection('userMappings').findOne({ appUserId: uid, migDir: 'teams-gemini' });
  if (!mappingDoc || !Object.keys(mappingDoc.mappings || {}).length) return { error: 'No user mappings.' };
  return { validated: true, batchId, note: 'UI will start migration' };
}
```

Register the new router in `server.js`:

```js
import t2gRoutes from './src/modules/t2g/routes.js';
app.use('/api/t2g', requireSession, t2gRoutes);
```

---

## 7. `ui/index.html` — React state + UI panels

### 7a. New state keys

Add to the `useState` init and to the `migrationState` object sent to the agent:

```js
// State
const [t2gDone, setT2gDone]             = useState(false);
const [t2gLive, setT2gLive]             = useState(false);
const [t2gStats, setT2gStats]           = useState({});
const [t2gMappingsCount, setT2gMappingsCount] = useState(0);
const [t2gLastDry, setT2gLastDry]       = useState(false);

// migrationState object (sent to agent on every chat call)
const migrationState = {
  ...
  t2g_done: t2gDone,
  t2g_live: t2gLive,
  t2g_stats: t2gStats,
  t2g_mappings_count: t2gMappingsCount,
  t2gLastDry,
};
```

### 7b. Direction card in `StepDirection`

Add a new card button:

```jsx
<DirectionCard
  key="teams-gemini"
  id="teams-gemini"
  title="Teams → Gemini"
  description="Microsoft Teams conversations to Google Workspace"
  icon="⚙️"
  available={googleAuthed && msAuthed}
  selected={migDir === 'teams-gemini'}
  onSelect={() => handleDirectionSelect('teams-gemini')}
/>
```

### 7c. Upload/step panels

Add `StepUploadT2G` (if `hasUpload: true`) or skip straight to `StepMapUsersT2G`.
Follow the existing `StepMapUsersC2G` or `StepMapUsersCL2G` component as a template.

### 7d. SSE event handlers in `applyUIEvent`

Add live-run tracking:

```js
case 'migration_started':
  if (payload.migDir === 'teams-gemini') setT2gLive(true);
  break;
case 't2g_progress':
  setT2gStats(payload.stats ?? {});
  break;
case 't2g_done':
  setT2gLive(false);
  setT2gDone(true);
  setT2gStats(payload.stats ?? {});
  setT2gLastDry(payload.dryRun ?? true);
  break;
```

### 7e. `agentMigrationTrigger` useEffect

Add a branch that calls the correct run function:

```js
useEffect(() => {
  if (!agentMigrationTrigger) return;
  const { migDir: dir, dryRun } = agentMigrationTrigger;
  if (dir === 'teams-gemini') runT2gMigration(dryRun);
  // ... existing branches
}, [agentMigrationTrigger]);
```

### 7f. User-switch reset

In the user-switch `useEffect`, reset all new state:

```js
setT2gDone(false); setT2gLive(false); setT2gStats({}); setT2gMappingsCount(0); setT2gLastDry(false);
```

### 7g. DB workspace recovery (re-login restore)

In the `/api/init` callback, add a recovery block alongside the existing ones:

```js
const t2gWs = recentWorkspaces.find(w => w.migDir === 'teams-gemini' && w.status === 'done');
if (t2gWs) {
  setT2gDone(true);
  setT2gStats({ users: t2gWs.progressUsers, files: t2gWs.progressPages, errors: t2gWs.progressErrors });
}
```

---

## 8. MongoDB Collections

All collections are shared across directions — they use `migDir` as a scoping field.
No new collections are needed for a standard direction.

| Collection | Field used for scoping | What to verify |
|---|---|---|
| `userMappings` | `{ appUserId, migDir }` unique index | upsert with `migDir: 'teams-gemini'` |
| `migrationWorkspaces` | `migDir` field | read by `/api/init` for recovery |
| `migrationJobs` | `workspaceId + appUserId` | one doc per user per run |
| `migrationLogs` | `{ appUserId, batchId, ts }` | write logs with direction's batchId |
| `checkpoints` | `batchId` | created by migration engine |
| `authSessions` | `provider` (`'microsoft'` / `'google'`) | no change needed |
| `cachedUsers` | `{ appUserId, role, migDir }` | cache source/dest user lists per direction |

**If the new direction needs a file upload**, also write to:

| Collection | When to use |
|---|---|
| `uploads` | Generic ZIP upload (G2C uses this) |
| `cl2gUploads` | CL2G-specific upload metadata |
| `<dir>Uploads` | Create a new collection only if upload schema differs significantly |

**Adding a new collection** (only when truly needed):

1. Add `ensureCollections()` entry in `src/db/mongo.js`:
```js
if (!existing.has('t2gUploads')) await _db.createCollection('t2gUploads');
await _db.collection('t2gUploads').createIndex({ appUserId: 1, uploadTime: -1 });
```
2. Update the log message count at the bottom of `ensureCollections()`.

---

## 9. `src/agent/conversationHistory.js`

No changes needed — history is scoped by `appUserId` only. The `migDir` is context in
the conversation, not a separate history namespace.

---

## Checklist

Copy this when adding a new direction.

- [ ] `combinations.js` — new key, label, auth, steps, authCheck, mappingsCount, isLive, isDone
- [ ] `agentLoop.js` — defaultChips block, buildStepContextInstruction block, state destructure
- [ ] `systemPrompt.js` — direction recognition rule, activeStats/activeLastDry chain, buildAuthGateSection needsMs, Migration Directions bullet, buildPanelContext block
- [ ] `tools.js` — add migDir to select_direction enum
- [ ] `toolExecutor.js` — pre_flight_check branch, get_migration_status activeStats chain, startMigration validation branch
- [ ] `src/modules/<dir>/routes.js` — new Express router + migration logic
- [ ] `server.js` — register new router
- [ ] `ui/index.html` — useState keys, migrationState spread, direction card, step panels, SSE handlers, agentMigrationTrigger branch, user-switch reset, DB recovery block
- [ ] `src/db/mongo.js` — new collection only if upload schema differs; update log count
- [ ] Test: select direction → agent recognizes it, auth gate works, migration starts, stats display correctly, re-login recovers state
