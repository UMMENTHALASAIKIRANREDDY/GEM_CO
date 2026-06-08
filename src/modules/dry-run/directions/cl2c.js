/**
 * Dry-run validator for Claude → Microsoft Copilot (CL2C).
 * Per pair: Claude source checks + Microsoft destination checks.
 */

import { rollupSeverity } from '../reportBuilder.js';
import { getValidToken } from '../../../core/auth/microsoft.js';
import { checkClaudeUploadValid, checkClaudeUserHasData } from '../checks/claudeSource.js';
import {
  checkMsUserExists, checkMsLicenses, checkOneDriveQuota, checkDestFolderAvailable,
} from '../checks/msDestination.js';

export async function validateCL2C(ctx) {
  const { pairs = [], config = {}, uploadData, appUserId, msAccountId } = ctx;
  // Top-level folder in each user's OneDrive (Phase 2 — DOCX layout).
  const folderName = config.folderName || config.sectionName || 'ClaudeChats';

  const uploadChecks = checkClaudeUploadValid(uploadData);
  const uploadFatal = uploadChecks.some(c => c.severity === 'blocker');

  let destToken = null;
  try { destToken = await getValidToken(appUserId, msAccountId); } catch { /* fall through */ }

  const results = [];
  for (const p of pairs) {
    const checks = [...uploadChecks];
    if (!uploadFatal) {
      checks.push(...checkClaudeUserHasData(uploadData, p.sourceEmail || p.sourceUuid));
    }
    if (destToken) {
      checks.push(...await checkMsUserExists(destToken, p.destEmail));
      checks.push(...await checkMsLicenses(destToken, p.destEmail));
      checks.push(...await checkOneDriveQuota(destToken, p.destEmail, p.expectedConversationCount || 25));
      checks.push(...await checkDestFolderAvailable(destToken, p.destEmail, folderName, 'Claude'));
    } else {
      checks.push({
        id: 'dest.ms.no_token',
        label: 'Microsoft Graph token',
        severity: 'blocker',
        message: 'Could not acquire Microsoft access token.',
        fix: 'Reconnect Microsoft 365.',
      });
    }
    results.push({
      sourceEmail: p.sourceEmail || p.sourceUuid,
      destEmail: p.destEmail,
      status: rollupSeverity(checks),
      checks,
      estimatedFiles: p.expectedConversationCount || 25,
    });
  }
  return results;
}
