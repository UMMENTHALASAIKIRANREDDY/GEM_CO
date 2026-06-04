/**
 * CL2C (Claude → Copilot/OneNote) migration runner.
 *
 * Reads conversations from conversationStore (DB) and creates OneNote pages in
 * each target user's M365 account. The disk extract is deleted at upload time,
 * so this code path is DB-only — there is no disk fallback. Memory + project
 * documents are intentionally not migrated (see uploads-folder cleanup
 * scope decision); only conversations are processed.
 */

import { PagesCreator } from '../../g2c/pagesCreator.js';

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

    const folderName = opts.folderName || 'ClaudeChats';
    const creator = new PagesCreator(null, folderName, appUserId);

    // Date filtering is already applied inside loadConversationsFromStore.
    const filteredConvs = conversations;

    // One OneNote page per conversation
    let oneNoteBlocked = false;
    for (const conv of filteredConvs) {
      if (oneNoteBlocked) break;
      try {
        await creator.createClaudePage(destUserEmail, conv);
        result.filesUploaded++;
        result.files.push({ name: conv.name || 'Untitled', type: 'onenote-page' });
      } catch (err) {
        if (err.message.startsWith('ONENOTE_NOT_PROVISIONED:')) {
          oneNoteBlocked = true;
          result.errors.push(err.message.replace(/^ONENOTE_NOT_PROVISIONED:[^\s]+ — /, ''));
        } else {
          result.errors.push(`Conversation "${(conv.name || 'Untitled').slice(0, 60)}": ${err.message}`);
        }
      }
    }
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}
