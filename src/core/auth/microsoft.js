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
  'https://graph.microsoft.com/Notes.ReadWrite.All',
  'https://graph.microsoft.com/Files.ReadWrite.All',
  'https://graph.microsoft.com/AppCatalog.ReadWrite.All',
];

// Per-user session map: appUserId → { msalApp, tenant, token, tokenExpiry, account }
const _sessions = new Map();

function _createMsalApp(tenantId) {
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${tenantId}`
    }
  });
}

/**
 * Get the authorization URL for admin to sign in.
 * Encodes appUserId + tenantId in state parameter.
 */
export async function getAuthUrl(tenantId, appUserId) {
  const msalApp = _createMsalApp(tenantId);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const state = Buffer.from(JSON.stringify({ appUserId, tenantId })).toString('base64');
  return msalApp.getAuthCodeUrl({
    scopes: DELEGATED_SCOPES,
    redirectUri: `${baseUrl}/auth/callback`,
    prompt: 'consent',
    state,
  });
}

/**
 * Exchange authorization code for a delegated access token.
 * Decodes appUserId + tenantId from state parameter.
 */
export async function acquireTokenByCode(code, stateParam) {
  let appUserId = null, tenantId = null;
  try {
    const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf8'));
    appUserId = decoded.appUserId;
    tenantId = decoded.tenantId;
  } catch {
    throw new Error('Invalid state parameter in Microsoft OAuth callback');
  }

  const msalApp = _createMsalApp(tenantId);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const result = await msalApp.acquireTokenByCode({
    scopes: DELEGATED_SCOPES,
    redirectUri: `${baseUrl}/auth/callback`,
    code
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire delegated token');
  }

  const tokenExpiry = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600000;
  _sessions.set(appUserId, {
    msalApp,
    tenant: tenantId,
    token: result.accessToken,
    tokenExpiry,
    account: result.account || null,
  });

  logger.info(`Delegated token acquired for appUserId=${appUserId} — expires: ${result.expiresOn}`);

  const email = result.account?.username || null;
  const displayName = result.account?.name || null;

  // Serialize MSAL cache
  let msalCache = null;
  try {
    msalCache = msalApp.getTokenCache().serialize();
  } catch {}

  // Persist to DB
  try {
    const db = getDb();
    await db.collection('authSessions').updateOne(
      { appUserId, provider: 'microsoft' },
      { $set: {
        email,
        displayName,
        provider: 'microsoft',
        tenantId,
        accessToken: result.accessToken,
        tokenExpiry,
        msalCache,
        connectedAt: new Date(),
        lastRefreshed: new Date()
      } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn(`Failed to persist Microsoft authSession for ${appUserId}: ${e.message}`);
  }

  return { ...result, email, displayName };
}

/**
 * Get a valid delegated token, refreshing silently if it expires within 5 minutes.
 */
export async function getValidToken(appUserId) {
  const session = _sessions.get(appUserId);
  if (!session?.token || !session?.account) {
    throw new Error('Admin not signed in. Click "Sign in with Microsoft" first.');
  }

  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < session.tokenExpiry - fiveMinutes) {
    return session.token;
  }

  logger.info(`Delegated token expiring soon for ${appUserId} — refreshing silently`);
  try {
    const result = await session.msalApp.acquireTokenSilent({
      scopes: DELEGATED_SCOPES,
      account: session.account,
    });
    session.token = result.accessToken;
    session.tokenExpiry = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600000;
    session.account = result.account || session.account;
    logger.info(`Token refreshed for ${appUserId} — new expiry: ${result.expiresOn}`);

    // Persist refreshed token
    let msalCache = null;
    try { msalCache = session.msalApp.getTokenCache().serialize(); } catch {}
    try {
      const db = getDb();
      await db.collection('authSessions').updateOne(
        { appUserId, provider: 'microsoft' },
        { $set: {
          accessToken: result.accessToken,
          tokenExpiry: session.tokenExpiry,
          msalCache,
          lastRefreshed: new Date()
        } },
        { upsert: true }
      );
    } catch (e) {
      logger.warn(`Failed to persist refreshed MS token for ${appUserId}: ${e.message}`);
    }

    return session.token;
  } catch (err) {
    logger.warn(`Silent token refresh failed for ${appUserId}: ${err.message} — user must re-authenticate`);
    session.token = null;
    session.tokenExpiry = 0;
    throw new Error('Session expired. Please sign in with Microsoft again.');
  }
}

/**
 * Check if user has a valid delegated token.
 */
export function isAuthenticated(appUserId) {
  const session = _sessions.get(appUserId);
  if (!session) return false;
  // Has account (can silent-refresh) — considered connected even if access token expired
  if (session.account) return true;
  return !!session.token && Date.now() < session.tokenExpiry;
}

export function clearMsToken(appUserId) {
  _sessions.delete(appUserId);
  // Delete from DB (fire-and-forget)
  try {
    const db = getDb();
    db.collection('authSessions').deleteOne({ appUserId, provider: 'microsoft' }).catch(() => {});
  } catch {}
}

export async function restoreMsSessions() {
  try {
    const db = getDb();
    const docs = await db.collection('authSessions').find({ provider: 'microsoft' }).toArray();
    for (const doc of docs) {
      if (!doc.appUserId || !doc.tenantId) continue;
      const msalApp = _createMsalApp(doc.tenantId);
      // Restore MSAL cache if available
      if (doc.msalCache) {
        try { msalApp.getTokenCache().deserialize(doc.msalCache); } catch {}
      }
      // Attempt to restore account from cache
      let account = null;
      try {
        const cache = await msalApp.getTokenCache().getAllAccounts();
        account = cache[0] || null;
      } catch {}

      _sessions.set(doc.appUserId, {
        msalApp,
        tenant: doc.tenantId,
        token: doc.accessToken || null,
        tokenExpiry: doc.tokenExpiry || 0,
        account,
      });
      logger.info(`Restored Microsoft session for appUserId=${doc.appUserId} (${doc.email})`);
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
