import { ConfidentialClientApplication } from '@azure/msal-node';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('auth:microsoft');

// Delegated permission scopes needed for migration
// Copilot Chat API requires all 7 scopes below
const DELEGATED_SCOPES = [
  'https://graph.microsoft.com/Files.ReadWrite.All',
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/User.Read.All',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/People.Read.All',
  'https://graph.microsoft.com/OnlineMeetingTranscript.Read.All',
  'https://graph.microsoft.com/Chat.Read',
  'https://graph.microsoft.com/ChannelMessage.Read.All',
  'https://graph.microsoft.com/ExternalItem.Read.All',
  'https://graph.microsoft.com/AppCatalog.ReadWrite.All',
];

let _msalApp = null;
let _msalTenant = null;
let _delegatedToken = null;
let _delegatedTokenExpiry = 0;

function getMsalApp(tenantId) {
  // Recreate if tenant changed
  if (!_msalApp || _msalTenant !== tenantId) {
    _msalApp = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${tenantId}`
      }
    });
    _msalTenant = tenantId;
  }
  return _msalApp;
}

/**
 * Get the authorization URL for admin to sign in.
 * Redirects to /auth/callback after consent.
 */
export function getAuthUrl(tenantId) {
  const app = getMsalApp(tenantId);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return app.getAuthCodeUrl({
    scopes: DELEGATED_SCOPES,
    redirectUri: `${baseUrl}/auth/callback`,
    prompt: 'consent'
  });
}

/**
 * Exchange authorization code for a delegated access token.
 */
export async function acquireTokenByCode(tenantId, code) {
  const app = getMsalApp(tenantId);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const result = await app.acquireTokenByCode({
    scopes: DELEGATED_SCOPES,
    redirectUri: `${baseUrl}/auth/callback`,
    code
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire delegated token');
  }

  _delegatedToken = result.accessToken;
  _delegatedTokenExpiry = Date.now() + (result.expiresOn?.getTime() - Date.now()) || 3600000;
  logger.info(`Delegated token acquired — expires: ${result.expiresOn}`);
  return result.accessToken;
}

/**
 * Get the current delegated token (admin must have signed in first).
 */
export function getDelegatedToken() {
  if (!_delegatedToken) {
    throw new Error('Admin not signed in. Click "Sign in with Microsoft" first.');
  }
  if (Date.now() > _delegatedTokenExpiry) {
    throw new Error('Delegated token expired. Please sign in again.');
  }
  return _delegatedToken;
}

/**
 * Check if admin has a valid delegated token.
 */
export function isAuthenticated() {
  return !!_delegatedToken && Date.now() < _delegatedTokenExpiry;
}

/**
 * Acquire app-only token (client credentials) — used for user lookup only.
 */
export async function getGraphToken(tenantId) {
  const app = getMsalApp(tenantId);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });

  if (!result?.accessToken) {
    throw new Error(`Failed to acquire Graph token for tenant: ${tenantId}`);
  }

  logger.info(`App-only Graph token acquired for tenant: ${tenantId}`);
  return result.accessToken;
}
