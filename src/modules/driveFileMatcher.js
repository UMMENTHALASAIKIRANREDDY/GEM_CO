import { google } from 'googleapis';
import { getValidToken } from '../auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

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
      // Google Docs editors can't be downloaded as binary — must export
      const exportFmt = this._exportFormat(driveFile.mimeType);
      let buffer, uploadName;

      if (exportFmt) {
        const dlRes = await this.drive.files.export(
          { fileId: driveFile.id, mimeType: exportFmt.mime },
          { responseType: 'arraybuffer' }
        );
        buffer = Buffer.from(dlRes.data);
        uploadName = driveFile.name + exportFmt.ext;
      } else {
        const dlRes = await this.drive.files.get(
          { fileId: driveFile.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        buffer = Buffer.from(dlRes.data);
        uploadName = driveFile.name;
      }

      const msToken = await getValidToken(this.appUserId);
      const headers = {
        Authorization: `Bearer ${msToken}`,
        'Content-Type': 'application/octet-stream',
      };

      // Upload to OneDrive — PUT creates or replaces
      const encodedPath = encodeURIComponent(`GeminiMigration/${uploadName}`);
      const uploadUrl = `${GRAPH_BASE}/users/${targetEmail}/drive/root:/${encodedPath}:/content`;
      const upRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
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
