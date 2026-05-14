import { google } from 'googleapis';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/mongo.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('auth:google-oauth');

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/ediscovery',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
  'https://www.googleapis.com/auth/devstorage.read_only',
  'https://www.googleapis.com/auth/drive.readonly',
];

// Multi-account session map: `${appUserId}:${accountId}` → session
const _sessions = new Map();

function _key(appUserId, accountId) {
  return `${appUserId}:${accountId}`;
}

function _createOAuth2Client(appUserId, accountId) {
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
    || `${process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`}/auth/google/callback`;
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri
  );

  client.on('tokens', async (tokens) => {
    const session = _sessions.get(_key(appUserId, accountId));
    if (!session) return;
    if (tokens.refresh_token) session.tokens = { ...session.tokens, ...tokens };
    if (tokens.expiry_date) session.tokenExpiry = tokens.expiry_date;
    logger.info(`Google token refreshed for ${appUserId}:${accountId}`);
    try {
      const db = getDb();
      await db.collection('authSessions').updateOne(
        { appUserId, provider: 'google', accountId },
        { $set: {
          accessToken: session.tokens.access_token,
          refreshToken: session.tokens.refresh_token || undefined,
          tokenExpiry: session.tokenExpiry,
          lastRefreshed: new Date()
        } },
        { upsert: true }
      );
    } catch (e) {
      logger.warn(`Failed to persist refreshed Google token for ${appUserId}:${accountId}: ${e.message}`);
    }
  });

  return client;
}

/**
 * Generate an OAuth URL for adding a new Google account.
 * Returns { url, accountId } — accountId is a UUID that tracks this auth flow.
 */
export function getGoogleAuthUrl(appUserId) {
  const accountId = randomUUID();
  const client = _createOAuth2Client(appUserId, accountId);
  _sessions.set(_key(appUserId, accountId), { oauth2Client: client, tokens: null, tokenExpiry: 0, accountId, email: null });
  const state = Buffer.from(JSON.stringify({ appUserId, accountId })).toString('base64');
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', state });
  return { url, accountId };
}

/**
 * Exchange auth code → tokens. Stores session keyed by accountId.
 * Returns { tokens, email, displayName, accountId }.
 */
export async function acquireGoogleTokenByCode(code, stateParam) {
  let appUserId, accountId;
  try {
    const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf8'));
    appUserId = decoded.appUserId;
    accountId = decoded.accountId;
  } catch {
    throw new Error('Invalid state parameter in Google OAuth callback');
  }

  const key = _key(appUserId, accountId);
  if (!_sessions.has(key)) {
    // Session was lost (server restart during auth) — recreate it
    _sessions.set(key, { oauth2Client: _createOAuth2Client(appUserId, accountId), tokens: null, tokenExpiry: 0, accountId, email: null });
  }
  const session = _sessions.get(key);
  const { tokens } = await session.oauth2Client.getToken(code);
  session.oauth2Client.setCredentials(tokens);
  session.tokens = tokens;
  session.tokenExpiry = tokens.expiry_date || (Date.now() + 3600000);

  let email = null, displayName = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: session.oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    email = profile.email || null;
    displayName = profile.name || null;
    session.email = email;
  } catch (e) {
    logger.warn(`Could not fetch Google profile for ${appUserId}:${accountId}: ${e.message}`);
  }

  // Deduplicate: if this email is already in another session, merge into it
  if (email) {
    for (const [existingKey, existingSession] of _sessions.entries()) {
      if (existingKey === key) continue;
      if (!existingKey.startsWith(`${appUserId}:`)) continue;
      if (existingSession.email === email) {
        existingSession.tokens = tokens;
        existingSession.tokenExpiry = session.tokenExpiry;
        existingSession.oauth2Client.setCredentials(tokens);
        _sessions.delete(key);
        try { const db = getDb(); db.collection('authSessions').deleteOne({ appUserId, provider: 'google', accountId }).catch(() => {}); } catch {}
        logger.info(`Google: ${email} already connected for ${appUserId} — refreshed existing session ${existingSession.accountId}`);
        return { tokens, email, displayName, accountId: existingSession.accountId, alreadyConnected: true };
      }
    }
  }

  try {
    const db = getDb();
    await db.collection('authSessions').updateOne(
      { appUserId, provider: 'google', accountId },
      { $set: {
        email, displayName, provider: 'google', accountId,
        refreshToken: tokens.refresh_token || undefined,
        accessToken: tokens.access_token,
        tokenExpiry: session.tokenExpiry,
        connectedAt: new Date(),
        lastRefreshed: new Date()
      } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn(`Failed to persist Google authSession for ${appUserId}:${accountId}: ${e.message}`);
  }

  logger.info(`Google OAuth token acquired for ${appUserId}:${accountId} (${email})`);
  return { tokens, email, displayName, accountId };
}

/**
 * Returns true if the user has at least one connected Google account.
 */
export function isGoogleAuthenticated(appUserId) {
  for (const [key, session] of _sessions.entries()) {
    if (!key.startsWith(`${appUserId}:`)) continue;
    if (session.tokens?.refresh_token) return true;
    if (session.tokens && Date.now() < session.tokenExpiry) return true;
  }
  return false;
}

/**
 * Get all connected Google accounts for a user.
 * Returns array of { accountId, email, displayName, connectedAt }.
 */
export function getGoogleAccounts(appUserId) {
  const accounts = [];
  for (const [key, session] of _sessions.entries()) {
    if (!key.startsWith(`${appUserId}:`)) continue;
    if (!session.tokens) continue;
    accounts.push({
      accountId: session.accountId,
      email: session.email || null,
      displayName: session.displayName || null,
    });
  }
  return accounts;
}

/**
 * Get the OAuth2 client for a specific account.
 * If accountId is omitted, returns the first connected account (backward compat).
 */
export function getGoogleOAuth2Client(appUserId, accountId = null) {
  if (accountId) {
    const session = _sessions.get(_key(appUserId, accountId));
    if (!session?.tokens) throw new Error(`Google account ${accountId} not connected.`);
    session.oauth2Client.setCredentials(session.tokens);
    return session.oauth2Client;
  }
  // Backward compat: return first available session
  for (const [key, session] of _sessions.entries()) {
    if (key.startsWith(`${appUserId}:`) && session.tokens) {
      session.oauth2Client.setCredentials(session.tokens);
      return session.oauth2Client;
    }
  }
  throw new Error('Google admin not signed in. Click "Sign in with Google" first.');
}

/**
 * Disconnect a specific Google account.
 */
export function clearGoogleAccount(appUserId, accountId) {
  const key = _key(appUserId, accountId);
  const session = _sessions.get(key);
  if (session) {
    session.oauth2Client.setCredentials({});
    _sessions.delete(key);
  }
  try {
    const db = getDb();
    db.collection('authSessions').deleteOne({ appUserId, provider: 'google', accountId }).catch(() => {});
  } catch {}
}

/**
 * Disconnect ALL Google accounts for a user (backward compat logout).
 */
export function clearGoogleToken(appUserId) {
  const toDelete = [];
  for (const key of _sessions.keys()) {
    if (key.startsWith(`${appUserId}:`)) toDelete.push(key);
  }
  toDelete.forEach(k => {
    const s = _sessions.get(k);
    if (s) s.oauth2Client.setCredentials({});
    _sessions.delete(k);
  });
  try {
    const db = getDb();
    db.collection('authSessions').deleteMany({ appUserId, provider: 'google' }).catch(() => {});
  } catch {}
}

export async function restoreGoogleSessions() {
  try {
    const db = getDb();
    const docs = await db.collection('authSessions').find({ provider: 'google' }).toArray();
    for (const doc of docs) {
      if (!doc.appUserId || !doc.refreshToken) continue;
      const accountId = doc.accountId || doc.appUserId; // fallback for old records without accountId
      const client = _createOAuth2Client(doc.appUserId, accountId);
      const tokens = { refresh_token: doc.refreshToken, access_token: doc.accessToken || null, expiry_date: doc.tokenExpiry || 0 };
      client.setCredentials(tokens);
      _sessions.set(_key(doc.appUserId, accountId), {
        oauth2Client: client, tokens, tokenExpiry: doc.tokenExpiry || 0,
        accountId, email: doc.email || null, displayName: doc.displayName || null,
      });
      logger.info(`Restored Google session for ${doc.appUserId}:${accountId} (${doc.email})`);
    }
    logger.info(`restoreGoogleSessions: ${docs.length} session(s) restored`);
  } catch (e) {
    logger.warn(`restoreGoogleSessions failed: ${e.message}`);
  }
}
