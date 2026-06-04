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

  // ── OneNote functional check ────────────────────────────────────────────
  try {
    const { ok, status, data } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${userId}/onenote/notebooks?$top=1&$select=id`);
    if (ok) {
      out.push(passingCheck('dest.ms.onenote.accessible', 'OneNote accessible'));
    } else if (status === 404 || /not.*licen/i.test(data?.error?.message || '')) {
      out.push(blockerCheck(
        'dest.ms.onenote.no_access',
        'OneNote not accessible',
        `${destEmail} cannot access OneNote: ${data?.error?.message || `HTTP ${status}`}`,
        `Assign a Microsoft 365 plan that includes OneNote, or have the user open OneNote.com once to provision it.`
      ));
    } else {
      out.push(warningCheck(
        'dest.ms.onenote.lookup_failed',
        'OneNote accessible',
        `Could not verify OneNote: ${data?.error?.message || `HTTP ${status}`}`
      ));
    }
  } catch (e) {
    out.push(warningCheck('dest.ms.onenote.lookup_failed', 'OneNote accessible', e.message));
  }

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
 * Check if a notebook + section that the real migration would create already
 * exists. The pagesCreator (src/modules/g2c/pagesCreator.js) uses customerName
 * as the NOTEBOOK name, and `${customerName} Conversations` as the SECTION
 * inside it. We mirror that exact structure here so the dry-run check matches
 * reality — checking only sections globally misses notebook collisions and
 * also misses that the actual section name is different from the input.
 *
 * Returns warning (not blocker) — migration will append to existing section,
 * but user should know they're appending vs creating fresh.
 */
export async function checkOneNoteSectionAvailable(accessToken, destEmail, folderName) {
  if (!destEmail || !folderName) return [];
  const notebookName = folderName;
  const sectionName = `${folderName} Conversations`.slice(0, 46);
  const results = [];

  try {
    // 1. Look up notebook by name
    const safeNb = notebookName.replace(/'/g, "''");
    const { ok: nbOk, data: nbData } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(destEmail)}/onenote/notebooks?$filter=displayName eq '${safeNb}'`);
    if (!nbOk) {
      results.push(warningCheck(
        'dest.ms.notebook.lookup_failed',
        `Notebook "${notebookName}"`,
        'Could not query existing OneNote notebooks. The migration will still try to create one.'
      ));
      return results;
    }
    const notebooks = nbData?.value || [];
    if (notebooks.length === 0) {
      results.push(passingCheck('dest.ms.notebook.available', `Notebook "${notebookName}" will be created`));
      results.push(passingCheck('dest.ms.section.available', `Section "${sectionName}" will be created`));
      return results;
    }

    // 2. Notebook exists — warn that we'll append + look up section inside it
    const notebook = notebooks[0];
    results.push(warningCheck(
      'dest.ms.notebook.exists',
      `Notebook "${notebookName}" already exists`,
      `${destEmail} already has a OneNote notebook named "${notebookName}". Migration will append into it.`,
      `Rename in Migration Options if you want a fresh notebook.`,
      { notebookId: notebook.id, createdDateTime: notebook.createdDateTime }
    ));

    const safeSec = sectionName.replace(/'/g, "''");
    const { ok: secOk, data: secData } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(destEmail)}/onenote/notebooks/${notebook.id}/sections?$filter=displayName eq '${safeSec}'`);
    if (!secOk) {
      results.push(warningCheck(
        'dest.ms.section.lookup_failed',
        `Section "${sectionName}"`,
        'Could not query sections inside the existing notebook.'
      ));
      return results;
    }
    const sections = secData?.value || [];
    if (sections.length === 0) {
      results.push(passingCheck('dest.ms.section.available', `Section "${sectionName}" will be created inside "${notebookName}"`));
    } else {
      results.push(warningCheck(
        'dest.ms.section.exists',
        `Section "${sectionName}" already exists`,
        `Notebook "${notebookName}" already has a section "${sectionName}". New pages will be appended.`,
        `Rename in Migration Options for a fresh section.`,
        { sectionId: sections[0].id, createdDateTime: sections[0].createdDateTime }
      ));
    }
    return results;
  } catch (e) {
    return [warningCheck('dest.ms.section.lookup_failed', `Section "${sectionName}"`, e.message)];
  }
}

function humanBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
