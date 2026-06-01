/**
 * Claude export source checks. Used by CL2G, CL2C.
 *
 * Operates on the parsed uploadData (which contains `users` from the
 * extracted Claude ZIP). No network calls.
 */

import { passingCheck, warningCheck, blockerCheck } from '../reportBuilder.js';

export function checkClaudeUploadValid(uploadData) {
  if (!uploadData) {
    return [blockerCheck(
      'source.claude.no_upload',
      'Claude export',
      'No Claude export uploaded yet.',
      'Upload your Claude export ZIP first.'
    )];
  }
  if (!Array.isArray(uploadData.users) || uploadData.users.length === 0) {
    return [blockerCheck(
      'source.claude.no_users',
      'Claude export users',
      'Claude export contains no users.',
      'Re-upload the export ZIP — it may be empty or malformed.'
    )];
  }
  return [passingCheck(
    'source.claude.upload_valid',
    'Claude export',
    {
      userCount: uploadData.users.length,
      conversationCount: uploadData.totalConversations || 0,
    }
  )];
}

/**
 * Verify a specific source user has data (by email_address or uuid lookup).
 */
export function checkClaudeUserHasData(uploadData, sourceIdentifier) {
  if (!sourceIdentifier) {
    return [blockerCheck('source.claude.user.missing', 'Source user', 'No source identifier.')];
  }
  if (!uploadData?.users) {
    return [warningCheck('source.claude.user.unknown', `Source user ${sourceIdentifier}`, 'Upload metadata unavailable.')];
  }
  const id = String(sourceIdentifier).toLowerCase();
  const u = uploadData.users.find(x =>
    (x.email_address || '').toLowerCase() === id ||
    (x.uuid || '').toLowerCase() === id
  );
  if (!u) {
    return [blockerCheck(
      'source.claude.user.missing',
      `Source user ${sourceIdentifier}`,
      'Not present in the Claude export.',
      'Verify the export includes this user, or remove from mapping.'
    )];
  }
  const convs = u.conversation_count ?? u.conversationCount ?? 0;
  if (convs === 0) {
    return [warningCheck(
      'source.claude.user.empty',
      `Source user ${sourceIdentifier}`,
      `${sourceIdentifier} has 0 conversations in the Claude export — no-op for live run.`
    )];
  }
  return [passingCheck('source.claude.user.ok', `Source user ${sourceIdentifier}`, { conversationCount: convs })];
}
