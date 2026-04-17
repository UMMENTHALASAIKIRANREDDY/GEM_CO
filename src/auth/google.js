import { google } from 'googleapis';
import fs from 'fs';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('auth:google');

function _loadServiceAccount() {
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || './service_account.json';
  if (!fs.existsSync(saPath)) {
    throw new Error(`Google service account file not found: ${saPath}`);
  }
  const stats = fs.statSync(saPath);
  if (stats.isDirectory()) {
    throw new Error(`Google service account path is a directory, not a file: ${saPath}`);
  }
  return JSON.parse(fs.readFileSync(saPath, 'utf8'));
}

function _buildJwt(scopes, subject) {
  const sa = _loadServiceAccount();
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes,
    subject,
  });
}

/**
 * Drive client impersonating a specific user (for reading their files).
 */
export function getDriveService(userEmail) {
  const auth = _buildJwt(
    ['https://www.googleapis.com/auth/drive.readonly'],
    userEmail
  );
  logger.info(`Google Drive client created for: ${userEmail}`);
  return google.drive({ version: 'v3', auth });
}

/**
 * Admin Directory client impersonating the workspace admin.
 * Used for listing users across the domain.
 */
export function getAdminDirectoryClient(adminEmail) {
  const auth = _buildJwt(
    ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
    adminEmail
  );
  logger.info(`Admin Directory client created (subject: ${adminEmail})`);
  return google.admin({ version: 'directory_v1', auth });
}

/**
 * Admin Reports client impersonating the workspace admin.
 * Used for audit log queries (Drive access events, Gemini events).
 */
export function getAdminReportsClient(adminEmail) {
  const auth = _buildJwt(
    ['https://www.googleapis.com/auth/admin.reports.audit.readonly'],
    adminEmail
  );
  logger.info(`Admin Reports client created (subject: ${adminEmail})`);
  return google.admin({ version: 'reports_v1', auth });
}

/**
 * Vault client impersonating the workspace admin.
 * Used for eDiscovery matter/export operations.
 */
export function getVaultAuthClient(adminEmail) {
  const auth = _buildJwt(
    [
      'https://www.googleapis.com/auth/ediscovery',
      'https://www.googleapis.com/auth/devstorage.read_only',
    ],
    adminEmail
  );
  logger.info(`Vault auth client created (subject: ${adminEmail})`);
  return auth;
}

/**
 * Verify the service account file exists and can build a JWT.
 * Does NOT make a network call — just validates config.
 */
export function validateServiceAccount() {
  try {
    _loadServiceAccount();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
