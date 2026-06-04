/**
 * Dry-run validator for Google Vault → Microsoft Copilot (G2C).
 * Per pair: Vault source checks + MS destination checks.
 */

import { rollupSeverity } from '../reportBuilder.js';
import { getValidToken } from '../../../core/auth/microsoft.js';
import {
  checkVaultExtractValid, checkVaultUserHasData,
} from '../checks/vaultSource.js';
import {
  checkMsUserExists, checkMsLicenses, checkOneDriveQuota, checkOneNoteSectionAvailable,
} from '../checks/msDestination.js';

export async function validateG2C(ctx) {
  const { pairs = [], config = {}, uploadData, extractPath, appUserId, msAccountId } = ctx;
  const sectionName = config.folderName || config.sectionName || 'CopilotChats';

  // Global: extract validity (one check shared across all pairs). Accepts
  // either a disk extract OR DB-persisted conversations.
  const extractChecks = checkVaultExtractValid(extractPath, uploadData);
  const extractFatal = extractChecks.some(c => c.severity === 'blocker');

  // Destination Graph token (delegated, since UI side is delegated MS OAuth).
  let destToken = null;
  try {
    destToken = await getValidToken(appUserId, msAccountId);
  } catch { /* fall through */ }

  const results = [];
  for (const p of pairs) {
    const destEmail = p.destEmail || p.destUserEmail || '';
    const checks = [...extractChecks];
    if (!extractFatal) {
      checks.push(...checkVaultUserHasData(uploadData, p.sourceEmail));
    }
    if (destToken) {
      checks.push(...await checkMsUserExists(destToken, destEmail));
      checks.push(...await checkMsLicenses(destToken, destEmail));
      checks.push(...await checkOneDriveQuota(destToken, destEmail, p.expectedConversationCount || 25));
      checks.push(...await checkOneNoteSectionAvailable(destToken, destEmail, sectionName));
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
      sourceEmail: p.sourceEmail,
      destEmail,
      status: rollupSeverity(checks),
      checks,
      estimatedFiles: p.expectedConversationCount || 25,
    });
  }
  return results;
}
