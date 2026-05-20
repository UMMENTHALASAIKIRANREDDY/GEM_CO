/**
 * Just-in-time site permission grant for C2C destination users.
 *
 * Microsoft's OneNote API rejects cross-user writes (e.g. granger writing to
 * alex's OneNote) unless the signed-in admin is a Site Collection Admin on
 * the target user's OneDrive personal site. Manually configuring this for
 * every destination user doesn't scale.
 *
 * Solution: before creating notebooks for a destination user, we call
 * SharePoint's tenant admin REST API to add the destination admin as a Site
 * Collection Admin on the target user's personal site. Uses the app-only
 * token from the `Sites.FullControl.All` (Application) permission.
 *
 * Why SharePoint REST and not Graph: Microsoft Graph's
 * `POST /sites/{id}/permissions` only supports granting permissions to apps,
 * not to users. The Site Collection Admin concept lives in SharePoint, not
 * Graph, so we must call SharePoint REST (which the same Sites.FullControl.All
 * permission also grants access to — different token scope, same app).
 *
 * Idempotent — if the admin is already site collection admin, the call is a
 * harmless re-assertion.
 */

import { getTenantAccessToken } from './multiTenantAuth.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('c2c:site-permissions');
const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Derive the SharePoint admin and personal URLs for a tenant from a OneDrive
 * site URL. Example:
 *   input:  https://trydemos-my.sharepoint.com/personal/harry_gajha_com
 *   output: { spRoot: "trydemos.sharepoint.com", admin: "trydemos-admin.sharepoint.com" }
 */
function _deriveSpHosts(personalSiteUrl) {
  const u = new URL(personalSiteUrl);
  // hostname like "trydemos-my.sharepoint.com" → root "trydemos.sharepoint.com"
  const host = u.hostname;
  const tenantSlug = host.replace(/-my\.sharepoint\.com$/i, '').replace(/\.sharepoint\.com$/i, '');
  return {
    spRoot: `${tenantSlug}.sharepoint.com`,
    admin: `${tenantSlug}-admin.sharepoint.com`,
  };
}

/**
 * Ensure the destination admin is a Site Collection Admin on the destination
 * user's OneDrive personal site.
 *
 * @param {object} opts
 * @param {string} opts.destTenantId   GUID of destination tenant
 * @param {string} opts.destUserId     GUID of destination user in dest tenant
 * @param {string} opts.destUserEmail  for log/error messages
 * @param {string} opts.adminUserId    GUID of destination admin in dest tenant (unused — SP REST uses loginName instead)
 * @param {string} opts.adminEmail     UPN/email of destination admin
 * @returns {Promise<{ status: 'granted' | 'skipped', reason?: string }>}
 */
export async function ensureAdminHasSiteAccess({
  destTenantId, destUserId, destUserEmail, adminEmail,
}) {
  if (!destTenantId || !destUserId || !adminEmail) {
    return { status: 'skipped', reason: 'missing required input' };
  }

  // 1. Look up the dest user's OneDrive site URL via Graph (app-only Graph token)
  const graphToken = await getTenantAccessToken(destTenantId);
  const driveRes = await fetch(
    `${GRAPH}/users/${encodeURIComponent(destUserId)}/drive?$select=webUrl,sharePointIds`,
    { headers: { Authorization: `Bearer ${graphToken}` } }
  );
  if (!driveRes.ok) {
    const err = await driveRes.text();
    throw new Error(`Cannot resolve OneDrive for ${destUserEmail}: ${driveRes.status} — ${err.slice(0, 200)}`);
  }
  const drive = await driveRes.json();
  const personalSiteUrl = drive.sharePointIds?.siteUrl || (drive.webUrl ? drive.webUrl.replace(/\/Documents\/?$/, '') : null);
  if (!personalSiteUrl) {
    throw new Error(`No personal site URL for ${destUserEmail}`);
  }

  const { spRoot, admin: spAdminHost } = _deriveSpHosts(personalSiteUrl);

  // 2. Acquire a SharePoint-scoped app-only token (same app, different resource scope).
  //    Sites.FullControl.All (Application) is honored by SharePoint REST too.
  const spScope = `https://${spRoot}/.default`;
  const spToken = await getTenantAccessToken(destTenantId, spScope);

  // 3. Call the tenant admin REST endpoint to set Site Collection Admin.
  //    Login name format: i:0#.f|membership|<upn>
  const loginName = `i:0#.f|membership|${adminEmail}`;
  const url = `https://${spAdminHost}/_api/SPO.Tenant/SetSiteAdmin`;
  const body = {
    siteUrl: personalSiteUrl,
    loginName,
    isSiteAdmin: true,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${spToken}`,
      Accept: 'application/json;odata=nometadata',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(
      `Cannot set site admin on ${destUserEmail}'s site: ${r.status} — ${err.slice(0, 400)}`
    );
  }

  logger.info(`Granted Site Collection Admin to ${adminEmail} on ${destUserEmail}'s OneDrive`);
  return { status: 'granted' };
}

/**
 * Resolve the admin's user GUID inside a specific tenant. Kept for backward
 * compatibility — adminUserId is no longer strictly required (SP REST uses
 * loginName/UPN), but resolving it confirms the admin actually exists in
 * the destination tenant before we attempt the grant.
 */
export async function resolveAdminUserIdInTenant(destTenantId, adminEmail) {
  if (!destTenantId || !adminEmail) return null;
  try {
    const token = await getTenantAccessToken(destTenantId);
    const r = await fetch(
      `${GRAPH}/users/${encodeURIComponent(adminEmail)}?$select=id`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.id || null;
  } catch (e) {
    logger.warn(`resolveAdminUserIdInTenant(${adminEmail} in ${destTenantId}) failed: ${e.message}`);
    return null;
  }
}
