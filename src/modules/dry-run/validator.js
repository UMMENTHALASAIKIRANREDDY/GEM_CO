/**
 * Dry-run validator — single entry point for all 6 migration directions.
 *
 * Usage from inside a migration route's `if (isDryRun)` branch:
 *
 *   import { runDryRunValidator } from '../dry-run/validator.js';
 *   const report = await runDryRunValidator({
 *     migDir:    'copilot-gemini',
 *     pairs,                  // [{ sourceEmail, destEmail, sourceUserId, ... }]
 *     config:    { folderName, fromDate, toDate },
 *     appUserId, googleEmail, msEmail,
 *     // direction-specific context (uploadData, extractPath, tenantIds, etc.)
 *   });
 *
 *   // Persist to migrationWorkspaces.dryRunReport
 *   await db().collection('migrationWorkspaces').updateOne(
 *     { _id: batchId },
 *     { $set: { dryRunReport: report } }
 *   );
 *
 * The validator NEVER throws — every failure becomes a check result so the
 * report is always renderable. Network/API errors are wrapped as blocker
 * checks with a sensible message.
 */

import { createReport, hasBlockers, addUserPair, finalizeSummary } from './reportBuilder.js';
import { validateCommonConfigAndMapping } from './checks/common.js';

import { validateC2G  } from './directions/c2g.js';
import { validateG2C  } from './directions/g2c.js';
import { validateCL2G } from './directions/cl2g.js';
import { validateCL2C } from './directions/cl2c.js';
import { validateG2G  } from './directions/g2g.js';
import { validateC2C  } from './directions/c2c.js';

const DIRECTION_VALIDATORS = {
  'copilot-gemini':  validateC2G,
  'gemini-copilot':  validateG2C,
  'claude-gemini':   validateCL2G,
  'claude-copilot':  validateCL2C,
  'gemini-gemini':   validateG2G,
  'copilot-copilot': validateC2C,
};

/**
 * @param {Object} ctx
 * @param {string} ctx.migDir
 * @param {Array}  ctx.pairs            user pairs [{sourceEmail, destEmail, ...}]
 * @param {Object} ctx.config           {folderName, fromDate, toDate}
 * @param {string} ctx.appUserId
 * @param {Object} [ctx.uploadData]     present for ZIP-based combos
 * @param {string} [ctx.extractPath]    present for Vault/Claude extracts
 * @param {string} [ctx.sourceAccountId]
 * @param {string} [ctx.destAccountId]
 * @param {string} [ctx.sourceTenantId]
 * @param {string} [ctx.destTenantId]
 * @returns {Promise<import('./reportBuilder.js').DryRunReport>}
 */
export async function runDryRunValidator(ctx) {
  const { migDir, config = {}, pairs = [] } = ctx;
  const report = createReport({ migDir, config });

  // 1. Common config + mapping checks (always run, fast, no network)
  const globalChecks = validateCommonConfigAndMapping({ config, pairs });
  report.globalChecks.push(...globalChecks);

  // 2. Short-circuit if config/mapping has blockers — no point hitting APIs yet
  if (hasBlockers(report)) {
    return finalizeSummary(report);
  }

  // 3. Direction-specific per-user validation
  const directionFn = DIRECTION_VALIDATORS[migDir];
  if (!directionFn) {
    report.globalChecks.push({
      id: 'global.unknown_direction',
      label: 'Unknown migration direction',
      severity: 'blocker',
      message: `No dry-run validator registered for "${migDir}".`,
    });
    return report;
  }

  try {
    // Each direction validator returns an array of UserPairReport
    const userReports = await directionFn(ctx);
    for (const ur of userReports) addUserPair(report, ur);
  } catch (e) {
    // Validator threw — fail safe by adding a global blocker
    report.globalChecks.push({
      id: 'global.validator_error',
      label: 'Dry-run validator failed',
      severity: 'blocker',
      message: e.message || String(e),
      fix: 'Check the server logs and retry. If the problem persists, contact support.',
    });
  }

  return finalizeSummary(report);
}
