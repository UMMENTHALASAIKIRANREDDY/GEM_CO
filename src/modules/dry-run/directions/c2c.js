/**
 * Dry-run validator for Copilot → Copilot cross-tenant (C2C).
 * Source tenant Copilot + destination tenant Microsoft.
 */

import { rollupSeverity, blockerCheck } from '../reportBuilder.js';
import {
  checkCopilotSourceUser, checkCopilotLicense, checkCopilotInteractionsExist,
} from '../checks/copilotSource.js';
import {
  checkMsUserExists, checkMsLicenses, checkOneDriveQuota, checkDestFolderAvailable,
} from '../checks/msDestination.js';

export async function validateC2C(ctx) {
  const { pairs = [], config = {}, sourceTenantId, destTenantId, sourceToken, destToken } = ctx;
  // Top-level folder in each user's OneDrive. Post-Phase-2 the migration
  // writes {folderName}/Conversations/{...}.docx + {folderName}/Migrated from Copilot/.
  const folderName = config.folderName || config.sectionName || 'CopilotChats';

  const crossTenantCheck = (sourceTenantId && destTenantId && sourceTenantId === destTenantId)
    ? [blockerCheck(
        'c2c.same_tenant',
        'Source ≠ destination tenant',
        'Source and destination tenant IDs are the same.',
        'Pick a different tenant in the Select Tenants step.'
      )]
    : [];

  const results = [];
  for (const p of pairs) {
    const checks = [...crossTenantCheck];
    if (sourceToken) {
      checks.push(...await checkCopilotSourceUser(sourceToken, p.sourceEmail, { tenantLabel: 'source' }));
      // Interactions check is the source of truth — license name matching
      // is unreliable across tenants. Only fall back to license check if
      // interactions read fails.
      const interactionsChecks = await checkCopilotInteractionsExist(sourceToken, p.sourceEmail);
      checks.push(...interactionsChecks);
      const interactionsOK = interactionsChecks.every(c => c.severity === 'ok');
      if (!interactionsOK) {
        checks.push(...await checkCopilotLicense(sourceToken, p.sourceEmail));
      }
    } else {
      checks.push(blockerCheck(
        'source.c2c.no_token',
        'Source tenant access',
        'Could not acquire source-tenant Graph token.',
        'Verify source tenant admin consent is granted (use initiate_tenant_consent).'
      ));
    }
    if (destToken) {
      checks.push(...await checkMsUserExists(destToken, p.destEmail));
      checks.push(...await checkMsLicenses(destToken, p.destEmail));
      checks.push(...await checkOneDriveQuota(destToken, p.destEmail, p.expectedConversationCount || 25));
      checks.push(...await checkDestFolderAvailable(destToken, p.destEmail, folderName, 'Copilot'));
    } else {
      checks.push(blockerCheck(
        'dest.c2c.no_token',
        'Destination tenant access',
        'Could not acquire destination-tenant Graph token.',
        'Verify destination tenant admin consent is granted (use initiate_tenant_consent).'
      ));
    }
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
