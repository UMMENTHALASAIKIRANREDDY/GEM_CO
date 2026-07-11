/**
 * Dry-run validator for Claude → Gemini (CL2G).
 * Per pair: Claude source checks + Google destination checks.
 */

import { rollupSeverity } from '../reportBuilder.js';
import { checkClaudeUploadValid, checkClaudeUserHasData } from '../checks/claudeSource.js';
import {
  checkDestUserExists, checkDriveQuota, checkFolderNameAvailable,
} from '../checks/googleDestination.js';

export async function validateCL2G(ctx) {
  const { pairs = [], config = {}, uploadData } = ctx;
  const folderName = config.folderName || 'ClaudeChats';

  const uploadChecks = checkClaudeUploadValid(uploadData);
  const uploadFatal = uploadChecks.some(c => c.severity === 'blocker');

  const results = [];
  for (const p of pairs) {
    const checks = [...uploadChecks];
    if (!uploadFatal) {
      checks.push(...checkClaudeUserHasData(uploadData, p.sourceEmail || p.sourceUuid));
    }
    checks.push(...await checkDestUserExists(p.destEmail));
    checks.push(...await checkDriveQuota(p.destEmail, p.expectedConversationCount || 25));
    checks.push(...await checkFolderNameAvailable(p.destEmail, folderName));
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
