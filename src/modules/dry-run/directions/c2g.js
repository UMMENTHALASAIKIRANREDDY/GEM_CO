/**
 * Dry-run validator for Copilot → Gemini (C2G).
 * Per pair: Copilot source checks + Google destination checks.
 */

import { rollupSeverity } from '../reportBuilder.js';
import { createSourceGraphClient } from '../../c2g/copilotService.js';
import {
  checkCopilotSourceUser, checkCopilotLicense, checkCopilotInteractionsExist,
} from '../checks/copilotSource.js';
import {
  checkDestUserExists, checkDriveQuota, checkFolderNameAvailable,
} from '../checks/googleDestination.js';

export async function validateC2G({ pairs = [], config = {} }) {
  const folderName = config.folderName || 'CopilotChats';

  // Fetch app-only Graph token ONCE (shared across all pairs).
  let sourceToken = null;
  try {
    const client = await createSourceGraphClient();
    sourceToken = client.accessToken;
  } catch (e) {
    // No token → mark everything as a source blocker but still try Google side.
    sourceToken = null;
  }

  const results = [];
  for (const p of pairs) {
    // c2g routes build pairs with destUserEmail (legacy field name)
    const destEmail = p.destEmail || p.destUserEmail || '';
    const checks = [];
    if (sourceToken) {
      checks.push(...await checkCopilotSourceUser(sourceToken, p.sourceEmail));
      // Interactions check is the most reliable signal — run it first.
      const interactionsChecks = await checkCopilotInteractionsExist(sourceToken, p.sourceEmail);
      checks.push(...interactionsChecks);
      // Only run license check if interactions reads succeeded; license
      // detection by service-plan name is unreliable (different SKU names
      // across tenants), and a successful interactions call already proves
      // the user has effective Copilot access.
      const interactionsOK = interactionsChecks.every(c => c.severity === 'ok');
      if (!interactionsOK) {
        checks.push(...await checkCopilotLicense(sourceToken, p.sourceEmail));
      }
    } else {
      checks.push({
        id: 'source.copilot.no_token',
        label: 'Source Microsoft Graph token',
        severity: 'blocker',
        message: 'Could not acquire source-tenant Graph token.',
        fix: 'Verify SOURCE_TENANT_ID / SOURCE_CLIENT_ID / SOURCE_CLIENT_SECRET env vars.',
      });
    }
    checks.push(...await checkDestUserExists(destEmail));
    const estFiles = p.expectedConversationCount; // may be undefined — that's fine, UI hides the line
    checks.push(...await checkDriveQuota(destEmail, estFiles || 0));
    checks.push(...await checkFolderNameAvailable(destEmail, folderName));

    results.push({
      sourceEmail: p.sourceEmail,
      destEmail,
      status: rollupSeverity(checks),
      checks,
      estimatedFiles: estFiles, // undefined when unknown
    });
  }
  return results;
}
