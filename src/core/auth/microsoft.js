import { ConfidentialClientApplication } from '@azure/msal-node';
import { getDb } from '../../db/mongo.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('auth:microsoft');

// Delegated permission scopes — only what this tool actually uses:
// - User.Read.All        → list M365 users (Step 2)
// - Notes.ReadWrite.All  → create OneNote pages per user (Step 4 core)
// - Files.ReadWrite.All  → upload files to OneDrive (Drive migration)
// - AppCatalog.ReadWrite.All → publish declarative agent to Teams catalog
const DELEGATED_SCOPES = [
  'https://graph.microsoft.com/User.Read.All',
  'https://graph.microsoft.com/User.ReadWrite.All',
  'https://graph.microsoft.com/Notes.ReadWrite.All',
  'https://graph.microsoft.com/Files.ReadWrite.All',
  'https://graph.microsoft.com/AppCatalog.ReadWrite.All',
];

// Multi-account session map: `${appUserId}:${accountId}` → session
const _sessions = new Map();

function _key(appUserId, accountId) {
  return `${appUserId}:${accountId}`;
}

function _createMsalApp(tenantId) {
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/common`
    }
  });
}

/**
 * Get the authorization URL for adding a new Microsoft account.
 * Returns the auth URL — accountId (UUID) is encoded in state.
 */
export async function getAuthUrl(tenantId, appUserId) {
  const { randomUUID } = await import('crypto');
  const accountId = randomUUID();
  const msalApp = _createMsalApp(tenantId);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  const state = Buffer.from(JSON.stringify({ appUserId, tenantId, accountId })).toString('base64');
  const url = await msalApp.getAuthCodeUrl({
    scopes: DELEGATED_SCOPES,
    redirectUri: `${baseUrl}/auth/callback`,
    // 'select_account' shows Microsoft's account picker even when the browser
    // is already signed into one account — required so "+ Add Another" can
    // actually add a SECOND tenant for C2C migration.
    prompt: 'select_account',
    state,
  });
  // Pre-register session slot so callback can find it
  _sessions.set(_key(appUserId, accountId), { msalApp, tenant: tenantId, token: null, tokenExpiry: 0, account: null, accountId, email: null, displayName: null });
  return url;
}

/**
 * Exchange authorization code for a delegated access token.
 * Decodes appUserId + tenantId from state parameter.
 */
export async function acquireTokenByCode(code, stateParam) {
  let appUserId = null, tenantId = null, accountId = null;
  try {
    const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf8'));
    appUserId = decoded.appUserId;
    tenantId = decoded.tenantId;
    accountId = decoded.accountId;
  } catch {
    throw new Error('Invalid state parameter in Microsoft OAuth callback');
  }

  if (!accountId) {
    const { randomUUID } = await import('crypto');
    accountId = randomUUID();
  }

  const key = _key(appUserId, accountId);
  const existing = _sessions.get(key);
  const msalApp = existing?.msalApp || _createMsalApp(tenantId);


  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  const result = await msalApp.acquireTokenByCode({
    scopes: DELEGATED_SCOPES,
    redirectUri: `${baseUrl}/auth/callback`,
    code
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire delegated token');
  }

  const tokenExpiry = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600000;
  const email = result.account?.username || null;
  const displayName = result.account?.name || null;

  // Deduplicate: if this email is already in another session, merge into it
  if (email) {
    for (const [existingKey, existingSession] of _sessions.entries()) {
      if (existingKey === key) continue;
      if (!existingKey.startsWith(`${appUserId}:`)) continue;
      if (existingSession.email === email) {
        existingSession.token = result.accessToken;
        existingSession.tokenExpiry = tokenExpiry;
        existingSession.account = result.account || existingSession.account;
        _sessions.delete(key);
        try { const db = getDb(); db.collection('authSessions').deleteOne({ appUserId, provider: 'microsoft', accountId }).catch(() => {}); } catch {}
        logger.info(`MS: ${email} already connected for ${appUserId} — refreshed existing session ${existingSession.accountId}`);
        return { ...result, email, displayName, accountId: existingSession.accountId, alreadyConnected: true };
      }
    }
  }

  // Resolve the user's REAL home tenant from the MSAL account (account.tenantId
   // is set after acquireTokenByCode; fall back to id-token claims / homeAccountId).
   const acct = result.account || {};
   let realTenantId = acct.tenantId || acct?.idTokenClaims?.tid || null;
   if (!realTenantId && typeof acct.homeAccountId === 'string') {
     const parts = acct.homeAccountId.split('.');
     if (parts.length === 2 && parts[1].length > 8) realTenantId = parts[1];
   }

   _sessions.set(key, {
    msalApp,
    tenant: realTenantId || tenantId,
    token: result.accessToken,
    tokenExpiry,
    account: result.account || null,
    accountId,
    email,
    displayName,
  });

  logger.info(`Delegated token acquired for ${appUserId}:${accountId} (${email}) — expires: ${result.expiresOn}`);

  let msalCache = null;
  try { msalCache = msalApp.getTokenCache().serialize(); } catch {}

  try {
    const db = getDb();
    await db.collection('authSessions').updateOne(
      { appUserId, provider: 'microsoft', accountId },
      { $set: {
        email, displayName, provider: 'microsoft', accountId, tenantId,
        accessToken: result.accessToken, tokenExpiry, msalCache,
        connectedAt: new Date(), lastRefreshed: new Date()
      } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn(`Failed to persist Microsoft authSession for ${appUserId}:${accountId}: ${e.message}`);
  }

  return { ...result, email, displayName, accountId, realTenantId };
}

/**
 * Verify that the C2C multi-tenant Azure app has admin-consent in the given
 * tenant. Returns true if an app-only token works AND a basic Graph call succeeds.
 *
 * Critically uses `getTenantAccessToken` from c2c/multiTenantAuth.js — that
 * helper resolves the SAME client_id used by the admin-consent URL builder
 * (`SOURCE_AZURE_CLIENT_ID` / `C2C_AZURE_CLIENT_ID`), so a tenant consented
 * via /adminconsent will register as "consented" here too. Do NOT switch this
 * back to process.env.AZURE_CLIENT_ID — that's the delegated-OAuth app and
 * may be a different registration.
 */
export async function verifyAppOnlyAccess(tenantId) {
  if (!tenantId || tenantId === 'common' || tenantId === 'organizations') return false;
  try {
    const { getTenantAccessToken } = await import('../../modules/c2c/multiTenantAuth.js');
    const token = await getTenantAccessToken(tenantId);
    if (!token) return false;
    // Inspect the token's `roles` claim — this is the authoritative list of
    // application permissions the tenant has consented for our app. Probing a
    // single endpoint (e.g. /users) only tells us about ONE permission; an admin
    // could have consented to User.Read.All but not Notes.ReadWrite.All, in
    // which case the migration would still fail later. So require BOTH.
    const requiredRoles = ['User.Read.All', 'Notes.ReadWrite.All', 'Files.ReadWrite.All'];
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    let claims;
    try {
      const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
      claims = JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
    } catch { return false; }
    const tokenRoles = new Set(claims.roles || []);
    const missing = requiredRoles.filter(r => !tokenRoles.has(r));
    if (missing.length > 0) {
      logger.info(`verifyAppOnlyAccess(${tenantId}) — missing roles: ${missing.join(', ')} (granted: ${[...tokenRoles].join(', ') || 'none'})`);
      return false;
    }
    return true;
  } catch (e) {
    logger.info(`verifyAppOnlyAccess(${tenantId}) — not yet consented: ${e.message}`);
    return false;
  }
}

/**
 * Get a valid delegated token, refreshing silently if it expires within 5 minutes.
 */
/**
 * Get a valid token for any connected MS account (first available).
 * Pass accountId to target a specific account.
 */
export async function getValidToken(appUserId, accountId = null) {
  const session = accountId
    ? _sessions.get(_key(appUserId, accountId))
    : _getFirstSession(appUserId);

  if (!session?.token) {
    throw new Error('Admin not signed in. Click "Sign in with Microsoft" first.');
  }

  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < session.tokenExpiry - fiveMinutes) return session.token;

  if (!session?.account) {
    throw new Error('Admin not signed in. Click "Sign in with Microsoft" first.');
  }

  logger.info(`Delegated token expiring soon for ${appUserId}:${session.accountId} — refreshing silently`);
  try {
    const result = await session.msalApp.acquireTokenSilent({ scopes: DELEGATED_SCOPES, account: session.account });
    session.token = result.accessToken;
    session.tokenExpiry = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600000;
    session.account = result.account || session.account;
    let msalCache = null;
    try { msalCache = session.msalApp.getTokenCache().serialize(); } catch {}
    try {
      const db = getDb();
      await db.collection('authSessions').updateOne(
        { appUserId, provider: 'microsoft', accountId: session.accountId },
        { $set: { accessToken: result.accessToken, tokenExpiry: session.tokenExpiry, msalCache, lastRefreshed: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      logger.warn(`Failed to persist refreshed MS token for ${appUserId}:${session.accountId}: ${e.message}`);
    }
    return session.token;
  } catch (err) {
    logger.warn(`Silent token refresh failed for ${appUserId}:${session.accountId}: ${err.message}`);
    session.token = null;
    session.tokenExpiry = 0;
    throw new Error('Session expired. Please sign in with Microsoft again.');
  }
}

function _getFirstSession(appUserId) {
  for (const [key, session] of _sessions.entries()) {
    if (key.startsWith(`${appUserId}:`) && (session.account || session.token)) return session;
  }
  return null;
}

/**
 * Check if user has at least one connected Microsoft account.
 */
export function isAuthenticated(appUserId) {
  for (const [key, session] of _sessions.entries()) {
    if (!key.startsWith(`${appUserId}:`)) continue;
    if (session.account) return true;
    if (session.token && Date.now() < session.tokenExpiry) return true;
  }
  return false;
}

/**
 * Get all connected Microsoft accounts for a user.
 *
 * `tenantId` returned here is the user's REAL home-tenant GUID (from the MSAL
 * `account` object — `account.tenantId` or parsed from `homeAccountId`).
 * Session.tenant (the OAuth input tenant) is often `common`/`organizations` for
 * multi-tenant apps and is NOT suitable as a tenant identifier.
 */
export function getMsAccounts(appUserId) {
  const accounts = [];
  for (const [key, session] of _sessions.entries()) {
    if (!key.startsWith(`${appUserId}:`)) continue;
    if (!session.account && !session.token) continue;
    // Resolve the user's actual home tenant in order of preference:
    //  1. account.tenantId (MSAL standard)
    //  2. account.idTokenClaims.tid
    //  3. utid portion of homeAccountId ("uid.utid")
    //  4. session.tenant (fallback — may be 'common' for multi-tenant apps)
    const acct = session.account || {};
    let realTenant = acct.tenantId || acct?.idTokenClaims?.tid || null;
    if (!realTenant && typeof acct.homeAccountId === 'string') {
      const parts = acct.homeAccountId.split('.');
      if (parts.length === 2 && parts[1].length > 8) realTenant = parts[1];
    }
    accounts.push({
      accountId: session.accountId,
      email: session.email || null,
      displayName: session.displayName || null,
      tenantId: realTenant || session.tenant || null,
    });
  }
  return accounts;
}

/**
 * Return the tenant ID for the first connected MS account (backward compat).
 */
export async function getTenantForUser(appUserId) {
  const session = _getFirstSession(appUserId);
  if (session?.tenant) return session.tenant;
  try {
    const db = getDb();
    const doc = await db.collection('authSessions').findOne({ appUserId, provider: 'microsoft' }, { projection: { tenantId: 1 } });
    return doc?.tenantId || null;
  } catch { return null; }
}

/**
 * Disconnect a specific Microsoft account.
 */
export function clearMsAccount(appUserId, accountId) {
  const key = _key(appUserId, accountId);
  _sessions.delete(key);
  try {
    const db = getDb();
    db.collection('authSessions').deleteOne({ appUserId, provider: 'microsoft', accountId }).catch(() => {});
  } catch {}
}

/**
 * Disconnect ALL Microsoft accounts (backward compat).
 */
export function clearMsToken(appUserId) {
  const toDelete = [];
  for (const key of _sessions.keys()) {
    if (key.startsWith(`${appUserId}:`)) toDelete.push(key);
  }
  toDelete.forEach(k => _sessions.delete(k));
  try {
    const db = getDb();
    db.collection('authSessions').deleteMany({ appUserId, provider: 'microsoft' }).catch(() => {});
  } catch {}
}

export async function restoreMsSessions() {
  try {
    const db = getDb();
    const docs = await db.collection('authSessions').find({ provider: 'microsoft' }).toArray();
    for (const doc of docs) {
      if (!doc.appUserId || !doc.tenantId) continue;
      const accountId = doc.accountId || doc.appUserId; // fallback for old records
      const msalApp = _createMsalApp(doc.tenantId);
      if (doc.msalCache) {
        try { msalApp.getTokenCache().deserialize(doc.msalCache); } catch {}
      }
      let account = null;
      try {
        const cache = await msalApp.getTokenCache().getAllAccounts();
        account = cache[0] || null;
      } catch {}
      _sessions.set(_key(doc.appUserId, accountId), {
        msalApp,
        tenant: doc.tenantId,
        token: doc.accessToken || null,
        tokenExpiry: doc.tokenExpiry || 0,
        account,
        accountId,
        email: doc.email || null,
        displayName: doc.displayName || null,
      });
      logger.info(`Restored Microsoft session for ${doc.appUserId}:${accountId} (${doc.email})`);
    }
    logger.info(`restoreMsSessions: ${docs.length} session(s) restored`);
  } catch (e) {
    logger.warn(`restoreMsSessions failed: ${e.message}`);
  }
}

/**
 * Acquire app-only token (client credentials) — used for user lookup and agent install.
 * Not per-user; uses client credentials flow.
 */
export async function getAppOnlyToken(tenantId) {
  const app = _createMsalApp(tenantId);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });

  if (!result?.accessToken) {
    throw new Error(`Failed to acquire app-only Graph token for tenant: ${tenantId}`);
  }

  logger.info(`App-only Graph token acquired for tenant: ${tenantId}`);
  return result.accessToken;
}

/**
 * @deprecated Use getAppOnlyToken(tenantId) instead.
 * Kept for backward compatibility with agentDeployer which uses getGraphToken.
 */
export async function getGraphToken(tenantId) {
  return getAppOnlyToken(tenantId);
}
