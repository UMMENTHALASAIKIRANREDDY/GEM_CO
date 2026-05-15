import { google } from 'googleapis';
import { getValidToken } from '../../core/auth/microsoft.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:driveFileMatcher');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Module: Drive File Matcher
 *
 * Downloads files from Google Drive (by file metadata from audit log correlation)
 * and uploads them to OneDrive for the target M365 user.
 */
export class DriveFileMatcher {
  constructor(googleAuthClient, ownerEmail, appUserId = null) {
    this.auth = googleAuthClient;
    this.ownerEmail = ownerEmail;
    this.appUserId = appUserId;
    this.drive = google.drive({ version: 'v3', auth: googleAuthClient });
  }

  /**
   * Download a file from Drive and upload it to OneDrive under the target user's
   * Documents/GeminiMigration/ folder.
   * Returns the OneDrive webUrl string or null on failure.
   */
  // Google Docs editor MIME types → export format + extension
  _exportFormat(mimeType) {
    const map = {
      'application/vnd.google-apps.document':     { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
      'application/vnd.google-apps.spreadsheet':  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
      'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
      'application/vnd.google-apps.drawing':      { mime: 'application/pdf', ext: '.pdf' },
    };
    return map[mimeType] || null;
  }

  async uploadToOneDrive(driveFile, targetEmail) {
    try {
      const exportFmt = this._exportFormat(driveFile.mimeType);
      const uploadName = exportFmt ? driveFile.name + exportFmt.ext : driveFile.name;

      const msToken = await getValidToken(this.appUserId);
      const encodedPath = encodeURIComponent(`GeminiMigration/${uploadName}`);
      const fileBaseUrl = `${GRAPH_BASE}/users/${targetEmail}/drive/root:/${encodedPath}`;

      // Check if file already exists in OneDrive — reuse link, skip re-upload
      const checkRes = await fetch(fileBaseUrl, { headers: { Authorization: `Bearer ${msToken}` } });
      if (checkRes.ok) {
        const existing = await checkRes.json();
        logger.info(`File "${uploadName}" already exists in OneDrive for ${targetEmail} — reusing`);
        return existing.webUrl || existing['@microsoft.graph.downloadUrl'] || `uploaded:${uploadName}`;
      }

      // Download from Google Drive
      let buffer;
      if (exportFmt) {
        const dlRes = await this.drive.files.export(
          { fileId: driveFile.id, mimeType: exportFmt.mime },
          { responseType: 'arraybuffer' }
        );
        buffer = Buffer.from(dlRes.data);
      } else {
        const dlRes = await this.drive.files.get(
          { fileId: driveFile.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        buffer = Buffer.from(dlRes.data);
      }

      const upRes = await fetch(`${fileBaseUrl}:/content`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${msToken}`, 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });

      if (!upRes.ok) {
        const errText = await upRes.text();
        const msg = `OneDrive ${upRes.status}: ${errText.slice(0, 200)}`;
        logger.warn(`OneDrive upload failed for "${uploadName}" → ${targetEmail}: ${msg}`);
        return { error: msg };
      }

      const upData = await upRes.json();
      logger.info(`Uploaded "${uploadName}" to OneDrive for ${targetEmail}`);
      return upData.webUrl || upData['@microsoft.graph.downloadUrl'] || `uploaded:${uploadName}`;
    } catch (err) {
      const msg = `uploadToOneDrive error for "${driveFile.name}" (mimeType=${driveFile.mimeType}): ${err.message}`;
      logger.warn(msg);
      process.stderr.write(`[DriveFileMatcher] ${msg}\n`);
      return { error: err.message };
    }
  }

}
