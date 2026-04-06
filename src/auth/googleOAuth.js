import { google } from 'googleapis';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('auth:google-oauth');

const SCOPES = [
  'https://www.googleapis.com/auth/ediscovery',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/devstorage.read_only',
];

let _oauth2Client = null;
let _tokens = null;
let _tokenExpiry = 0;

function getOAuth2Client() {
  if (!_oauth2Client) {
    _oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      `http://localhost:${process.env.PORT || 3000}/auth/google/callback`
    );
    _oauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        _tokens = { ..._tokens, ...tokens };
      }
      if (tokens.expiry_date) {
        _tokenExpiry = tokens.expiry_date;
      }
      logger.info(`Google token refreshed — expires: ${new Date(tokens.expiry_date)}`);
    });
  }
  return _oauth2Client;
}

export function getGoogleAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function acquireGoogleTokenByCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  _tokens = tokens;
  _tokenExpiry = tokens.expiry_date || (Date.now() + 3600000);
  logger.info(`Google OAuth token acquired — expires: ${new Date(_tokenExpiry)}`);
  return tokens;
}

export function getGoogleOAuth2Client() {
  if (!_tokens) {
    throw new Error('Google admin not signed in. Click "Sign in with Google" first.');
  }
  const client = getOAuth2Client();
  client.setCredentials(_tokens);
  return client;
}

export function isGoogleAuthenticated() {
  return !!_tokens && Date.now() < _tokenExpiry;
}
