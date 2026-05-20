import { getValidToken } from '../core/auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:indexWriter');
const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
const INDEX_PATH = 'GemCo/index.json';

/**
 * Writes/updates GemCo/index.json in the target user's OneDrive.
 * Called at end of every migration run (G2C, CL2C).
 * Merges new entries so multiple migration types accumulate in one file.
 */
export class IndexWriter {
  constructor(appUserId = null, accountId = null) {
    this.appUserId = appUserId;
    this.accountId = accountId;
  }

  async _headers() {
    const token = await getValidToken(this.appUserId, this.accountId);
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Store the deployed agent's catalog ID in index.json so the Teams tab can deep-link to it.
   * @param {string} targetEmail
   * @param {string} catalogId - Teams catalog app ID returned by deployAgent()
   */
  async writeAgentId(targetEmail, catalogId) {
    const headers = await this._headers();
    const fileUrl = `${GRAPH_V1}/users/${targetEmail}/drive/root:/${INDEX_PATH}:/content`;

    let existing = { migrations: [] };
    try {
      const readRes = await fetch(fileUrl, { headers });
      if (readRes.ok) existing = await readRes.json();
      if (!Array.isArray(existing.migrations)) existing.migrations = [];
    } catch {}

    existing.agentCatalogId = catalogId;

    const writeRes = await fetch(fileUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(existing, null, 2),
    });

    if (!writeRes.ok) {
      const body = await writeRes.text();
      logger.warn(`IndexWriter: failed to write agentCatalogId for ${targetEmail}: ${writeRes.status} — ${body.slice(0, 200)}`);
      return false;
    }

    logger.info(`IndexWriter: wrote agentCatalogId=${catalogId} for ${targetEmail}`);
    return true;
  }

  /**
   * Write or update index.json for one migration batch.
   * @param {string} targetEmail  - MS user whose OneDrive gets the file
   * @param {object} migrationEntry - { source, notebookName, sectionName, conversations: [{title, pageId, migratedAt}] }
   */
  async writeIndex(targetEmail, migrationEntry) {
    const headers = await this._headers();
    const fileUrl = `${GRAPH_V1}/users/${targetEmail}/drive/root:/${INDEX_PATH}:/content`;

    // 1. Read existing index (may not exist yet)
    let existing = { migrations: [] };
    try {
      const readRes = await fetch(fileUrl, { headers });
      if (readRes.ok) {
        existing = await readRes.json();
        if (!Array.isArray(existing.migrations)) existing.migrations = [];
      }
    } catch {}

    // 2. Remove stale entry for same source (replace on re-migration)
    existing.migrations = existing.migrations.filter(
      m => m.source !== migrationEntry.source
    );

    // 3. Add new entry
    existing.migrations.push({
      ...migrationEntry,
      updatedAt: new Date().toISOString(),
    });

    // 4. Write back
    const writeRes = await fetch(fileUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(existing, null, 2),
    });

    if (!writeRes.ok) {
      const body = await writeRes.text();
      logger.warn(`IndexWriter: failed to write for ${targetEmail}: ${writeRes.status} — ${body.slice(0, 200)}`);
      return false;
    }

    logger.info(`IndexWriter: wrote ${migrationEntry.conversations.length} conversations for ${targetEmail} (source: ${migrationEntry.source})`);
    return true;
  }
}
