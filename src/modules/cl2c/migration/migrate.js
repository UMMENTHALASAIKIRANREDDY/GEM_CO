/**
 * CL2C (Claude → Copilot/M365) migration runner.
 *
 * Phase 2 of the OneNote → DOCX migration: this no longer creates OneNote
 * pages. Instead, all of a user's conversations are bundled into a single
 * DOCX file and uploaded to the destination user's OneDrive, in the
 * universal 2-subfolder layout used by every direction:
 *
 *   {folderName}/
 *   ├── Conversations/{displayName}_Conversations.docx
 *   └── Migrated from Claude/      ← empty for now (Claude inlines media)
 *
 * Why: OneNote requires a per-user admin-console step to provision the
 * default notebook (`ONENOTE_NOT_PROVISIONED` error). OneDrive auto-
 * provisions on first write, so dropping OneNote entirely removes that
 * manual step.
 *
 * Reuses CL2G's `buildAllConversationsDocx` (same Claude source schema).
 * Talks to Microsoft Graph via a delegated token from the app user (admin
 * who connected M365 in GEM_CO).
 */

import { buildAllConversationsDocx } from '../../cl2g/migration/migrate.js';
import { getValidToken } from '../../../core/auth/microsoft.js';
import {
  createOneDriveFolderDelegated,
  uploadFileToOneDriveDelegated,
} from '../../_shared/oneDriveDelegated.js';
import {
  CONVERSATIONS_SUBFOLDER,
  attachmentsSubfolderName,
  docxFileName,
} from '../../_shared/destinationFolders.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Same per-DOCX cap as CL2G. Bundles up to 5000 conversations per file; if
// the user has more, they get _Part1, _Part2, etc.
const BATCH_SIZE = 5000;

export async function migrateUserPair({
  sourceUuid,
  sourceDisplayName,
  destUserEmail,
  appUserId,
  uploadId,
  sourceEmail,
}, opts = {}) {
  const result = {
    sourceUuid,
    sourceDisplayName: sourceDisplayName || sourceUuid,
    destUserEmail,
    conversationsCount: 0,
    filesUploaded: 0,
    attachmentsUploaded: 0,  // always 0 for CL2C — Claude inlines media
    errors: [],
    files: [],
  };

  try {
    const { loadConversationsFromStore } = await import('../../_shared/conversationStore.js');
    const conversations = await loadConversationsFromStore({
      appUserId,
      sourceEmail,
      uploadId,
      fromDate: opts?.fromDate,
      toDate: opts?.toDate,
      includeMigrated: !opts?.isResume,
    });

    if (!conversations || conversations.length === 0) {
      result.errors.push(`No conversations found in conversationStore for ${sourceEmail}. The upload may have failed at ingest time — please re-upload the ZIP.`);
      return result;
    }
    result.conversationsCount = conversations.length;

    // Date filtering already applied inside loadConversationsFromStore.
    const filteredConvs = conversations;

    // Folder layout in destination user's OneDrive
    const folderName = opts.folderName || 'ClaudeChats';
    const filesSubfolderName = attachmentsSubfolderName('claude');

    const token = await getValidToken(appUserId);
    const mainFolder = await createOneDriveFolderDelegated(token, destUserEmail, folderName);
    const convoFolder = await createOneDriveFolderDelegated(token, destUserEmail, CONVERSATIONS_SUBFOLDER, mainFolder.id);
    // Files folder is created for layout parity even though Claude doesn't
    // produce standalone attachments today (media is inlined into the DOCX).
    // eslint-disable-next-line no-unused-vars
    const filesFolder = await createOneDriveFolderDelegated(token, destUserEmail, filesSubfolderName, mainFolder.id);
    console.log(`[CL2C] Folder layout in ${destUserEmail}'s OneDrive: ${folderName}/ → ${CONVERSATIONS_SUBFOLDER}/, ${filesSubfolderName}/ (empty)`);

    // Build + upload bundled DOCX(s)
    const batches = [];
    for (let i = 0; i < filteredConvs.length; i += BATCH_SIZE) {
      batches.push(filteredConvs.slice(i, i + BATCH_SIZE));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const startIdx = batchIdx * BATCH_SIZE + 1;
      const endIdx = Math.min((batchIdx + 1) * BATCH_SIZE, filteredConvs.length);
      const docxName = docxFileName(sourceEmail || sourceDisplayName, batchIdx + 1, batches.length);

      try {
        console.log(`[CL2C] Building DOCX batch ${batchIdx + 1}/${batches.length} (${startIdx}-${endIdx} of ${filteredConvs.length})...`);
        const buffer = await buildAllConversationsDocx(batch, sourceDisplayName);

        // Refresh token per batch — large bundles can blow past the
        // 60-min delegated token TTL.
        const freshToken = await getValidToken(appUserId);
        const uploaded = await uploadFileToOneDriveDelegated(
          freshToken, destUserEmail, convoFolder.id, docxName, DOCX_MIME, buffer
        );

        result.filesUploaded++;
        result.files.push({
          name: docxName,
          oneDriveItemId: uploaded.id,
          webUrl: uploaded.webUrl,
          batchInfo: { part: batchIdx + 1, totalParts: batches.length, conversationRange: [startIdx, endIdx, filteredConvs.length] },
        });
        console.log(`[CL2C] Uploaded: ${docxName} (${buffer.length} bytes)`);
      } catch (err) {
        result.errors.push(`Conversations batch ${batchIdx + 1}: ${err.message}`);
      }
    }
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}
