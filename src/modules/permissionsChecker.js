import { google } from 'googleapis';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:permissionsChecker');

/**
 * Validates that all required Google APIs are accessible using service account clients.
 *
 * @param {object} directoryClient - from getAdminDirectoryClient()
 * @param {object} reportsClient   - from getAdminReportsClient() — optional
 * @returns {Promise<{drive: boolean, reports: boolean, directory: boolean, errors: object}>}
 */
export async function checkPermissions(directoryClient, reportsClient = null) {
  const results = {
    drive: true,   // Drive uses per-user SA impersonation — skip global check
    reports: false,
    directory: false,
    errors: {},
  };

  // 1. Admin Directory API — list 1 user
  try {
    await directoryClient.users.list({ customer: 'my_customer', maxResults: 1 });
    results.directory = true;
    logger.info('Permissions: Admin Directory API — OK');
  } catch (err) {
    results.errors.directory = _summarizeError(err);
    logger.warn(`Permissions: Admin Directory API — FAIL: ${results.errors.directory}`);
  }

  // 2. Admin Reports API — query 1 event
  if (reportsClient) {
    try {
      await reportsClient.activities.list({
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
  }

  return results;
}

function _summarizeError(err) {
  const code = err.code || err.status || '';
  const message = err.message || String(err);
  return code ? `[${code}] ${message.slice(0, 200)}` : message.slice(0, 200);
}
