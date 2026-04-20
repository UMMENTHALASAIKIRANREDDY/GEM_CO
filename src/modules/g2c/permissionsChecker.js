import { google } from 'googleapis';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:permissionsChecker');

/**
 * Validates that all required Google APIs are accessible with the current OAuth client.
 * Tests Drive API, Admin Reports API, and Admin Directory API.
 *
 * @param {object} googleAuthClient - from getGoogleOAuth2Client()
 * @returns {Promise<{drive: boolean, reports: boolean, directory: boolean, errors: object}>}
 */
export async function checkPermissions(googleAuthClient) {
  const results = {
    drive: false,
    reports: false,
    directory: false,
    errors: {},
  };

  // 1. Drive API — list 1 file
  try {
    const drive = google.drive({ version: 'v3', auth: googleAuthClient });
    await drive.files.list({ pageSize: 1, fields: 'files(id,name)' });
    results.drive = true;
    logger.info('Permissions: Drive API — OK');
  } catch (err) {
    results.errors.drive = _summarizeError(err);
    logger.warn(`Permissions: Drive API — FAIL: ${results.errors.drive}`);
  }

  // 2. Admin Reports API — query 1 event
  try {
    const reports = google.admin({ version: 'reports_v1', auth: googleAuthClient });
    await reports.activities.list({
      userKey: 'all',
      applicationName: 'drive',
      maxResults: 1,
    });
    results.reports = true;
    logger.info('Permissions: Admin Reports API — OK');
  } catch (err) {
    results.errors.reports = _summarizeError(err);
    logger.warn(`Permissions: Admin Reports API — FAIL: ${results.errors.reports}`);
  }

  // 3. Admin Directory API — list 1 user
  try {
    const directory = google.admin({ version: 'directory_v1', auth: googleAuthClient });
    await directory.users.list({ customer: 'my_customer', maxResults: 1 });
    results.directory = true;
    logger.info('Permissions: Admin Directory API — OK');
  } catch (err) {
    results.errors.directory = _summarizeError(err);
    logger.warn(`Permissions: Admin Directory API — FAIL: ${results.errors.directory}`);
  }

  return results;
}

function _summarizeError(err) {
  const code = err.code || err.status || '';
  const message = err.message || String(err);
  return code ? `[${code}] ${message.slice(0, 200)}` : message.slice(0, 200);
}
