import AdmZip from 'adm-zip';
import { getValidToken } from '../core/auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:tabDeployer');
const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
const TAB_APP_NAME = 'CloudFuze Migration History';
const DEFAULT_TAB_URL = process.env.TAB_URL || 'https://gemco.cloudfuze.com/tab.html';

export class TabDeployer {
  constructor(tenantId, options = {}, appUserId = null, accountId = null) {
    this.tenantId = tenantId;
    this.appUserId = appUserId;
    this.accountId = accountId;
    this.appName = options.appName || TAB_APP_NAME;
    this.tabUrl = options.tabUrl || DEFAULT_TAB_URL;
    this.appId = options.appId || this._generateGuid();
  }

  async _headers() {
    return { Authorization: `Bearer ${await getValidToken(this.appUserId, this.accountId)}` };
  }

  async deployTab() {
    logger.info(`Checking catalog for existing tab app: "${this.appName}"`);
    const existing = await this._findInCatalog();
    if (existing) {
      logger.info(`Tab app already exists (id=${existing.id}) — skipping publish`);
      return { id: existing.id, alreadyExisted: true };
    }

    logger.info(`Publishing tab app: "${this.appName}"`);
    const zipBuffer = this._buildAppPackage();
    const appInfo = await this._publishToCatalog(zipBuffer);
    logger.info(`Tab app published: ${appInfo.id}`);
    return { ...appInfo, alreadyExisted: false };
  }

  async updateTab(catalogId) {
    logger.info(`Updating tab app: ${catalogId}`);
    const zipBuffer = this._buildAppPackage();
    const headers = await this._headers();

    const res = await fetch(
      `${GRAPH_V1}/appCatalogs/teamsApps/${catalogId}/appDefinitions?requiresReview=false`,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: zipBuffer }
    );

    if (!res.ok) {
      const body = await res.text();
      logger.warn(`Tab update failed: ${res.status} — ${body.slice(0, 200)}`);
      return { updated: false };
    }
    logger.info(`Tab app updated: ${catalogId}`);
    return { updated: true };
  }

  async _findInCatalog() {
    const headers = await this._headers();
    const url = `${GRAPH_V1}/appCatalogs/teamsApps?$filter=displayName eq '${encodeURIComponent(this.appName)}'&distributionMethod=organization`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.value?.[0] || null;
  }

  _buildAppPackage() {
    const zip = new AdmZip();

    const manifest = {
      $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
      manifestVersion: '1.19',
      version: '1.0.0',
      id: this.appId,
      developer: {
        name: 'CloudFuze',
        websiteUrl: 'https://www.cloudfuze.com',
        privacyUrl: 'https://www.cloudfuze.com/privacy',
        termsOfUseUrl: 'https://www.cloudfuze.com/terms',
      },
      name: { short: 'Migration History', full: this.appName },
      description: {
        short: 'Browse your migrated conversations',
        full: 'Browse and read all conversations migrated to Microsoft 365 OneNote by CloudFuze. Supports Gemini, Claude, and other sources.',
      },
      icons: { color: 'color.png', outline: 'outline.png' },
      accentColor: '#0129AC',
      staticTabs: [
        {
          entityId: 'migrationHistory',
          name: 'My Conversations',
          contentUrl: this.tabUrl,
          websiteUrl: this.tabUrl,
          scopes: ['personal'],
        },
      ],
      permissions: ['identity'],
      validDomains: [new URL(this.tabUrl).hostname],
    };

    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    zip.addFile('color.png', this._minimalPng());
    zip.addFile('outline.png', this._minimalPng());
    return zip.toBuffer();
  }

  async _publishToCatalog(zipBuffer) {
    const headers = await this._headers();
    const res = await fetch(`${GRAPH_V1}/appCatalogs/teamsApps?requiresReview=false`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/zip' },
      body: zipBuffer,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to publish tab app: ${res.status} — ${body.slice(0, 400)}`);
    }
    return await res.json();
  }

  _minimalPng() {
    return Buffer.from([
      0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
      0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,
      0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,0x54,0x08,0xD7,0x63,0x60,0x60,0xF8,0x0F,
      0x00,0x00,0x01,0x01,0x00,0x05,0x18,0xD8,0x4D,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,
      0x44,0xAE,0x42,0x60,0x82,
    ]);
  }

  _generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}
