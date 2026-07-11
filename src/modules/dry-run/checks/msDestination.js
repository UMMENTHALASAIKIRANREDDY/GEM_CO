/**
 * Microsoft 365 destination checks. Used by G2C, CL2C, C2C.
 *
 * Uses an app-only Graph token (client credentials). Caller must pass it in.
 * All errors caught and surfaced as warning/blocker checks.
 */

import {
  passingCheck, warningCheck, blockerCheck,
} from '../reportBuilder.js';

const COPILOT_SERVICE_PLAN_NAMES = new Set([
  'M365_COPILOT_BUSINESS',
  'M365_COPILOT',
  'Microsoft_365_Copilot',
  'COPILOT_FOR_M365',
]);

const ONEDRIVE_SERVICE_PLANS = new Set([
  'OFFICESUBSCRIPTION', 'SHAREPOINTWAC', 'WAC_WHITEBOARD', 'ONEDRIVE_BASIC',
  'ONEDRIVESTANDARD', 'SHAREPOINTSTANDARD', 'SHAREPOINTENTERPRISE',
]);

const ONENOTE_SERVICE_PLANS = new Set([
  'ONENOTE', 'OFFICESUBSCRIPTION', 'SHAREPOINTWAC',
]);

async function graphGet(accessToken, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export async function checkMsUserExists(accessToken, destEmail) {
  if (!destEmail) {
    return [blockerCheck('dest.ms.user.missing', 'Destination user', 'No destination email provided.')];
  }
  try {
    const { ok, status, data } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(destEmail)}?$select=id,displayName,accountEnabled,userPrincipalName`);
    if (!ok || !data?.id) {
      const msg = data?.error?.message || `HTTP ${status}`;
      return [blockerCheck(
        'dest.ms.user.missing',
        'Destination user exists',
        `No Microsoft 365 user found for ${destEmail}: ${msg}`,
        `Verify the email is correct, or create the user in Microsoft Admin Center.`
      )];
    }
    if (data.accountEnabled === false) {
      return [blockerCheck(
        'dest.ms.user.disabled',
        'Destination user active',
        `M365 user ${destEmail} is disabled.`,
        `Enable the account in Microsoft Admin Center.`
      )];
    }
    return [passingCheck(
      'dest.ms.user.exists',
      `Destination user ${destEmail}`,
      { id: data.id, name: data.displayName }
    )];
  } catch (e) {
    return [blockerCheck(
      'dest.ms.user.lookup_failed',
      `Destination user ${destEmail}`,
      `Could not verify M365 user exists: ${e.message}`,
      `Verify the app-only token has User.Read.All permission.`
    )];
  }
}

/**
 * Functional check — query the actual OneDrive + OneNote endpoints for the
 * user. If they respond, the user has effective access regardless of which
 * SKU name Microsoft assigned. This is the source of truth.
 *
 * Service-plan name matching is unreliable across tenants (E1/E3/E5/Business
 * Premium/Government/new Copilot bundles use different names), so we only
 * fall back to it if the functional check is inconclusive.
 */
export async function checkMsLicenses(accessToken, destEmail) {
  if (!destEmail) return [];

  const out = [];
  const userId = encodeURIComponent(destEmail);

  // ── OneDrive functional check ───────────────────────────────────────────
  try {
    const { ok, status, data } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${userId}/drive?$select=id`);
    if (ok && data?.id) {
      out.push(passingCheck('dest.ms.onedrive.provisioned', 'OneDrive provisioned'));
    } else if (status === 404) {
      out.push(blockerCheck(
        'dest.ms.onedrive.not_provisioned',
        'OneDrive not provisioned',
        `${destEmail} has no OneDrive drive.`,
        `Assign a Microsoft 365 plan that includes OneDrive (E1/E3/E5 or Business), then ask the user to sign in to OneDrive once. Provisioning can take ~15 min after license assignment.`
      ));
    } else {
      out.push(warningCheck(
        'dest.ms.onedrive.lookup_failed',
        'OneDrive provisioned',
        `Could not verify OneDrive: ${data?.error?.message || `HTTP ${status}`}`
      ));
    }
  } catch (e) {
    out.push(warningCheck('dest.ms.onedrive.lookup_failed', 'OneDrive provisioned', e.message));
  }

  // Phase 2 (OneNote -> DOCX): the OneNote accessibility check is removed.
  // Migration now writes a DOCX into the user's OneDrive (auto-provisioned
  // on first write). The OneDrive check above is the only gate that matters.

  return out;
}

/**
 * OneDrive provisioned + free space check.
 */
export async function checkOneDriveQuota(accessToken, destEmail, estimatedFiles = 0) {
  if (!destEmail) return [];
  try {
    const { ok, data } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(destEmail)}/drive?$select=quota`);
    if (!ok || !data?.quota) {
      return [warningCheck(
        'dest.ms.onedrive.unknown',
        'OneDrive quota',
        'Could not read OneDrive quota — the drive may not be provisioned yet.',
        `Ask the user to open OneDrive once (or wait ~15 min after license assignment).`
      )];
    }
    const free = Number(data.quota.remaining || 0);
    const needed = estimatedFiles * 80 * 1024;
    if (free < needed) {
      return [warningCheck(
        'dest.ms.onedrive.low',
        'OneDrive quota',
        `${humanBytes(free)} free but estimated migration needs ${humanBytes(needed)}.`,
        `Free up space or reduce migration scope.`,
        { free, needed }
      )];
    }
    return [passingCheck('dest.ms.onedrive.ok', 'OneDrive quota', { free, total: data.quota.total })];
  } catch (e) {
    return [warningCheck('dest.ms.onedrive.lookup_failed', 'OneDrive quota', e.message)];
  }
}

/**
 * Check if the destination folder tree that the real migration would create
 * already exists in the user's OneDrive. After Phase 2 (OneNote -> DOCX) the
 * migration creates:
 *
 *   {folderName}/
 *   ├── Conversations/             ← bundled DOCX(s)
 *   └── Migrated from {Source}/    ← attachment files
 *
 * Returns warnings (not blockers) — migration will reuse existing folders
 * (folder lookup is idempotent), but the user should know they're appending
 * to an existing layout vs creating fresh.
 *
 * @param {string} accessToken Delegated MS Graph token.
 * @param {string} destEmail   Destination user UPN.
 * @param {string} folderName  Top-level folder name (typically customerName).
 * @param {string} [sourceLabel='Gemini'] One of: Gemini / Copilot / Claude.
 */
export async function checkDestFolderAvailable(accessToken, destEmail, folderName, sourceLabel = 'Gemini') {
  if (!destEmail || !folderName) return [];
  const conversationsSubfolder = `${folderName}/Conversations`;
  const attachmentsSubfolder = `${folderName}/Migrated from ${sourceLabel}`;
  const results = [];

  try {
    // Look up the top folder at OneDrive root.
    const safeName = folderName.replace(/'/g, "''");
    const { ok, status, data } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(destEmail)}/drive/root:/${encodeURIComponent(folderName)}?$select=id,name,createdDateTime`);

    if (!ok && status === 404) {
      // Folder doesn't exist — fresh layout will be created.
      results.push(passingCheck('dest.ms.folder.available', `Folder "${folderName}" will be created`));
      results.push(passingCheck('dest.ms.folder.conversations.available', `Subfolder "${conversationsSubfolder}" will be created`));
      results.push(passingCheck('dest.ms.folder.attachments.available', `Subfolder "${attachmentsSubfolder}" will be created`));
      return results;
    }

    if (!ok) {
      results.push(warningCheck(
        'dest.ms.folder.lookup_failed',
        `Folder "${folderName}"`,
        `Could not query the destination folder: ${data?.error?.message || `HTTP ${status}`}. Migration will still try to create it.`
      ));
      return results;
    }

    // Folder exists — flag that we'll append, then look up its subfolders.
    results.push(warningCheck(
      'dest.ms.folder.exists',
      `Folder "${folderName}" already exists`,
      `${destEmail} already has a OneDrive folder named "${folderName}". Migration will append into it (any existing DOCX with the same filename will be auto-renamed by OneDrive).`,
      `Rename in Migration Options if you want a fresh folder.`,
      { folderId: data.id, createdDateTime: data.createdDateTime }
    ));

    // Probe each subfolder so the customer sees the full layout state.
    for (const [sub, kind, checkId] of [
      ['Conversations', 'conversations', 'dest.ms.folder.conversations'],
      [`Migrated from ${sourceLabel}`, 'attachments', 'dest.ms.folder.attachments'],
    ]) {
      const fullPath = `${folderName}/${sub}`;
      const { ok: subOk, status: subStatus } = await graphGet(accessToken,
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(destEmail)}/drive/root:/${encodeURIComponent(fullPath)}?$select=id`);
      if (!subOk && subStatus === 404) {
        results.push(passingCheck(`${checkId}.available`, `Subfolder "${fullPath}" will be created`));
      } else if (subOk) {
        results.push(warningCheck(
          `${checkId}.exists`,
          `Subfolder "${fullPath}" already exists`,
          `The ${kind} subfolder already exists. Migration will reuse it (idempotent).`
        ));
      }
    }
    return results;
  } catch (e) {
    return [warningCheck('dest.ms.folder.lookup_failed', `Folder "${folderName}"`, e.message)];
  }
}

/**
 * Backward-compat shim. The dry-run direction modules import this name; keep
 * it pointing at the new check until those callers are renamed in a follow-up.
 * @deprecated Use checkDestFolderAvailable directly.
 */
export const checkOneNoteSectionAvailable = checkDestFolderAvailable;

function humanBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
