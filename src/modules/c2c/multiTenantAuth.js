/**
 * Multi-tenant token acquisition for C2C (Copilot → Copilot).
 *
 * Uses the SAME Azure app (client_id + client_secret) but acquires tokens for
 * different `tenantId` values, one per customer tenant that has granted admin
 * consent to the multi-tenant app.
 *
 * Tokens are cached in memory with an expiry buffer of 60s. The cache key is
 * `${tenantId}:${scope}` so source and destination tenants don't collide.
 */

import { getLogger } from '../../utils/logger.js';

const logger = getLogger('c2c:auth');

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// In-memory token cache: `${tenantId}:${scope}` → { access_token, expires_at }
const _tokenCache = new Map();

function _resolveClientCreds() {
  const clientId =
    process.env.C2C_AZURE_CLIENT_ID?.trim() ||
    process.env.SOURCE_AZURE_CLIENT_ID?.trim() ||
    process.env.AZURE_CLIENT_ID?.trim();
  const clientSecret =
    process.env.C2C_AZURE_CLIENT_SECRET?.trim() ||
    process.env.SOURCE_AZURE_CLIENT_SECRET?.trim() ||
    process.env.AZURE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing Azure app credentials. Set C2C_AZURE_CLIENT_ID + C2C_AZURE_CLIENT_SECRET ' +
      '(or fall back to SOURCE_AZURE_CLIENT_ID / SOURCE_AZURE_CLIENT_SECRET, ' +
      'or AZURE_CLIENT_ID / AZURE_CLIENT_SECRET).'
    );
  }
  return { clientId, clientSecret };
}

/**
 * Get an app-only access token for a specific tenant. Cached until ~60s before expiry.
 *
 * @param {string} tenantId  Customer tenant GUID
 * @param {string} [scope]   Default: Graph .default
 * @returns {Promise<string>} access_token
 */
export async function getTenantAccessToken(tenantId, scope = GRAPH_SCOPE) {
  if (!tenantId) throw new Error('tenantId required');

  const key = `${tenantId}:${scope}`;
  const cached = _tokenCache.get(key);
  const now = Date.now();

  if (cached && cached.expires_at - 60_000 > now) {
    return cached.access_token;
  }

  const { clientId, clientSecret } = _resolveClientCreds();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    grant_type: 'client_credentials',
  });

  const res = await fetch(TOKEN_URL(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error_description || data.error || res.statusText;
    logger.warn(`Token request for tenant ${tenantId} failed (${res.status}): ${msg}`);
    throw new Error(`Token request failed for tenant ${tenantId} (${res.status}): ${msg}`);
  }

  if (!data.access_token) {
    throw new Error(`Token response for tenant ${tenantId} missing access_token`);
  }

  const expiresInMs = (data.expires_in || 3600) * 1000;
  _tokenCache.set(key, {
    access_token: data.access_token,
    expires_at: now + expiresInMs,
  });

  return data.access_token;
}

/** Clear cache for one tenant (e.g. after revocation). */
export function clearTenantToken(tenantId) {
  for (const key of _tokenCache.keys()) {
    if (key.startsWith(`${tenantId}:`)) _tokenCache.delete(key);
  }
}

/** Clear the whole cache. */
export function clearAllTenantTokens() {
  _tokenCache.clear();
}

/**
 * Check whether the configured app has consent for a given tenant by attempting
 * to acquire a token. Returns { ok, error? }.
 */
export async function probeTenantConsent(tenantId) {
  try {
    await getTenantAccessToken(tenantId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Public summary for /api/c2c/settings (no secrets). */
export function readC2CAppSummary() {
  try {
    const { clientId } = _resolveClientCreds();
    return { configured: true, clientId };
  } catch {
    return { configured: false };
  }
}
