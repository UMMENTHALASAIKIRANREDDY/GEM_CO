import { getDriveService } from '../auth/google.js';
import { getGraphToken } from '../auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:driveMigrator');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const MIME_EXPORT_MAP = {
  'application/vnd.google-apps.document': {
    exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx'
  }
};

/**
 * Module 6 — Google Drive → OneDrive Document Migration.
 * Uses CloudFuze service account with domain-wide delegation.
 * Converts Google Workspace formats to Office formats.
 */
export class DriveMigrator {
  constructor(tenantId) {
    this.tenantId = tenantId;
    this._graphToken = null;
  }

  async _getGraphToken() {
    if (!this._graphToken) {
      this._graphToken = await getGraphToken(this.tenantId);
    }
    return this._graphToken;
  }

  /**
   * Migrate all Google Drive files for a user to their OneDrive.
   * Returns per-user migration summary.
   */
  async migrateUserDrive(email) {
    const results = {
      email,
      files_moved: 0,
      files_skipped: 0,
      errors: [],
      total_bytes: 0
    };

    let driveService;
    try {
      driveService = getDriveService(email);
    } catch (err) {
      results.errors.push(err.message);
      return results;
    }

    let files;
    try {
      files = await this._listDriveFiles(driveService);
    } catch (err) {
      logger.error(`Failed to list Drive files for ${email}: ${err.message}`);
      results.errors.push(err.message);
      return results;
    }

    for (const file of files) {
      try {
        const { moved, size } = await this._migrateFile(email, driveService, file);
        if (moved) {
          results.files_moved++;
          results.total_bytes += size;
        } else {
          results.files_skipped++;
        }
      } catch (err) {
        logger.warn(`File migration failed for ${email}/${file.name}: ${err.message}`);
        results.errors.push({ file: file.name, error: err.message });
      }
    }

    logger.info(`Drive migration complete for ${email}: ${results.files_moved} moved, ${results.files_skipped} skipped`);
    return results;
  }

  async _listDriveFiles(driveService) {
    const files = [];
    let pageToken = null;

    do {
      const res = await driveService.files.list({
        pageSize: 100,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        ...(pageToken ? { pageToken } : {})
      });
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken || null;
    } while (pageToken);

    return files;
  }

  async _migrateFile(email, driveService, file) {
    const mapping = MIME_EXPORT_MAP[file.mimeType];
    if (!mapping) return { moved: false, size: 0 };

    const { exportMime, extension } = mapping;
    const exportName = `${file.name}${extension}`;

    // Download from Google Drive (export as Office format)
    const exportRes = await driveService.files.export(
      { fileId: file.id, mimeType: exportMime },
      { responseType: 'arraybuffer' }
    );
    const fileContent = Buffer.from(exportRes.data);

    // Upload to OneDrive under "Migrated from Google Drive" folder
    const token = await this._getGraphToken();
    const url = `${GRAPH_BASE}/users/${email}/drive/root:/Migrated from Google Drive/${exportName}:/content`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': exportMime
      },
      body: fileContent
    });

    if (!response.ok) {
      throw new Error(`OneDrive upload failed: ${response.status}`);
    }

    logger.info(`Migrated: ${exportName} (${email})`);
    return { moved: true, size: fileContent.length };
  }
}
