import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('vault-exporter');

export class VaultExporter {
  constructor(auth) {
    this.vault = google.vault({ version: 'v1', auth });
    this.auth = auth;
  }

  async _getToken() {
    const tok = await this.auth.getAccessToken();
    return tok.token || tok;
  }

  async createMatter(name) {
    const res = await this.vault.matters.create({
      requestBody: { name, state: 'OPEN' },
    });
    logger.info(`Matter created: ${res.data.matterId} — "${name}"`);
    return res.data;
  }

  async _rawExportCreate(matterId, emails) {
    const token = await this._getToken();
    const url = `https://vault.googleapis.com/v1/matters/${matterId}/exports`;
    const body = {
      name: `gemini-export-${Date.now()}`,
      query: {
        corpus: 'GEMINI',
        dataScope: 'ALL_DATA',
        accountInfo: { emails },
        searchMethod: 'ACCOUNT',
        geminiOptions: {},
      },
      exportOptions: {
        geminiOptions: {
          exportFormat: 'XML',
        },
        region: 'ANY',
      },
    };

    logger.info(`POST ${url} — corpus: GEMINI, emails: ${emails.join(', ')}`);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = data.error?.message || JSON.stringify(data);
      throw Object.assign(new Error(msg), { errors: data.error?.errors });
    }
    return data;
  }

  async createExport(matterId, userEmails) {
    try {
      const data = await this._rawExportCreate(matterId, userEmails);
      logger.info(`Export created: ${data.id} for ${userEmails.length} users`);
      return data;
    } catch (err) {
      const errMsg = err.errors?.[0]?.message || err.message || String(err);
      logger.warn(`Export create failed: ${errMsg}`);
      const match = errMsg.match(/Emails do not exist:\s*\[([^\]]+)\]/);
      if (match) {
        const invalidEmails = match[1].split(',').map(e => e.trim());
        logger.warn(`Removing invalid emails and retrying: ${invalidEmails.join(', ')}`);
        const validEmails = userEmails.filter(e => !invalidEmails.includes(e));
        if (validEmails.length === 0) {
          throw new Error(`No valid emails to export. Invalid: ${invalidEmails.join(', ')}`);
        }
        const data = await this._rawExportCreate(matterId, validEmails);
        logger.info(`Export created: ${data.id} for ${validEmails.length} valid users (skipped: ${invalidEmails.join(', ')})`);
        data._skippedEmails = invalidEmails;
        return data;
      }
      throw err;
    }
  }

  async downloadExport(matterId, exportId, destDir) {
    const exportData = await this.vault.matters.exports.get({ matterId, exportId });
    const files = exportData.data.cloudStorageSink?.files || [];

    if (files.length === 0) {
      throw new Error('Export completed but no files found in cloud storage sink');
    }

    fs.mkdirSync(destDir, { recursive: true });

    const storage = google.storage({ version: 'v1', auth: this.auth });

    for (const file of files) {
      const filePath = path.join(destDir, path.basename(file.objectName));
      logger.info(`Downloading: ${file.objectName} (${file.size} bytes)`);

      const res = await storage.objects.get(
        { bucket: file.bucketName, object: file.objectName, alt: 'media' },
        { responseType: 'stream' }
      );

      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(filePath);
        res.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      logger.info(`Downloaded: ${path.basename(file.objectName)}`);
    }

    return destDir;
  }

  async closeMatter(matterId) {
    await this.vault.matters.close({ matterId, requestBody: {} });
    logger.info(`Matter ${matterId} closed`);
  }
}
