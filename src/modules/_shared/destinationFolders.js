/**
 * Universal destination folder structure for all 6 migration directions.
 *
 * Each destination user gets a tree like:
 *
 *   {CustomerName}/
 *   ├── Conversations/                ← bundled DOCXs (one per user)
 *   │   └── {sourceLocalPart}_Conversations.docx
 *   └── Migrated from {Source}/       ← attachment files only (images, PDFs)
 *       ├── image1.png
 *       └── report.pdf
 *
 * Where {Source} is the source platform name: Gemini, Copilot, or Claude.
 *
 * This module owns the NAMING + STRUCTURE conventions. Each direction's
 * runner still calls its own auth-specific folder-creation helper
 * (createDriveFolder for Google Drive, createOneDriveFolder for OneDrive)
 * — this module just tells everyone what to name the folders.
 */

/**
 * Maps internal source keys to user-facing labels that appear in folder names.
 * Keep the keys lowercase + stable; the values are the human-readable strings
 * that customers see in their Drive/OneDrive.
 */
export const SOURCE_LABEL = {
  gemini: 'Gemini',
  copilot: 'Copilot',
  claude: 'Claude',
};

/** Subfolder that holds the bundled conversation DOCX(s). */
export const CONVERSATIONS_SUBFOLDER = 'Conversations';

/**
 * Subfolder name for the attachment files extracted from the source platform.
 * Examples: "Migrated from Gemini", "Migrated from Claude".
 *
 * @param {string} sourceKey   One of the keys in SOURCE_LABEL (lowercase).
 * @returns {string}           The display name to use when creating the folder.
 */
export function attachmentsSubfolderName(sourceKey) {
  const label = SOURCE_LABEL[sourceKey];
  if (!label) {
    throw new Error(`Unknown source key: ${sourceKey}. Expected one of: ${Object.keys(SOURCE_LABEL).join(', ')}`);
  }
  return `Migrated from ${label}`;
}

/**
 * Generates the conversation DOCX filename for a given user, optionally
 * with a part suffix when conversations are split into multiple batches.
 *
 * Examples:
 *   docxFileName('john@example.com')           → 'john_Conversations.docx'
 *   docxFileName('john@example.com', 2, 5)     → 'john_Conversations_Part2.docx'
 *
 * @param {string} sourceEmail   Source-side email address.
 * @param {number} [partIdx]     1-based part index (omit if single file).
 * @param {number} [totalParts]  Total parts (omit if single file).
 * @returns {string}
 */
export function docxFileName(sourceEmail, partIdx, totalParts) {
  const localPart = (sourceEmail || 'user').split('@')[0].replace(/[\\/:*?"<>|]/g, '_') || 'user';
  const suffix = (totalParts && totalParts > 1) ? `_Part${partIdx}` : '';
  return `${localPart}_Conversations${suffix}.docx`;
}
