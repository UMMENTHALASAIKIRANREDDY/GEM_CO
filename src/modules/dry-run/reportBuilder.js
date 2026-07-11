/**
 * Dry-run report data structures + helpers.
 *
 * The report is the single source of truth for what the validator detected.
 * It is JSON-persisted to migrationWorkspaces.dryRunReport so both the UI
 * and the agent can read it.
 */

export const Severity = Object.freeze({
  OK:       'ok',
  WARNING:  'warning',
  BLOCKER:  'blocker',
});

/**
 * One check result entry within a user pair report.
 *
 * @typedef {Object} CheckResult
 * @property {string}   id        short stable identifier (e.g. "dest.user.exists")
 * @property {string}   label     human-readable label
 * @property {string}   severity  Severity.*
 * @property {string}   [message] details if not OK (what failed and why)
 * @property {string}   [fix]     suggested user action
 * @property {Object}   [data]    structured payload (counts, names, etc.)
 */

/**
 * @typedef {Object} UserPairReport
 * @property {string}   sourceEmail
 * @property {string}   destEmail
 * @property {string}   status         Severity.* — worst-case across all checks
 * @property {CheckResult[]} checks
 * @property {number}   estimatedFiles  predicted destination file/page count
 * @property {string}   [estimatedDuration] human-readable, e.g. "~3 min"
 */

/**
 * @typedef {Object} DryRunReport
 * @property {string}   migDir
 * @property {string}   generatedAt    ISO timestamp
 * @property {Object}   config         folderName, fromDate, toDate, dryRun
 * @property {Object}   summary        { totalUsers, ready, warning, blocker }
 * @property {CheckResult[]} globalChecks  config/mapping issues (not per-user)
 * @property {UserPairReport[]} users
 */

export function createReport({ migDir, config }) {
  return {
    migDir,
    generatedAt: new Date().toISOString(),
    config: config || {},
    summary: { totalUsers: 0, ready: 0, warning: 0, blocker: 0 },
    globalChecks: [],
    users: [],
  };
}

export function makeCheck({ id, label, severity = Severity.OK, message, fix, data }) {
  const check = { id, label, severity };
  if (message) check.message = message;
  if (fix) check.fix = fix;
  if (data) check.data = data;
  return check;
}

export function passingCheck(id, label, data) {
  return makeCheck({ id, label, severity: Severity.OK, data });
}

export function warningCheck(id, label, message, fix, data) {
  return makeCheck({ id, label, severity: Severity.WARNING, message, fix, data });
}

export function blockerCheck(id, label, message, fix, data) {
  return makeCheck({ id, label, severity: Severity.BLOCKER, message, fix, data });
}

/**
 * Roll up a list of CheckResults to the worst severity present.
 */
export function rollupSeverity(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return Severity.OK;
  if (checks.some(c => c.severity === Severity.BLOCKER)) return Severity.BLOCKER;
  if (checks.some(c => c.severity === Severity.WARNING)) return Severity.WARNING;
  return Severity.OK;
}

/**
 * Add a user pair report and update summary counts.
 */
export function addUserPair(report, userPair) {
  userPair.status = rollupSeverity(userPair.checks);
  report.users.push(userPair);
  report.summary.totalUsers++;
  if (userPair.status === Severity.BLOCKER)      report.summary.blocker++;
  else if (userPair.status === Severity.WARNING) report.summary.warning++;
  else                                            report.summary.ready++;
}

/**
 * Has at least one blocker (either at the global level or any user pair).
 */
export function hasBlockers(report) {
  if (report.globalChecks.some(c => c.severity === Severity.BLOCKER)) return true;
  if (report.summary.blocker > 0) return true;
  return false;
}

/**
 * Refresh the summary counts so global blockers/warnings are visible to UI.
 * Call before persisting so the header in the UI is accurate.
 */
export function finalizeSummary(report) {
  const gb = report.globalChecks.filter(c => c.severity === Severity.BLOCKER).length;
  const gw = report.globalChecks.filter(c => c.severity === Severity.WARNING).length;
  report.summary.globalBlocker = gb;
  report.summary.globalWarning = gw;
  // Roll global issues into the top-line blocker/warning counts so the header
  // colour and message reflect them — UI doesn't have to do this math.
  report.summary.blocker = (report.summary.blocker || 0) + gb;
  report.summary.warning = (report.summary.warning || 0) + gw;
  return report;
}
