/**
 * Dry-run validator for Google → Google (G2G).
 * Per pair: Vault source checks + Google destination checks.
 * Plus: source-account ≠ destination-account.
 */

import { rollupSeverity, blockerCheck } from '../reportBuilder.js';
import { checkVaultExtractValid, checkVaultUserHasData } from '../checks/vaultSource.js';
import {
  checkDestUserExists, checkDriveQuota, checkFolderNameAvailable,
} from '../checks/googleDestination.js';

export async function validateG2G(ctx) {
  const { pairs = [], config = {}, uploadData, extractPath, sourceAccountId, destAccountId } = ctx;
  const folderName = config.folderName || config.gemName || 'Gemini Conversations';

  const extractChecks = checkVaultExtractValid(extractPath, uploadData);
  const extractFatal = extractChecks.some(c => c.severity === 'blocker');

  // Cross-account sanity
  const crossAccountCheck = (sourceAccountId && destAccountId && sourceAccountId === destAccountId)
    ? [blockerCheck(
        'g2g.same_account',
        'Source ≠ destination Google account',
        'You picked the same Google account for both source and destination.',
        'Pick a different destination account in the Select Accounts step.'
      )]
    : [];

  const results = [];
  for (const p of pairs) {
    const checks = [...crossAccountCheck, ...extractChecks];
    if (!extractFatal) {
      checks.push(...checkVaultUserHasData(uploadData, p.sourceEmail));
    }
    checks.push(...await checkDestUserExists(p.destEmail));
    checks.push(...await checkDriveQuota(p.destEmail, p.expectedConversationCount || 25));
    checks.push(...await checkFolderNameAvailable(p.destEmail, folderName));
    results.push({
      sourceEmail: p.sourceEmail,
      destEmail: p.destEmail,
      status: rollupSeverity(checks),
      checks,
      estimatedFiles: p.expectedConversationCount || 25,
    });
  }
  return results;
}
