/**
 * OneDrive helpers using a DELEGATED Microsoft Graph token.
 *
 * Used by G2C and CL2C, where the migration runs on behalf of the app user
 * (an admin who connected M365 in the GEM_CO UI). Targets a destination
 * user by EMAIL (not GUID).
 *
 * C2C (Copilot → Copilot, cross-tenant) does NOT use this — it has its own
 * app-only token flow in `c2c/destGraph.js`. The two flows kept separate
 * because their auth bootstrap differs (delegated vs app-only consent).
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Create a folder in a user's OneDrive (or look up an existing one).
 *
 * @param {string} token            Delegated Graph token (Files.ReadWrite.All scope).
 * @param {string} userEmail        Destination user UPN / email.
 * @param {string} folderName       Folder display name.
 * @param {string} [parentFolderId] Optional. If omitted, creates at OneDrive root.
 * @returns {Promise<{id: string, name: string, webUrl: string}>}
 */
export async function createOneDriveFolderDelegated(token, userEmail, folderName, parentFolderId) {
  const headers = { Authorization: `Bearer ${token}` };

  // Look up first (idempotent re-runs)
  if (parentFolderId) {
    const childLookup = await fetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/drive/items/${parentFolderId}/children?$filter=name eq '${folderName.replace(/'/g, "''")}'&$top=1`,
      { headers }
    );
    if (childLookup.ok) {
      const data = await childLookup.json();
      const existing = data.value?.[0];
      if (existing) return { id: existing.id, name: existing.name, webUrl: existing.webUrl };
    }
  } else {
    const rootLookup = await fetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/drive/root:/${encodeURIComponent(folderName)}`,
      { headers }
    );
    if (rootLookup.ok) {
      const existing = await rootLookup.json();
      return { id: existing.id, name: existing.name, webUrl: existing.webUrl };
    }
  }

  // Create
  const createUrl = parentFolderId
    ? `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/drive/items/${parentFolderId}/children`
    : `${GRAPH_BASE}/users/${encodeURIComponent(userEmail)}/drive/root/children`;
  const res = await fetch(createUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Create OneDrive folder "${folderName}" failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return { id: data.id, name: data.name, webUrl: data.webUrl };
}

/**
 * Upload a file buffer to a OneDrive folder.
 * Uses simple PUT for <4 MB, resumable session for larger.
 *
 * @param {string} token       Delegated Graph token.
 * @param {string} userEmail   Destination user UPN / email.
 * @param {string} folderId    Parent folder ID (from createOneDriveFolderDelegated).
 * @param {string} fileName
 * @param {string} mimeType
 * @param {Buffer} content
 * @returns {Promise<{id, name, webUrl, size}>}
 */
export async function uploadFileToOneDriveDelegated(token, userEmail, folderId, fileName, mimeType, content) {
  const sizeBytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  const SMALL_UPLOAD_THRESHOLD = 4 * 1024 * 1024;
  const userPath = encodeURIComponent(userEmail);
  const fname = encodeURIComponent(fileName);

  if (sizeBytes < SMALL_UPLOAD_THRESHOLD) {
    const url = `${GRAPH_BASE}/users/${userPath}/drive/items/${folderId}:/${fname}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: content,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OneDrive upload "${fileName}" failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return { id: data.id, name: data.name, webUrl: data.webUrl, size: data.size };
  }

  // Resumable upload for larger files (e.g. bundled DOCX with many conversations)
  const sessionUrl = `${GRAPH_BASE}/users/${userPath}/drive/items/${folderId}:/${fname}:/createUploadSession`;
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

  const CHUNK_SIZE = 10 * 1024 * 1024;  // 10 MB (must be multiple of 320 KB)
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
      throw new Error(`Chunk upload at offset ${offset} failed (${chunkRes.status}): ${body.slice(0, 300)}`);
    }
    if (chunkRes.status === 200 || chunkRes.status === 201) {
      finalRes = await chunkRes.json();
    }
    offset = end;
  }
  if (!finalRes) throw new Error(`Upload session completed but no final response received for "${fileName}"`);
  return { id: finalRes.id, name: finalRes.name, webUrl: finalRes.webUrl, size: finalRes.size };
}
