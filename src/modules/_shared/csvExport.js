/**
 * Shared CSV export for migration batch reports.
 *
 * Single source of truth so every direction's /reports/:id/csv endpoint
 * (g2g, c2c, and the g2c catch-all that serves g2c/c2g/cl2g/cl2c) produces
 * identical column ordering and field semantics.
 *
 * Columns (in order):
 *   1. Batch ID              ← batch._id           (lets ops look up the batch)
 *   2. Source Email          ← u.email
 *   3. Destination Email     ← u.destEmail
 *   4. Status                ← u.status (success / partial / failed)
 *   5. Files Uploaded        ← u.pages_created OR u.files_created  (DOCX or OneNote pages)
 *   6. Conversations         ← u.conversations_processed           (source conversation count)
 *   7. Errors                ← u.error_count
 *   8. Error Message         ← per-error row, or empty for successes
 *
 * If a user has multiple errors, one row is emitted per error (others fields repeat).
 */

export const CSV_HEADERS = [
  'Batch ID',
  'Source Email',
  'Destination Email',
  'Status',
  'Files Uploaded',
  'Conversations',
  'Errors',
  'Error Message',
];

function _quote(field) {
  return `"${String(field ?? '').replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from a migrationWorkspaces batch document.
 *
 * Tolerates both batch.users and batch.report.users shapes — different
 * directions historically stored the per-user array in different places.
 *
 * @param {object} batch  the migrationWorkspaces document
 * @returns {string}      complete CSV (header + body), CRLF-free
 */
export function buildBatchCsv(batch) {
  const users = batch?.users || batch?.report?.users || [];
  const batchId = String(batch?._id ?? '');
  const rows = [CSV_HEADERS];

  for (const u of users) {
    const sourceEmail = u.email || '';
    const destEmail = u.destEmail || '';
    const status = u.status || '';
    const filesUploaded = u.pages_created ?? u.files_created ?? 0;
    const conversations = u.conversations_processed ?? 0;
    const errorCount = u.error_count ?? 0;

    if (Array.isArray(u.errors) && u.errors.length > 0) {
      for (const e of u.errors) {
        const msg = e?.error_message || e?.error || (typeof e === 'string' ? e : '');
        rows.push([batchId, sourceEmail, destEmail, status, filesUploaded, conversations, errorCount, msg]);
      }
    } else {
      rows.push([batchId, sourceEmail, destEmail, status, filesUploaded, conversations, errorCount, '']);
    }
  }

  return rows.map(r => r.map(_quote).join(',')).join('\n');
}
