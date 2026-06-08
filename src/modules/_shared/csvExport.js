/**
 * Shared CSV export for migration batch reports.
 *
 * Single source of truth so every direction's /reports/:id/csv endpoint
 * (g2g, c2c, and the g2c catch-all that serves g2c/c2g/cl2g/cl2c) produces
 * identical column ordering and field semantics.
 *
 * Columns (in order):
 *   1. Batch ID                  ← batch._id
 *   2. Source Email              ← u.email
 *   3. Destination Email         ← u.destEmail
 *   4. Status                    ← u.status (success / partial / failed)
 *   5. Total Conversations       ← u.conversations_processed
 *                                  (count found in the source)
 *   6. Migrated Conversations    ← u.migrated_conversations
 *                                  (count successfully written to the destination)
 *   7. Files                     ← u.files_uploaded
 *                                  (attachments uploaded — images, PDFs, code
 *                                   blocks. The conversation DOCX/OneNote page
 *                                   is NOT counted.)
 *   8. Errors                    ← u.error_count
 *   9. Error Message             ← all errors joined with "; " (one row per user)
 *
 * Fallbacks:
 *   - migrated_conversations falls back to pages_created when not set yet
 *     (legacy uploads).
 *   - files_uploaded falls back to attachments_uploaded or files_created
 *     (different runners used different field names historically — never
 *     pages_created, because that IS the conversation itself, not a file).
 *
 * One row per user — multiple errors are joined with "; " in the Error Message
 * column. This prevents the appearance of duplicate rows in the CSV.
 */

export const CSV_HEADERS = [
  'Batch ID',
  'Source Email',
  'Destination Email',
  'Status',
  'Total Conversations',
  'Migrated Conversations',
  'Files',
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
    const totalConvs = u.conversations_processed ?? 0;
    // migrated_conversations may not be set on older batches — fall back to
    // pages_created (which historically held the same value for successful
    // pages/DOCXs) or to totalConvs when status === 'success' (all migrated).
    const migratedConvs = u.migrated_conversations
      ?? (u.status === 'success' ? totalConvs : (u.pages_created ?? 0));
    // Files = attachments only. NOT the conversation DOCX/OneNote page.
    const files = u.files_uploaded ?? u.attachments_uploaded ?? u.files_created ?? 0;
    const errorCount = u.error_count ?? 0;

    // Join all errors into a single "; "-separated string so the CSV has one
    // row per user, not one row per error. Duplicate rows in the CSV (same
    // user, same status) read as "the migration ran twice" — never the intent.
    let errorMsg = '';
    if (Array.isArray(u.errors) && u.errors.length > 0) {
      errorMsg = u.errors
        .map(e => e?.error_message || e?.error || (typeof e === 'string' ? e : ''))
        .filter(Boolean)
        .join('; ');
    }
    rows.push([batchId, sourceEmail, destEmail, status, totalConvs, migratedConvs, files, errorCount, errorMsg]);
  }

  return rows.map(r => r.map(_quote).join(',')).join('\n');
}
