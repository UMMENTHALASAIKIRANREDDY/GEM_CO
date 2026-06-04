/**
 * Destination-side Microsoft Graph helpers for C2C migration.
 *
 * Writes data into a destination tenant's OneDrive using an app-only token
 * acquired for THAT tenant via multiTenantAuth. Mirrors C2G's googleService.js
 * shape (createFolder + uploadFile) but targets OneDrive instead of Drive.
 */

import { getTenantAccessToken } from './multiTenantAuth.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('c2c:destGraph');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Resolve a destination user's GUID from their email (UPN).
 * Required because OneDrive endpoints accept GUID more reliably than UPN with special chars.
 *
 * @param {string} destTenantId
 * @param {string} destUserEmail  UPN or mail address
 * @returns {Promise<{ id: string, displayName: string, mail: string }>}
 */
export async function resolveDestUser(destTenantId, destUserEmail) {
  const token = await getTenantAccessToken(destTenantId);
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(destUserEmail)}?$select=id,displayName,mail,userPrincipalName`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Destination user "${destUserEmail}" not found in tenant ${destTenantId}: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    id: data.id,
    displayName: data.displayName || destUserEmail,
    mail: data.mail || data.userPrincipalName || destUserEmail,
  };
}

/**
 * Fetch the destination user's OneDrive root webUrl. Used to derive the
 * destination MySite host (e.g. "trydemos-my.sharepoint.com") so we can
 * rewrite source-OneDrive URLs to point at the equivalent destination path
 * for files that CloudFuze Content Migration handles separately.
 *
 * @param {string} destTenantId
 * @param {string} destUserId
 * @returns {Promise<{ webUrl: string }>}
 */
export async function getDestDriveRoot(destTenantId, destUserId) {
  const token = await getTenantAccessToken(destTenantId);
  const res = await fetch(`${GRAPH_BASE}/users/${destUserId}/drive/root?$select=webUrl`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch dest drive root (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { webUrl: data.webUrl || '' };
}

/**
 * List all users in the destination tenant (admin directory). Used for the
 * "destination user dropdown" in the user-mapping UI.
 *
 * @param {string} destTenantId
 * @param {object} [opts]
 * @returns {Promise<Array<{ id, mail, userPrincipalName, displayName }>>}
 */
export async function listDestTenantUsers(destTenantId, opts = {}) {
  const token = await getTenantAccessToken(destTenantId);
  const pageSize = Math.min(999, Math.max(1, opts.pageSize || 999));
  let url = `${GRAPH_BASE}/users?$select=id,displayName,mail,userPrincipalName,accountEnabled&$top=${pageSize}`;
  const users = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Listing destination users failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const u of data.value || []) {
      if (u.accountEnabled === false) continue;
      users.push({
        id: u.id,
        mail: u.mail || u.userPrincipalName,
        userPrincipalName: u.userPrincipalName,
        displayName: u.displayName || u.userPrincipalName,
      });
    }
    url = data['@odata.nextLink'] || null;
  }
  return users;
}

/**
 * Create a folder in the destination user's OneDrive root. Idempotent: if a
 * folder with the same name exists, returns its metadata instead of failing.
 *
 * @param {string} destTenantId
 * @param {string} destUserId   GUID of destination user (from resolveDestUser)
 * @param {string} folderName
 * @returns {Promise<{ id: string, name: string, webUrl: string }>}
 */
export async function createOneDriveFolder(destTenantId, destUserId, folderName) {
  const token = await getTenantAccessToken(destTenantId);

  // First, check if folder already exists
  const lookup = await fetch(
    `${GRAPH_BASE}/users/${destUserId}/drive/root:/${encodeURIComponent(folderName)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (lookup.ok) {
    const existing = await lookup.json();
    logger.info(`Folder "${folderName}" already exists in user ${destUserId}'s OneDrive`);
    return { id: existing.id, name: existing.name, webUrl: existing.webUrl };
  }

  // Create it
  const res = await fetch(`${GRAPH_BASE}/users/${destUserId}/drive/root/children`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Create OneDrive folder failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return { id: data.id, name: data.name, webUrl: data.webUrl };
}

/**
 * Upload a file (buffer) to a destination user's OneDrive folder.
 * Uses simple PUT upload for files <4 MB; switches to resumable session for larger.
 *
 * @param {string} destTenantId
 * @param {string} destUserId
 * @param {string} folderId       Parent folder ID (from createOneDriveFolder)
 * @param {string} fileName
 * @param {string} mimeType
 * @param {Buffer} content
 * @returns {Promise<{ id, name, webUrl, size }>}
 */
export async function uploadFileToOneDrive(destTenantId, destUserId, folderId, fileName, mimeType, content) {
  const token = await getTenantAccessToken(destTenantId);
  const sizeBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  const SMALL_UPLOAD_THRESHOLD = 4 * 1024 * 1024; // 4 MB

  if (sizeBytes < SMALL_UPLOAD_THRESHOLD) {
    // Simple PUT upload
    const url = `${GRAPH_BASE}/users/${destUserId}/drive/items/${folderId}:/${encodeURIComponent(fileName)}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
      body: content,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OneDrive upload "${fileName}" failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return { id: data.id, name: data.name, webUrl: data.webUrl, size: data.size };
  }

  // Resumable upload for larger files
  const sessionUrl = `${GRAPH_BASE}/users/${destUserId}/drive/items/${folderId}:/${encodeURIComponent(fileName)}:/createUploadSession`;
  const sessionRes = await fetch(sessionUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: fileName } }),
  });
  if (!sessionRes.ok) {
    const body = await sessionRes.text().catch(() => '');
    throw new Error(`Create upload session for "${fileName}" failed (${sessionRes.status}): ${body.slice(0, 300)}`);
  }
  const session = await sessionRes.json();
  const uploadUrl = session.uploadUrl;

  // Send in chunks (10 MB each, must be multiple of 320 KB)
  const CHUNK_SIZE = 10 * 1024 * 1024;
  let offset = 0;
  let finalRes = null;
  while (offset < sizeBytes) {
    const end = Math.min(offset + CHUNK_SIZE, sizeBytes);
    const chunk = content.slice(offset, end);
    const chunkRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${sizeBytes}`,
      },
      body: chunk,
    });
    if (!chunkRes.ok && chunkRes.status !== 202) {
      const body = await chunkRes.text().catch(() => '');
      throw new Error(`Chunk upload for "${fileName}" failed (${chunkRes.status}): ${body.slice(0, 300)}`);
    }
    if (chunkRes.status === 200 || chunkRes.status === 201) {
      finalRes = await chunkRes.json();
    }
    offset = end;
  }
  if (!finalRes) throw new Error(`Upload completed but no final response for "${fileName}"`);
  return { id: finalRes.id, name: finalRes.name, webUrl: finalRes.webUrl, size: finalRes.size };
}
