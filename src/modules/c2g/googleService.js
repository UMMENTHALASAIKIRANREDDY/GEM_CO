/**
 * Google Workspace helpers:
 *  - List users via Admin SDK (Directory API)
 *  - Create folders / upload files to a user's Drive via Service Account impersonation
 */

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";

// ── Admin SDK: list users ────────────────────────────────────────────

export async function listGoogleUsers(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const admin = google.admin({ version: "directory_v1", auth });
  const users = [];
  let pageToken;

  do {
    const res = await admin.users.list({
      customer: "my_customer",
      maxResults: 500,
      orderBy: "email",
      pageToken,
    });
    for (const u of res.data.users || []) {
      users.push({
        id: u.id,
        email: u.primaryEmail,
        name: u.name?.fullName || u.primaryEmail,
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return users;
}

// ── Service Account auth (domain-wide delegation) ────────────────────

function getServiceAccountKeyPath() {
  return (
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
    path.join(process.cwd(), "service_account.json")
  );
}

export function getServiceAccountAuth(userEmail, scopes = ['https://www.googleapis.com/auth/drive']) {
  // Priority 1: inline JSON in env var (base64 or raw) — works on cloud deployments
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (inlineJson) {
    let credentials;
    try {
      // Try raw JSON first, then base64-decoded
      try { credentials = JSON.parse(inlineJson); }
      catch { credentials = JSON.parse(Buffer.from(inlineJson, 'base64').toString('utf8')); }
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is set but could not be parsed as JSON or base64 JSON.');
    }
    return new GoogleAuth({
      credentials,
      scopes,
      clientOptions: { subject: userEmail },
    });
  }

  // Priority 2: file path
  const keyPath = getServiceAccountKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Service account key file not found at ${keyPath}. ` +
      `Either place service_account.json in the project root, set GOOGLE_SERVICE_ACCOUNT_KEY_FILE, ` +
      `or set GOOGLE_SERVICE_ACCOUNT_KEY_JSON with the JSON content (raw or base64).`
    );
  }
  return new GoogleAuth({
    keyFile: keyPath,
    scopes,
    clientOptions: { subject: userEmail },
  });
}

/**
 * Service-account auth scoped for Google Vault. Service account must have
 * domain-wide delegation enabled and the ediscovery scope authorized in
 * the customer's Workspace admin console. With DWD there's no admin-side
 * reauthentication required — the JWT we sign refreshes itself forever.
 */
export function getVaultServiceAccountAuth(adminEmail) {
  return getServiceAccountAuth(adminEmail, [
    'https://www.googleapis.com/auth/ediscovery',
    'https://www.googleapis.com/auth/devstorage.read_only',
  ]);
}

/**
 * Service-account scope sets. Each must be authorized in the customer's
 * Domain-Wide Delegation allowlist (admin.google.com → Security → API controls
 * → Manage Domain-wide Delegation). Google REJECTS the entire JWT request with
 * "unauthorized_client" if ANY requested scope is missing from the allowlist,
 * so we keep these sets as tight as possible per operation.
 */
export const SCOPES_LIST_USERS = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
];

export const SCOPES_DRIVE = [
  'https://www.googleapis.com/auth/drive',
];

export const SCOPES_DRIVE_READONLY = [
  'https://www.googleapis.com/auth/drive.readonly',
];

export const SCOPES_AUDIT_LOG = [
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
];

export const SCOPES_VAULT = [
  'https://www.googleapis.com/auth/ediscovery',
  'https://www.googleapis.com/auth/devstorage.read_only',
];

// Convenience superset for the full G2C / G2G migration pipeline which needs
// everything. Customers running these migrations must have all of these
// allow-listed; otherwise migration fails. List-users is split off because
// most customers haven't allow-listed Vault/Audit just to browse users.
export const ALL_SCOPES = [
  ...SCOPES_DRIVE,
  'https://www.googleapis.com/auth/drive.readonly',
  ...SCOPES_LIST_USERS,
  ...SCOPES_AUDIT_LOG,
  ...SCOPES_VAULT,
  'https://www.googleapis.com/auth/ediscovery.readonly',
];

/**
 * Get a service-account auth client impersonating the Google admin signed in
 * for (appUserId, accountId). Falls back to the first connected account if
 * accountId is omitted.
 *
 * This is the canonical replacement for getGoogleOAuth2Client() in any API
 * call path (Drive, Admin Directory, Reports, Vault, etc). User OAuth is
 * still used for the initial sign-in flow only — once we know which admin
 * connected, all subsequent API calls use this service-account auth, which
 * never expires and is immune to Google's reauthentication policy.
 *
 * Result: the user's "Sign-in expired" reauth banner never fires for these
 * downstream API operations.
 */
export async function getServiceAccountAuthForUser(appUserId, accountId = null, scopes = SCOPES_LIST_USERS) {
  const { getGoogleAccounts } = await import('../../core/auth/googleOAuth.js');
  const accounts = getGoogleAccounts(appUserId);
  if (!accounts || accounts.length === 0) {
    throw new Error('No Google account connected for this user. Sign in with Google first.');
  }
  const picked = accountId ? accounts.find(a => a.accountId === accountId) : accounts[0];
  if (!picked) {
    throw new Error(`Google account ${accountId} not connected. Sign in with this account first.`);
  }
  if (!picked.email) {
    throw new Error(`Google account ${accountId || '(default)'} has no email recorded. Reconnect required.`);
  }
  return getServiceAccountAuth(picked.email, scopes);
}

// ── Drive helpers ────────────────────────────────────────────────────

export async function createDriveFolder(auth, folderName, parentId) {
  const drive = google.drive({ version: "v3", auth });
  const metadata = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await drive.files.create({
    requestBody: metadata,
    fields: "id, name, webViewLink",
  });
  return res.data;
}

export async function uploadFileToDrive(
  auth,
  fileName,
  mimeType,
  content,
  parentFolderId
) {
  const drive = google.drive({ version: "v3", auth });
  const { Readable } = await import("node:stream");

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    media: {
      mimeType,
      body: Readable.from(Buffer.isBuffer(content) ? content : Buffer.from(content)),
    },
    fields: "id, name, webViewLink",
  });
  return res.data;
}
