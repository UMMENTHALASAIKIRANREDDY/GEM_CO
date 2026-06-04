/**
 * Tenant admin consent helpers for C2C.
 *
 * Each customer tenant admin must grant admin consent ONCE to our multi-tenant
 * Azure app. After consent, the app can acquire app-only tokens for that tenant.
 *
 * Flow:
 *   1. UI: user clicks "+ Connect Microsoft Tenant" → opens consent popup
 *   2. Browser navigates to Microsoft's admin-consent URL (this module builds it)
 *   3. Admin signs in + clicks Accept
 *   4. Microsoft redirects to /auth/ms/tenant-consent-callback with `tenant` query param
 *   5. Callback handler stores tenantId in DB → tenant appears in connected list
 *
 * Note: admin-consent flow does NOT return tokens; we just learn the tenantId.
 * Tokens are then acquired on-demand via multiTenantAuth.getTenantAccessToken().
 */

import { getTenantAccessToken } from './multiTenantAuth.js';

const ADMIN_CONSENT_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId || 'common'}/adminconsent`;

function _resolveClientId() {
  // Must match the client_id used by multiTenantAuth.js — otherwise tenants
  // consent to one app and get re-prompted when we try to acquire app-only
  // tokens against a different one. Same reason we dropped the
  // SOURCE_AZURE_CLIENT_ID fallback (it pointed at the C2G source-reader
  // app, shown as "AllProjects" in the consent screen).
  const clientId =
    process.env.C2C_AZURE_CLIENT_ID?.trim() ||
    process.env.AZURE_CLIENT_ID?.trim();
  if (!clientId) throw new Error('AZURE_CLIENT_ID not configured.');
  return clientId;
}

/**
 * Build the URL the admin's browser should navigate to.
 * `state` is an opaque string we'll receive back to correlate the callback to a request.
 *
 * @param {object} opts
 * @param {string} opts.redirectUri  Absolute URL of our callback handler
 * @param {string} opts.state        Opaque correlation token (CSRF guard + appUserId carrier)
 * @param {string} [opts.tenantId]   Optional — if known, narrows to that tenant; otherwise 'common'
 * @returns {string}
 */
export function buildAdminConsentUrl({ redirectUri, state, tenantId, loginHint }) {
  const clientId = _resolveClientId();
  const u = new URL(ADMIN_CONSENT_URL(tenantId));
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  // Pre-select the admin's account so they don't have to choose from multiple
   // signed-in MS accounts in the browser (which can cause cross-tenant errors).
   if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

/**
 * Fetch tenant display name + verified domain after consent.
 * Uses the freshly-consented tenant's token to call /organization.
 *
 * @param {string} tenantId
 * @returns {Promise<{ displayName: string|null, defaultDomain: string|null }>}
 */
export async function fetchTenantInfo(tenantId) {
  try {
    const token = await getTenantAccessToken(tenantId);
    const res = await fetch('https://graph.microsoft.com/v1.0/organization', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { displayName: null, defaultDomain: null };
    const data = await res.json();
    const org = data.value?.[0];
    const verifiedDomain = (org?.verifiedDomains || []).find(d => d.isDefault) || org?.verifiedDomains?.[0];
    return {
      displayName: org?.displayName || null,
      defaultDomain: verifiedDomain?.name || null,
    };
  } catch {
    return { displayName: null, defaultDomain: null };
  }
}
