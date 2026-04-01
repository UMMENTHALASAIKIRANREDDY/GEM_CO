import { google } from 'googleapis';
import fs from 'fs';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('auth:google');

/**
 * Build a Google Drive API client for a specific user.
 * Uses CloudFuze's service account with domain-wide delegation,
 * impersonating the target user email.
 */
export function getDriveService(userEmail) {
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './service_account.json';

  if (!fs.existsSync(saPath)) {
    throw new Error(`Google service account file not found: ${saPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));

  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: userEmail  // Domain-wide delegation — impersonate target user
  });

  logger.info(`Google Drive client created for: ${userEmail}`);
  return google.drive({ version: 'v3', auth });
}
