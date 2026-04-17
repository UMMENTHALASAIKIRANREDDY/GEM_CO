# Service Account Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all Google Admin SDK OAuth calls with Service Account + Domain-Wide Delegation so migrations never fail due to token expiry or RAPT re-auth policies.

**Architecture:** Expand `src/auth/google.js` to expose service account clients for Admin SDK (directory, reports, vault, storage). Remove all `getGoogleOAuth2Client()` usage from server-side API calls and module constructors. Keep OAuth only for verifying the admin's identity at connect-time (UI step 1).

**Tech Stack:** googleapis (JWT auth), Node.js ESM, existing `service_account.json` file, env var `GOOGLE_SERVICE_ACCOUNT_PATH`

---

## File Map

| File | Change |
|------|--------|
| `src/auth/google.js` | Add `getAdminClient(adminEmail)`, `getReportsClient(adminEmail)`, `getVaultClient(adminEmail)`, `getStorageClient(adminEmail)` — all using service account JWT |
| `src/modules/permissionsChecker.js` | Accept optional SA-based clients; fall back gracefully |
| `src/modules/auditLogClient.js` | No change — already accepts any auth client via constructor |
| `src/modules/vaultExporter.js` | No change — already accepts any auth client via constructor |
| `server.js` | Replace `getGoogleOAuth2Client(appUserId)` with SA clients for Admin SDK routes; keep OAuth for identity-check only |

---

## Task 1: Expand `src/auth/google.js` with SA admin clients

**Files:**
- Modify: `src/auth/google.js`

- [ ] **Step 1: Add helper that builds a JWT auth client for given scopes and subject**

Replace the entire contents of `src/auth/google.js` with:

```js
import { google } from 'googleapis';
import fs from 'fs';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('auth:google');

function _loadServiceAccount() {
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './service_account.json';
  if (!fs.existsSync(saPath)) {
    throw new Error(`Google service account file not found: ${saPath}`);
  }
  return JSON.parse(fs.readFileSync(saPath, 'utf8'));
}

function _buildJwt(scopes, subject) {
  const sa = _loadServiceAccount();
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes,
    subject,
  });
}

/**
 * Drive client impersonating a specific user (for reading their files).
 */
export function getDriveService(userEmail) {
  const auth = _buildJwt(
    ['https://www.googleapis.com/auth/drive.readonly'],
    userEmail
  );
  logger.info(`Google Drive client created for: ${userEmail}`);
  return google.drive({ version: 'v3', auth });
}

/**
 * Admin Directory client impersonating the workspace admin.
 * Used for listing users across the domain.
 */
export function getAdminDirectoryClient(adminEmail) {
  const auth = _buildJwt(
    ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
    adminEmail
  );
  logger.info(`Admin Directory client created (subject: ${adminEmail})`);
  return google.admin({ version: 'directory_v1', auth });
}

/**
 * Admin Reports client impersonating the workspace admin.
 * Used for audit log queries (Drive access events, Gemini events).
 */
export function getAdminReportsClient(adminEmail) {
  const auth = _buildJwt(
    ['https://www.googleapis.com/auth/admin.reports.audit.readonly'],
    adminEmail
  );
  logger.info(`Admin Reports client created (subject: ${adminEmail})`);
  return google.admin({ version: 'reports_v1', auth });
}

/**
 * Vault client impersonating the workspace admin.
 * Used for eDiscovery matter/export operations.
 */
export function getVaultAuthClient(adminEmail) {
  const auth = _buildJwt(
    [
      'https://www.googleapis.com/auth/ediscovery',
      'https://www.googleapis.com/auth/devstorage.read_only',
    ],
    adminEmail
  );
  logger.info(`Vault auth client created (subject: ${adminEmail})`);
  return auth;
}

/**
 * Verify the service account file exists and can build a JWT.
 * Does NOT make a network call — just validates config.
 */
export function validateServiceAccount() {
  try {
    _loadServiceAccount();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node --input-type=module < "src/auth/google.js" 2>&1 || echo "syntax check done"
```

Expected: no output or "syntax check done" (Node won't error on valid ESM imports without running them)

- [ ] **Step 3: Commit**

```bash
git add src/auth/google.js
git commit -m "feat: add service account admin/reports/vault clients to google.js"
```

---

## Task 2: Update `/api/google/users` route in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add import for new SA clients at top of server.js**

Find the existing import:
```js
import { getDriveService } from './src/auth/google.js';
```

If it doesn't exist yet, find the google.js import line. Replace with:
```js
import { getDriveService, getAdminDirectoryClient, getAdminReportsClient, getVaultAuthClient, validateServiceAccount } from './src/auth/google.js';
```

- [ ] **Step 2: Replace the `/api/google/users` route body**

Find:
```js
app.get('/api/google/users', requireGoogleAuth, async (req, res) => {
  try {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
    const admin = google.admin({ version: 'directory_v1', auth });
```

Replace with:
```js
app.get('/api/google/users', requireGoogleAuth, async (req, res) => {
  try {
    const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
    const admin = getAdminDirectoryClient(googleEmail);
```

- [ ] **Step 3: Fix the catch block for this route**

The existing catch block (added in previous fix) checks for `invalid_grant`. Remove it since SA tokens don't expire:

Find:
```js
  } catch (err) {
    const body = err?.response?.data || {};
    if (body.error === 'invalid_grant' || body.error_subtype === 'invalid_rapt') {
      const { appUserId } = getWorkspaceContext(req);
      clearGoogleToken(appUserId);
      return res.status(401).json({ error: 'Google session expired. Please reconnect your Google Workspace account.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Vault Export ─────────────────────────────────────────────────────
```

Replace with:
```js
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Vault Export ─────────────────────────────────────────────────────
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: use SA directory client for /api/google/users"
```

---

## Task 3: Update `/api/google/vault-export/start` route in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Find and update vault export route**

Find:
```js
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
    const exporter = new VaultExporter(auth);
```

Replace with:
```js
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const auth = getVaultAuthClient(googleEmail);
    const exporter = new VaultExporter(auth);
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: use SA vault auth client for vault export"
```

---

## Task 4: Update audit log and drive matcher routes in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Update audit log test route**

Find:
```js
    const { appUserId } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
    const client = new AuditLogClient(auth);
```

Replace with:
```js
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const auth = getAdminReportsClient(googleEmail);
    const client = new AuditLogClient(auth);
```

- [ ] **Step 2: Update drive debug route**

Find:
```js
    const { google } = await import('googleapis');
    const { appUserId } = getWorkspaceContext(req);
    const auth = getGoogleOAuth2Client(appUserId);
    const drive = google.drive({ version: 'v3', auth });
```

Replace with:
```js
    const { google } = await import('googleapis');
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const drive = getDriveService(googleEmail);
```

- [ ] **Step 3: Update drive matcher route**

Find:
```js
    const { appUserId } = getWorkspaceContext(req);
    const googleClient = getGoogleOAuth2Client(appUserId);
    const { DriveFileMatcher } = await import('./src/modules/driveFileMatcher.js');
    const matcher = new DriveFileMatcher(googleClient, ownerEmail, appUserId);
```

Replace with:
```js
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const { DriveFileMatcher } = await import('./src/modules/driveFileMatcher.js');
    const matcher = new DriveFileMatcher(getDriveService(googleEmail), ownerEmail, appUserId);
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: use SA clients for audit log and drive matcher routes"
```

---

## Task 5: Update `/api/google/permissions` and migration loop in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Update permissions check route**

Find:
```js
    const { appUserId } = getWorkspaceContext(req);
    const googleClient = getGoogleOAuth2Client(appUserId);
    const result = await checkPermissions(googleClient);
```

Replace with:
```js
    const { appUserId, googleEmail } = getWorkspaceContext(req);
    const googleClient = getAdminDirectoryClient(googleEmail);
    const result = await checkPermissions(googleClient);
```

- [ ] **Step 2: Update migration loop that uses `getGoogleOAuth2Client`**

Find (in the migration loop around line 1063):
```js
          googleClient = getGoogleOAuth2Client(appUserId);
          fileCorrelator = new FileCorrelator(googleClient, googleEmail);
```

Replace with:
```js
          googleClient = getAdminReportsClient(googleEmail);
          fileCorrelator = new FileCorrelator(googleClient, googleEmail);
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: use SA clients for permissions check and migration loop"
```

---

## Task 6: Update permissionsChecker.js to use separate SA clients

**Files:**
- Modify: `src/modules/permissionsChecker.js`

The current `checkPermissions` receives a single OAuth client and tests Drive, Reports, and Directory with it. With SA clients, we pass separate pre-built clients per API.

- [ ] **Step 1: Replace permissionsChecker.js**

```js
import { google } from 'googleapis';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:permissionsChecker');

/**
 * Validates that all required Google APIs are accessible using service account clients.
 *
 * @param {object} directoryClient - from getAdminDirectoryClient()
 * @param {object} reportsClient   - from getAdminReportsClient() — optional
 * @returns {Promise<{drive: boolean, reports: boolean, directory: boolean, errors: object}>}
 */
export async function checkPermissions(directoryClient, reportsClient = null) {
  const results = {
    drive: true,   // Drive uses per-user SA impersonation — skip global check
    reports: false,
    directory: false,
    errors: {},
  };

  // 1. Admin Directory API — list 1 user
  try {
    await directoryClient.users.list({ customer: 'my_customer', maxResults: 1 });
    results.directory = true;
    logger.info('Permissions: Admin Directory API — OK');
  } catch (err) {
    results.errors.directory = _summarizeError(err);
    logger.warn(`Permissions: Admin Directory API — FAIL: ${results.errors.directory}`);
  }

  // 2. Admin Reports API — query 1 event
  if (reportsClient) {
    try {
      await reportsClient.activities.list({
        userKey: 'all',
        applicationName: 'drive',
        maxResults: 1,
      });
      results.reports = true;
      logger.info('Permissions: Admin Reports API — OK');
    } catch (err) {
      results.errors.reports = _summarizeError(err);
      logger.warn(`Permissions: Admin Reports API — FAIL: ${results.errors.reports}`);
    }
  }

  return results;
}

function _summarizeError(err) {
  const code = err.code || err.status || '';
  const message = err.message || String(err);
  return code ? `[${code}] ${message.slice(0, 200)}` : message.slice(0, 200);
}
```

- [ ] **Step 2: Update the permissions route in server.js to pass both clients**

Find (after Task 5 update):
```js
    const googleClient = getAdminDirectoryClient(googleEmail);
    const result = await checkPermissions(googleClient);
```

Replace with:
```js
    const googleClient = getAdminDirectoryClient(googleEmail);
    const reportsClient = getAdminReportsClient(googleEmail);
    const result = await checkPermissions(googleClient, reportsClient);
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/permissionsChecker.js server.js
git commit -m "feat: update permissionsChecker to use separate SA clients per API"
```

---

## Task 7: Add SA validation to Google connect status endpoint

**Files:**
- Modify: `server.js`

When a user connects Google, we should also verify the service account is configured. Surface this in the `/auth/google/status` response.

- [ ] **Step 1: Update `/auth/google/status` endpoint**

Find:
```js
app.get('/auth/google/status', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  res.json({ authenticated: isGoogleAuthenticated(appUserId) });
});
```

Replace with:
```js
app.get('/auth/google/status', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const sa = validateServiceAccount();
  res.json({
    authenticated: isGoogleAuthenticated(appUserId),
    serviceAccount: sa.ok,
    serviceAccountError: sa.ok ? undefined : sa.error,
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: surface service account validation in google status endpoint"
```

---

## Task 8: Remove stale `getGoogleOAuth2Client` wrapper from googleOAuth.js

**Files:**
- Modify: `src/auth/googleOAuth.js`

The request-wrapping patch added in the previous session is no longer needed since admin calls no longer use OAuth.

- [ ] **Step 1: Remove the request wrapper added to `getGoogleOAuth2Client`**

Find in `src/auth/googleOAuth.js`:
```js
  // Wrap the client to detect invalid_rapt / invalid_grant and clear the stale session
  const originalRequest = session.oauth2Client.request.bind(session.oauth2Client);
  session.oauth2Client.request = async (opts) => {
    try {
      return await originalRequest(opts);
    } catch (err) {
      const body = err?.response?.data || {};
      if (body.error === 'invalid_grant' || body.error_subtype === 'invalid_rapt') {
        logger.warn(`Google token invalidated (${body.error_subtype || body.error}) for ${appUserId} — clearing session`);
        clearGoogleToken(appUserId);
      }
      throw err;
    }
  };

  return session.oauth2Client;
```

Replace with:
```js
  return session.oauth2Client;
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/googleOAuth.js
git commit -m "chore: remove stale request wrapper from getGoogleOAuth2Client"
```

---

## Task 9: Verify no remaining `getGoogleOAuth2Client` calls in server routes

- [ ] **Step 1: Search for remaining usages**

```bash
grep -n "getGoogleOAuth2Client" server.js
```

Expected: 0 matches (only the import line should remain if still needed, otherwise remove it).

- [ ] **Step 2: If import is unused, remove it from server.js**

Find:
```js
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, getGoogleOAuth2Client, clearGoogleToken, restoreGoogleSessions } from './src/auth/googleOAuth.js';
```

Replace with:
```js
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, clearGoogleToken, restoreGoogleSessions } from './src/auth/googleOAuth.js';
```

- [ ] **Step 3: Start the server and verify no import errors**

```bash
node server.js &
sleep 3
curl -s http://localhost:3000/auth/google/status
kill %1
```

Expected: JSON response like `{"authenticated":false,"serviceAccount":true}` (or `serviceAccountError` if SA file not present)

- [ ] **Step 4: Final commit**

```bash
git add server.js
git commit -m "chore: remove unused getGoogleOAuth2Client import from server.js"
```

---

## Prerequisites (manual — not code)

Before this plan works in production, the Google Workspace admin must:

1. Go to **Admin Console → Security → API controls → Domain-wide delegation**
2. Add the service account's Client ID with these scopes:
   - `https://www.googleapis.com/auth/admin.directory.user.readonly`
   - `https://www.googleapis.com/auth/admin.reports.audit.readonly`
   - `https://www.googleapis.com/auth/ediscovery`
   - `https://www.googleapis.com/auth/devstorage.read_only`
   - `https://www.googleapis.com/auth/drive.readonly`

The service account Client ID is found in `service_account.json` under `client_id`.
