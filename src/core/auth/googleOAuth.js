import { google } from 'googleapis';
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

// Per-user session map: appUserId → { oauth2Client, tokens, tokenExpiry }
const _sessions = new Map();

function _createOAuth2Client(appUserId) {
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:4000/auth/google/callback';
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri
  );

  client.on('tokens', async (tokens) => {
    const session = _sessions.get(appUserId);
    if (!session) return;
    if (tokens.refresh_token) {
      session.tokens = { ...session.tokens, ...tokens };
    }
    if (tokens.expiry_date) {
      session.tokenExpiry = tokens.expiry_date;
    }
    logger.info(`Google token refreshed for ${appUserId} — expires: ${new Date(tokens.expiry_date)}`);
    // Persist updated token to DB
    try {
      const db = getDb();
      const { tokens: t } = session;
      await db.collection('authSessions').updateOne(
        { appUserId, provider: 'google' },
        { $set: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token || undefined,
          tokenExpiry: session.tokenExpiry,
          lastRefreshed: new Date()
        } },
        { upsert: true }
      );
    } catch (e) {
      logger.warn(`Failed to persist refreshed Google token for ${appUserId}: ${e.message}`);
    }
  });

  return client;
}

export function getGoogleAuthUrl(appUserId) {
  if (!_sessions.has(appUserId)) {
    _sessions.set(appUserId, { oauth2Client: _createOAuth2Client(appUserId), tokens: null, tokenExpiry: 0 });
  }
  const { oauth2Client } = _sessions.get(appUserId);
  const state = Buffer.from(JSON.stringify({ appUserId })).toString('base64');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

export async function acquireGoogleTokenByCode(code, stateParam) {
  let appUserId = null;
  try {
    const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf8'));
    appUserId = decoded.appUserId;
  } catch {
    throw new Error('Invalid state parameter in Google OAuth callback');
  }

  if (!_sessions.has(appUserId)) {
    _sessions.set(appUserId, { oauth2Client: _createOAuth2Client(appUserId), tokens: null, tokenExpiry: 0 });
  }
  const session = _sessions.get(appUserId);
  const { tokens } = await session.oauth2Client.getToken(code);
  session.oauth2Client.setCredentials(tokens);
  session.tokens = tokens;
  session.tokenExpiry = tokens.expiry_date || (Date.now() + 3600000);

  logger.info(`Google OAuth token acquired for ${appUserId} — expires: ${new Date(session.tokenExpiry)}`);

  // Get profile info for DB record
  let email = null, displayName = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: session.oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    email = profile.email || null;
    displayName = profile.name || null;
  } catch (e) {
    logger.warn(`Could not fetch Google profile for ${appUserId}: ${e.message}`);
  }

  // Persist to DB
  try {
    const db = getDb();
    await db.collection('authSessions').updateOne(
      { appUserId, provider: 'google' },
      { $set: {
        email,
        displayName,
        provider: 'google',
        refreshToken: tokens.refresh_token || undefined,
        accessToken: tokens.access_token,
        tokenExpiry: session.tokenExpiry,
        connectedAt: new Date(),
        lastRefreshed: new Date()
      } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn(`Failed to persist Google authSession for ${appUserId}: ${e.message}`);
  }

  return { tokens, email, displayName };
}

export function isGoogleAuthenticated(appUserId) {
  const session = _sessions.get(appUserId);
  if (!session?.tokens) return false;
  // Has a refresh token — considered connected even if access token is expired
  if (session.tokens.refresh_token) return true;
  return Date.now() < session.tokenExpiry;
}

export function getGoogleOAuth2Client(appUserId) {
  const session = _sessions.get(appUserId);
  if (!session?.tokens) {
    throw new Error('Google admin not signed in. Click "Sign in with Google" first.');
  }
  session.oauth2Client.setCredentials(session.tokens);
  return session.oauth2Client;
}

export function clearGoogleToken(appUserId) {
  const session = _sessions.get(appUserId);
  if (session) {
    session.oauth2Client.setCredentials({});
    _sessions.delete(appUserId);
  }
  // Delete from DB (fire-and-forget)
  try {
    const db = getDb();
    db.collection('authSessions').deleteOne({ appUserId, provider: 'google' }).catch(() => {});
  } catch {}
}

export async function restoreGoogleSessions() {
  try {
    const db = getDb();
    const docs = await db.collection('authSessions').find({ provider: 'google' }).toArray();
    for (const doc of docs) {
      if (!doc.appUserId || !doc.refreshToken) continue;
      const client = _createOAuth2Client(doc.appUserId);
      const tokens = {
        refresh_token: doc.refreshToken,
        access_token: doc.accessToken || null,
        expiry_date: doc.tokenExpiry || 0,
      };
      client.setCredentials(tokens);
      _sessions.set(doc.appUserId, {
        oauth2Client: client,
        tokens,
        tokenExpiry: doc.tokenExpiry || 0,
      });
      logger.info(`Restored Google session for appUserId=${doc.appUserId} (${doc.email})`);
    }
    logger.info(`restoreGoogleSessions: ${docs.length} session(s) restored`);
  } catch (e) {
    logger.warn(`restoreGoogleSessions failed: ${e.message}`);
  }
}
