import { google } from "googleapis";
import fs from "fs";
import path from "path";

/**
 * Google Vault eDiscovery exporter for Gemini data.
 * Ported from GEM_CO project.
 */
export class VaultExporter {
  constructor(auth) {
    this.vault = google.vault({ version: "v1", auth });
    this.auth = auth;
  }

  async _getToken() {
    const tok = await this.auth.getAccessToken();
    return tok.token || tok;
  }

  async createMatter(name) {
    const res = await this.vault.matters.create({
      requestBody: { name, state: "OPEN" },
    });
    return res.data;
  }

  async createExport(matterId, userEmails) {
    const token = await this._getToken();
    const url = `https://vault.googleapis.com/v1/matters/${matterId}/exports`;
    const body = {
      name: `gemini-export-${Date.now()}`,
      query: {
        corpus: "GEMINI",
        dataScope: "ALL_DATA",
        accountInfo: { emails: userEmails },
        searchMethod: "ACCOUNT",
        geminiOptions: {},
      },
      exportOptions: {
        geminiOptions: { exportFormat: "XML" },
        region: "ANY",
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error?.message || JSON.stringify(data));
    }
    return data;
  }

  async downloadExport(matterId, exportId, destDir) {
    const exportData = await this.vault.matters.exports.get({
      matterId,
      exportId,
    });
    const files = exportData.data.cloudStorageSink?.files || [];
    if (files.length === 0) {
      throw new Error("Export completed but no files found in cloud storage");
    }

    fs.mkdirSync(destDir, { recursive: true });
    const storage = google.storage({ version: "v1", auth: this.auth });

    for (const file of files) {
      const filePath = path.join(destDir, path.basename(file.objectName));
      const res = await storage.objects.get(
        { bucket: file.bucketName, object: file.objectName, alt: "media" },
        { responseType: "stream" }
      );
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(filePath);
        res.data.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    }

    return destDir;
  }

  async closeMatter(matterId) {
    await this.vault.matters.close({ matterId, requestBody: {} });
  }
}
