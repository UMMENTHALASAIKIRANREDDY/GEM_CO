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

export function getServiceAccountAuth(userEmail) {
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
      scopes: ['https://www.googleapis.com/auth/drive'],
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
    scopes: ['https://www.googleapis.com/auth/drive'],
    clientOptions: { subject: userEmail },
  });
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
