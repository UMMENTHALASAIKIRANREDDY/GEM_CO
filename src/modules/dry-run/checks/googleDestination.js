/**
 * Google Workspace destination checks. Used by C2G, CL2G, G2G.
 *
 * Each function returns an array of CheckResult so direction validators can
 * concat them into a user pair report. All network errors are caught and
 * surfaced as blocker/warning checks — never thrown.
 */

import { google } from 'googleapis';
import {
  passingCheck, warningCheck, blockerCheck,
} from '../reportBuilder.js';
import {
  getServiceAccountAuth, SCOPES_DRIVE, SCOPES_LIST_USERS,
} from '../../c2g/googleService.js';

/**
 * Verify the destination user exists in Google Workspace via Admin SDK.
 */
export async function checkDestUserExists(destEmail) {
  if (!destEmail) {
    return [blockerCheck('dest.google.user.missing', 'Destination user', 'No destination email provided.')];
  }
  try {
    // Impersonate the dest user themselves; if account doesn't exist, JWT
    // request fails. We use the directory.user.readonly scope to just look
    // them up.
    const auth = getServiceAccountAuth(destEmail, SCOPES_LIST_USERS);
    const admin = google.admin({ version: 'directory_v1', auth });
    const r = await admin.users.get({ userKey: destEmail, projection: 'basic' });
    if (!r.data?.id) {
      return [blockerCheck(
        'dest.google.user.missing',
        'Destination user exists',
        `No Google user found for ${destEmail}.`,
        `Create the user in Google Admin Console, or change the destination email.`
      )];
    }
    if (r.data.suspended) {
      return [blockerCheck(
        'dest.google.user.suspended',
        'Destination user active',
        `Google user ${destEmail} is suspended.`,
        `Re-activate the user in Google Admin, or change the mapping.`
      )];
    }
    return [passingCheck(
      'dest.google.user.exists',
      `Destination user ${destEmail}`,
      { id: r.data.id, name: r.data.name?.fullName }
    )];
  } catch (e) {
    // Admin SDK often 403s ("Not Authorized to access this resource/api")
    // when the service account's DWD authorisation is missing the
    // directory.user.readonly scope. That's a common admin oversight and
    // shouldn't block migration — fall back to Drive about.get which only
    // needs the drive scope (already required for the actual migration).
    // If Drive call also succeeds, the user provably exists & is reachable.
    try {
      const driveAuth = getServiceAccountAuth(destEmail, SCOPES_DRIVE);
      const drive = google.drive({ version: 'v3', auth: driveAuth });
      const about = await drive.about.get({ fields: 'user(emailAddress,displayName)' });
      const emailAddr = about.data?.user?.emailAddress;
      if (emailAddr) {
        return [passingCheck(
          'dest.google.user.exists',
          `Destination user ${destEmail}`,
          { emailAddress: emailAddr, name: about.data.user.displayName, via: 'drive.about' }
        )];
      }
    } catch (driveErr) {
      // Both Admin SDK and Drive failed — surface a real blocker.
      return [blockerCheck(
        'dest.google.user.lookup_failed',
        `Destination user ${destEmail}`,
        `Could not verify user exists: ${driveErr.message}`,
        `Confirm the email is correct, and that the service account has Drive scope authorised in Domain-Wide Delegation for this Google Workspace.`
      )];
    }
    // Admin SDK failed but we didn't actually need it. Surface as a warning
    // so admins can still notice & fix DWD if they want directory scope.
    return [warningCheck(
      'dest.google.user.admin_sdk_unavailable',
      `Destination user ${destEmail}`,
      `Admin Directory API not authorised for this service account (${e.message}).`,
      `Optional: grant admin.directory.user.readonly DWD scope to enable suspension/profile checks. Migration will proceed regardless.`
    )];
  }
}

/**
 * Verify destination user's Drive has enough quota for the estimated migration.
 * Approximate: assumes ~80 KB per converted DOCX file (typical Copilot chat).
 */
export async function checkDriveQuota(destEmail, estimatedFiles = 0) {
  if (!destEmail) return [];
  try {
    const auth = getServiceAccountAuth(destEmail, SCOPES_DRIVE);
    const drive = google.drive({ version: 'v3', auth });
    const about = await drive.about.get({ fields: 'storageQuota' });
    const q = about.data?.storageQuota;
    if (!q) {
      return [warningCheck(
        'dest.google.quota.unknown',
        'Drive quota',
        `Could not read Drive quota for ${destEmail}.`,
        `Skip the quota check or check the user's Drive directly.`
      )];
    }
    const limit  = q.limit  ? Number(q.limit)  : null;   // null = unlimited
    const usage  = q.usage  ? Number(q.usage)  : 0;
    if (limit === null) {
      return [passingCheck('dest.google.quota.unlimited', 'Drive quota', { usage })];
    }
    const free = limit - usage;
    const needed = estimatedFiles * 80 * 1024; // 80 KB per file rough estimate
    if (free < needed) {
      return [warningCheck(
        'dest.google.quota.low',
        'Drive quota',
        `${humanBytes(free)} free in Drive but estimated migration needs ${humanBytes(needed)}.`,
        `Free up Drive space or reduce the number of users.`,
        { free, needed, estimatedFiles }
      )];
    }
    return [passingCheck('dest.google.quota.ok', 'Drive quota', { free, usage, limit })];
  } catch (e) {
    return [warningCheck(
      'dest.google.quota.lookup_failed',
      'Drive quota',
      `Could not check quota: ${e.message}`,
      `Verify Drive API is enabled and service account has drive scope in DWD.`
    )];
  }
}

/**
 * Check if a folder with the entered name already exists in the destination
 * user's Drive root. Warns the user before merging or overwriting happens.
 */
export async function checkFolderNameAvailable(destEmail, folderName) {
  if (!destEmail || !folderName) return [];
  try {
    const auth = getServiceAccountAuth(destEmail, SCOPES_DRIVE);
    const drive = google.drive({ version: 'v3', auth });
    const safe = folderName.replace(/'/g, "\\'");
    const r = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${safe}' and trashed=false and 'root' in parents`,
      fields: 'files(id, name, createdTime)',
      pageSize: 5,
    });
    const matches = r.data?.files || [];
    if (matches.length === 0) {
      return [passingCheck(
        'dest.google.folder.available',
        `Folder name "${folderName}"`,
        { destEmail }
      )];
    }
    return [warningCheck(
      'dest.google.folder.exists',
      `Folder name "${folderName}" already exists`,
      `${destEmail} already has a folder named "${folderName}" (created ${matches[0].createdTime}). New files will be added to that folder.`,
      `Rename the folder in Migration Options, OR enable "Append to existing folder" if that's intended.`,
      { existing: matches.map(f => ({ id: f.id, createdTime: f.createdTime })) }
    )];
  } catch (e) {
    return [warningCheck(
      'dest.google.folder.lookup_failed',
      `Folder name "${folderName}"`,
      `Could not check if folder exists: ${e.message}`
    )];
  }
}

function humanBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
