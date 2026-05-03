# Storage Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MongoDB authoritative for all user data, reduce localStorage to 3 disposable cache keys, enforce per-user isolation across all collections.

**Architecture:** Each MongoDB document owned by one user via `appUserId`. New `migrationWorkspaces` + `migrationJobs` replace `reportsWorkspace`. Single `userMappings` collection replaces three. New `/api/init` loads all state in one call on login.

**Tech Stack:** Node.js ESM, MongoDB, Express, React (no build step)

**Spec:** `docs/superpowers/specs/2026-05-03-storage-isolation-design.md`

---

### Task 1: Consolidate userMappings collection + add userConfig collection

**Files:**
- Modify: `src/modules/g2c/routes.js`
- Modify: `src/modules/c2g/routes.js`
- Modify: `src/modules/cl2g/routes.js`
- Modify: `src/agent/toolExecutor.js`
- Modify: `server.js`

**What:** Replace `c2gUserMappings` and `cl2gUserMappings` collection references with `userMappings` (using `migDir` field). Add `userConfig` collection with GET/PUT `/api/config` endpoints in `server.js`.

- [ ] **Step 1: Update toolExecutor.js auto_map_users**

In `src/agent/toolExecutor.js`, the `auto_map_users` case currently writes to 3 different collections based on `migDir`. Replace with one collection:

```js
case 'auto_map_users': {
  if (!migDir) return { error: 'No direction selected' };
  try {
    const sourceUsers = await db.collection('cachedUsers')
      .find({ appUserId, role: 'source', migDir })
      .toArray();
    const destUsers = await db.collection('cachedUsers')
      .find({ appUserId, role: 'dest', migDir })
      .toArray();

    const destByEmail = new Map(destUsers.map(u => [u.email?.toLowerCase(), u]));
    const mappings = {};
    let matched = 0;
    for (const src of sourceUsers) {
      const dest = destByEmail.get(src.email?.toLowerCase());
      if (dest) { mappings[src.email] = dest.email; matched++; }
    }

    await db.collection('userMappings').updateOne(
      { appUserId, migDir },
      { $set: { mappings, updatedAt: new Date() } },
      { upsert: true }
    );

    streamEvent('refresh_mapping', {});
    return { matched, total: sourceUsers.length };
  } catch (e) {
    return { error: e.message };
  }
}
```

- [ ] **Step 2: Update g2c routes.js — user-mappings read/write**

In `src/modules/g2c/routes.js`, find all references to `userMappings` collection. Ensure every read/write includes `migDir: 'gemini-copilot'`. Find the `/user-mappings` POST route and update:

```js
router.post('/user-mappings', async (req, res) => {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  const { mappings, selectedUsers, customerName } = req.body;
  await db().collection('userMappings').updateOne(
    { appUserId, migDir: 'gemini-copilot' },
    { $set: { mappings, selectedUsers, customerName, googleEmail, msEmail, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});
```

Read route: filter by `{ appUserId, migDir: 'gemini-copilot' }`.

- [ ] **Step 3: Update c2g routes.js — replace c2gUserMappings**

In `src/modules/c2g/routes.js`, find all `c2gUserMappings` collection references. Replace with `userMappings` and add `migDir: 'copilot-gemini'` to every query/upsert.

- [ ] **Step 4: Update cl2g routes.js — replace cl2gUserMappings**

In `src/modules/cl2g/routes.js`, find all `cl2gUserMappings` collection references. Replace with `userMappings` and add `migDir: 'claude-gemini'` to every query/upsert.

- [ ] **Step 5: Add userConfig endpoints to server.js**

In `server.js`, after the `/api/workspace` routes, add:

```js
app.get('/api/config', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const cfg = await db().collection('userConfig').findOne({ appUserId });
  res.json(cfg || { tenantId: null, customerName: 'Gemini' });
});

app.put('/api/config', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const { tenantId, customerName } = req.body;
  await db().collection('userConfig').updateOne(
    { appUserId },
    { $set: { tenantId, customerName, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});
```

- [ ] **Step 6: Add unique index for userMappings**

In `server.js` or `src/db/mongo.js` where indexes are created, add:

```js
await db.collection('userMappings').createIndex(
  { appUserId: 1, migDir: 1 },
  { unique: true }
);
```

- [ ] **Step 7: Commit**

```bash
git add src/agent/toolExecutor.js src/modules/g2c/routes.js src/modules/c2g/routes.js src/modules/cl2g/routes.js server.js
git commit -m "feat(storage): consolidate userMappings + add userConfig collection and endpoints"
```

---

### Task 2: Add uploads appUserId + fix upload queries

**Files:**
- Modify: `src/modules/g2c/routes.js` (upload route)
- Modify: `src/modules/cl2g/routes.js` (upload route)
- Modify: `src/agent/toolExecutor.js` (upload query in start_migration)
- Modify: `src/modules/g2c/routes.js` (retry upload lookup)

**What:** Every upload document gets `appUserId`. Every upload query filters by `appUserId`.

- [ ] **Step 1: Add appUserId to g2c upload insert**

In `src/modules/g2c/routes.js`, find the `/upload` route where the upload document is inserted into `uploads` collection. Add `appUserId` from `getWorkspaceContext(req)`:

```js
await db().collection('uploads').insertOne({
  _id: uploadId,
  appUserId,                    // ADD THIS
  extractPath,
  totalUsers,
  totalConversations,
  uploadTime: new Date(),
});
```

- [ ] **Step 2: Add appUserId to cl2g upload insert**

Same fix in `src/modules/cl2g/routes.js` upload route.

- [ ] **Step 3: Fix upload queries in toolExecutor.js**

In `src/agent/toolExecutor.js`, `start_migration` case in routes.js `startMigration` closure, the upload lookup is:
```js
await db().collection('uploads').findOne({}, { sort: { uploadTime: -1 } })
```
This returns ANY user's upload. Fix to:
```js
await db().collection('uploads').findOne({ appUserId: uid }, { sort: { uploadTime: -1 } })
```

- [ ] **Step 4: Fix upload lookup in retry closure (routes.js)**

Same fix in the `retryMigration` closure in routes.js:
```js
const uploadDoc = await db().collection('uploads')
  .findOne({ appUserId: uid }, { sort: { uploadTime: -1 } });
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/g2c/routes.js src/modules/cl2g/routes.js src/agent/toolExecutor.js
git commit -m "fix(storage): scope uploads collection to appUserId on insert and all queries"
```

---

### Task 3: Replace reportsWorkspace with migrationWorkspaces + add migrationJobs

**Files:**
- Modify: `src/modules/g2c/routes.js` (runMigration, runRetry)
- Modify: `src/modules/c2g/routes.js`
- Modify: `src/modules/cl2g/routes.js`
- Modify: `src/agent/toolExecutor.js` (get_migration_status)
- Modify: `server.js` (add /api/workspaces, /api/jobs endpoints)

**What:** Replace `reportsWorkspace` with `migrationWorkspaces`. Create a `migrationJobs` document for each mapped user when a migration starts. Update job status as migration runs. Add API endpoints.

- [ ] **Step 1: Update runMigration in g2c routes.js to create workspace + jobs**

At the start of `runMigration`, replace the `reportsWorkspace` upsert with:

```js
const workspaceId = `ws_${batch_id}`;

// Create workspace document
await db().collection('migrationWorkspaces').insertOne({
  workspaceId,
  appUserId,
  migDir: 'gemini-copilot',
  status: 'running',
  dryRun: dry_run,
  tenantId: tenant_id,
  customerName: customer_name,
  extractPath: extract_path,
  stats: { users: 0, pages: 0, errors: 0 },
  startTime: new Date(),
  createdAt: new Date(),
});

// Create one job per mapped user
const jobIds = {};
for (const [sourceEmail, destEmail] of Object.entries(user_mappings)) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db().collection('migrationJobs').insertOne({
    jobId,
    workspaceId,
    appUserId,
    migDir: 'gemini-copilot',
    sourceEmail,
    destEmail,
    status: 'pending',
    pages: 0,
    errors: [],
    startTime: null,
    endTime: null,
  });
  jobIds[sourceEmail] = jobId;
}
```

- [ ] **Step 2: Update job status during migration loop**

In the per-user migration loop in `runMigration`, update job status:

```js
// Before processing user:
await db().collection('migrationJobs').updateOne(
  { jobId: jobIds[userEmail] },
  { $set: { status: 'running', startTime: new Date() } }
);

// After processing user (success):
await db().collection('migrationJobs').updateOne(
  { jobId: jobIds[userEmail] },
  { $set: { status: 'done', pages: pagesCreated, endTime: new Date() } }
);

// After processing user (failure):
await db().collection('migrationJobs').updateOne(
  { jobId: jobIds[userEmail] },
  { $set: { status: 'failed', errors: errorList, endTime: new Date() } }
);
```

- [ ] **Step 3: Update workspace stats + status on completion**

At end of `runMigration`, replace `reportsWorkspace` update with:

```js
await db().collection('migrationWorkspaces').updateOne(
  { workspaceId },
  { $set: {
    status: dry_run ? 'dry_done' : 'done',
    stats: { users: totalUsers, pages: totalPages, errors: totalErrors },
    endTime: new Date(),
  }}
);
```

- [ ] **Step 4: Update toolExecutor get_migration_status**

In `src/agent/toolExecutor.js`, update `get_migration_status` to query `migrationWorkspaces` instead of `reportsWorkspace`:

```js
case 'get_migration_status': {
  // ... existing state from migrationState ...
  if (currentBatchId) {
    try {
      dbStatus = await db.collection('migrationWorkspaces')
        .findOne({ workspaceId: `ws_${currentBatchId}`, appUserId });
    } catch (e) { logger.warn(`get_migration_status failed: ${e.message}`); }
  }
  // ...
}
```

- [ ] **Step 5: Add /api/workspaces and /api/jobs endpoints to server.js**

```js
// All migration runs for current user
app.get('/api/workspaces', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const workspaces = await db().collection('migrationWorkspaces')
    .find({ appUserId })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(workspaces);
});

// Jobs for a specific workspace run
app.get('/api/jobs/:workspaceId', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const jobs = await db().collection('migrationJobs')
    .find({ workspaceId: req.params.workspaceId, appUserId })
    .toArray();
  res.json(jobs);
});

// Retry a single failed job
app.post('/api/jobs/:jobId/retry', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const job = await db().collection('migrationJobs')
    .findOne({ jobId: req.params.jobId, appUserId });
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'failed') return res.status(400).json({ error: 'Job is not failed' });
  // Mark as retrying — actual re-run is triggered by agent via retry_failed tool
  await db().collection('migrationJobs').updateOne(
    { jobId: job.jobId },
    { $set: { status: 'retried', retriedAt: new Date() } }
  );
  res.json({ ok: true, job });
});
```

- [ ] **Step 6: Apply same workspace+jobs pattern to c2g and cl2g routes**

In `src/modules/c2g/routes.js` and `src/modules/cl2g/routes.js`, apply the same workspace+jobs creation pattern (with their respective `migDir` values).

- [ ] **Step 7: Commit**

```bash
git add src/modules/g2c/routes.js src/modules/c2g/routes.js src/modules/cl2g/routes.js src/agent/toolExecutor.js server.js
git commit -m "feat(storage): replace reportsWorkspace with migrationWorkspaces + migrationJobs per user"
```

---

### Task 4: Add /api/init endpoint (one-call state load on login)

**Files:**
- Modify: `server.js`

**What:** Single endpoint that returns everything the frontend needs on login: config, mappings for all 3 directions, latest workspace per direction, auth status.

- [ ] **Step 1: Add /api/init to server.js**

```js
app.get('/api/init', requireAuth, async (req, res) => {
  const { appUserId } = getWorkspaceContext(req);

  const [config, g2cMapping, c2gMapping, cl2gMapping, recentWorkspaces] = await Promise.all([
    db().collection('userConfig').findOne({ appUserId }),
    db().collection('userMappings').findOne({ appUserId, migDir: 'gemini-copilot' }),
    db().collection('userMappings').findOne({ appUserId, migDir: 'copilot-gemini' }),
    db().collection('userMappings').findOne({ appUserId, migDir: 'claude-gemini' }),
    db().collection('migrationWorkspaces')
      .find({ appUserId })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray(),
  ]);

  res.json({
    config: config || { tenantId: null, customerName: 'Gemini' },
    mappings: {
      'gemini-copilot': g2cMapping?.mappings || {},
      'copilot-gemini': c2gMapping?.mappings || {},
      'claude-gemini': cl2gMapping?.mappings || {},
    },
    recentWorkspaces,
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat(storage): add /api/init endpoint — loads all user state in one call on login"
```

---

### Task 5: Remove userWorkspace collection + localStorage cleanup

**Files:**
- Modify: `server.js` (remove /api/workspace GET/PUT)
- Modify: `ui/index.html` (replace localStorage state init with /api/init, keep only 3 localStorage keys)

**What:** Remove userWorkspace sync. Replace all localStorage state initialization with data from `/api/init`. Keep only `step`, `migDir`, `agentMsgs` in localStorage, namespaced by userId.

- [ ] **Step 1: Remove /api/workspace GET and PUT from server.js**

Delete the two `app.get('/api/workspace')` and `app.put('/api/workspace')` route handlers. They are replaced by `/api/init`.

- [ ] **Step 2: Update localStorage key constants in ui/index.html**

Find the `K` (keys) object near the top. Replace with user-namespaced keys — only 3 keys:

```js
const LS = (uid) => ({
  step:      `gem_${uid}_step`,
  migDir:    `gem_${uid}_migDir`,
  agentMsgs: `gem_${uid}_agent_msgs`,
});
```

Remove all other key definitions (`uploadData`, `config`, `mappings`, `selUsers`, `authG`, `authMs`, `logs`, `migDone`, `stats`, `lastDry`, `batchId`, `c2gMappings`, `c2gSelUsers`, etc.).

- [ ] **Step 3: Replace useState initializers in ui/index.html**

All `useState` initializers that currently read from `lsGet` must be replaced with simple defaults. Only `step`, `migDir`, `agentMsgs` read from localStorage:

```js
// KEEP — reads from localStorage cache
const [step, setStep] = useState(() => lsGet(LS(storedUid).step, 0));
const [migDir, setMigDir] = useState(() => lsGet(LS(storedUid).migDir, null));
const [agentMsgs, setAgentMsgs] = useState(() => lsGet(LS(storedUid).agentMsgs, []));

// CHANGE — all these start empty, populated from /api/init
const [mappings, setMappings] = useState({});
const [c2gMappings, setC2gMappings] = useState({});
const [cl2gMappings, setCl2gMappings] = useState({});
const [config, setConfig] = useState({ tenantId: null, customerName: 'Gemini' });
const [uploadData, setUploadData] = useState(null);
const [migDone, setMigDone] = useState(false);
const [stats, setStats] = useState({ users: 0, pages: 0, errors: 0 });
const [currentBatchId, setCurrentBatchId] = useState(null);
const [lastRunWasDry, setLastRunWasDry] = useState(false);
const [selectedUsers, setSelectedUsers] = useState(new Set());
```

- [ ] **Step 4: Replace /api/workspace hydration with /api/init in ui/index.html**

Find the `useEffect` that calls `/api/me` then `/api/workspace`. Replace the workspace fetch with `/api/init`:

```js
useEffect(() => {
  fetch('/api/me').then(r => {
    if (!r.ok) { window.location.href = '/login.html'; return null; }
    return r.json();
  }).then(u => {
    if (!u) return;
    setAppUser(u);

    // User switch: clear localStorage + React state
    const storedUid = localStorage.getItem('gem_active_user') || '';
    if (storedUid && storedUid !== u._id) {
      Object.values(LS(storedUid)).forEach(k => localStorage.removeItem(k));
      setAgentMsgs([]);
      greetedRef.current = false;
    }
    localStorage.setItem('gem_active_user', u._id);

    // Load all state from DB in one call
    fetch('/api/init').then(r => r.ok ? r.json() : null).then(init => {
      if (!init) return;
      if (init.config) {
        setConfig({ tenantId: init.config.tenantId || null, customerName: init.config.customerName || 'Gemini' });
      }
      if (init.mappings) {
        setMappings(init.mappings['gemini-copilot'] || {});
        setC2gMappings(init.mappings['copilot-gemini'] || {});
        setCl2gMappings(init.mappings['claude-gemini'] || {});
      }
      // Latest workspace state
      const latest = init.recentWorkspaces?.[0];
      if (latest) {
        if (latest.stats) setStats(latest.stats);
        if (latest.status === 'done' || latest.status === 'dry_done') setMigDone(true);
        if (latest.workspaceId) setCurrentBatchId(latest.workspaceId);
        if (latest.dryRun === false && latest.status === 'done') setLastRunWasDry(false);
      }
    });
  });
}, []);
```

- [ ] **Step 5: Remove all lsSet calls for removed keys**

Search for `lsSet` in `ui/index.html`. Remove any `lsSet` call for keys that no longer exist (`mappings`, `config`, `migDone`, `stats`, `batchId`, `lastDry`, `uploadData`, `selUsers`, `authG`, `authMs`, `logs`, `c2gMappings`, etc.). Keep only lsSet calls for `step`, `migDir`, `agentMsgs`.

- [ ] **Step 6: Update config save — PUT /api/config instead of lsSet**

When the user changes `config.tenantId` or `config.filePath`, instead of just writing to localStorage, also POST to `/api/config`:

```js
// When config changes (useEffect on config):
useEffect(() => {
  fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: config.tenantId, customerName: config.filePath || 'Gemini' }),
  }).catch(() => {});
}, [config.tenantId, config.filePath]);
```

- [ ] **Step 7: Commit**

```bash
git add server.js ui/index.html
git commit -m "feat(storage): remove userWorkspace, reduce localStorage to 3 namespaced keys, load state from /api/init"
```

---

### Task 6: Add migrationWorkspaces + migrationJobs indexes to db setup

**Files:**
- Modify: `src/db/mongo.js` (or wherever indexes are created)

**What:** Add indexes for all new collections to ensure query performance and uniqueness.

- [ ] **Step 1: Read src/db/mongo.js**

Read the file to understand the current index setup pattern.

- [ ] **Step 2: Add indexes**

Add to the index creation section:

```js
// userMappings — unique per user per direction
await db.collection('userMappings').createIndex(
  { appUserId: 1, migDir: 1 }, { unique: true }
);

// migrationWorkspaces — list by user, sort by date
await db.collection('migrationWorkspaces').createIndex({ appUserId: 1, createdAt: -1 });

// migrationJobs — lookup by workspace, lookup by jobId
await db.collection('migrationJobs').createIndex({ workspaceId: 1, appUserId: 1 });
await db.collection('migrationJobs').createIndex({ jobId: 1 }, { unique: true });

// uploads — scoped to user
await db.collection('uploads').createIndex({ appUserId: 1, uploadTime: -1 });

// userConfig — unique per user
await db.collection('userConfig').createIndex({ appUserId: 1 }, { unique: true });
```

- [ ] **Step 3: Commit**

```bash
git add src/db/mongo.js
git commit -m "feat(storage): add indexes for migrationWorkspaces, migrationJobs, userMappings, uploads, userConfig"
```
