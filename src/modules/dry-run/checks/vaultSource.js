/**
 * Google Vault export source checks. Used by G2C, G2G.
 *
 * Operates on the already-extracted vault export folder (extractPath) and
 * the parsed uploadData. No network calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { passingCheck, warningCheck, blockerCheck } from '../reportBuilder.js';

/**
 * Verify the Vault export is migratable. Accepts any of these signals:
 *   1. uploadData.conversationsPersisted > 0   → new uploads
 *   2. uploadData.totalConversations > 0       → legacy uploads (pre-DB-only refactor)
 *   3. conversationStore actually has rows     → most authoritative; queried as fallback
 *   4. extractPath still on disk with XMLs     → very-legacy uploads
 * A blocker only fires when ALL of these are missing.
 *
 * NOTE: this function is async now because option (3) queries the DB.
 */
export async function checkVaultExtractValid(extractPath, uploadData) {
  const persisted = uploadData?.conversationsPersisted ?? 0;
  const totalConvs = uploadData?.totalConversations ?? 0;
  if (persisted > 0 || totalConvs > 0) {
    return [passingCheck(
      'source.vault.db_ready',
      'Vault export',
      { conversationsInDB: persisted || totalConvs }
    )];
  }
  // Fallback: legacy uploads may have neither field on the upload doc but
  // still have rows in conversationStore. Check that directly.
  if (uploadData?._id) {
    try {
      const { getDb } = await import('../../../db/mongo.js');
      const n = await getDb().collection('conversationStore')
        .countDocuments({ uploadId: uploadData._id });
      if (n > 0) {
        return [passingCheck(
          'source.vault.db_ready',
          'Vault export',
          { conversationsInDB: n, via: 'conversationStore.count' }
        )];
      }
    } catch { /* fall through to disk check */ }
  }
  if (!extractPath) {
    return [blockerCheck(
      'source.vault.no_extract',
      'Vault export',
      'No Vault export found in DB and no disk extract.',
      'Upload a Google Vault ZIP file in the previous step.'
    )];
  }
  try {
    if (!fs.existsSync(extractPath)) {
      return [blockerCheck(
        'source.vault.extract_missing',
        'Vault export files',
        `Extracted Vault folder no longer exists at ${extractPath} and no DB rows found.`,
        'Re-upload the ZIP — it will be persisted to the database.'
      )];
    }
    const xmls = fs.readdirSync(extractPath).filter(f => f.toLowerCase().endsWith('.xml'));
    if (xmls.length === 0) {
      return [blockerCheck(
        'source.vault.no_xml',
        'Vault export files',
        `No XML files found in the extracted folder.`,
        'Re-upload a valid Google Vault export ZIP.'
      )];
    }
    return [passingCheck(
      'source.vault.extract_valid',
      'Vault export',
      { xmlCount: xmls.length }
    )];
  } catch (e) {
    return [blockerCheck(
      'source.vault.read_failed',
      'Vault export',
      `Could not read the extracted folder: ${e.message}`
    )];
  }
}

/**
 * Verify a specific source user has data in the upload.
 */
export function checkVaultUserHasData(uploadData, sourceEmail) {
  if (!sourceEmail) {
    return [blockerCheck('source.vault.user.missing', 'Source user', 'No source email.')];
  }
  if (!uploadData?.users || !Array.isArray(uploadData.users)) {
    return [warningCheck(
      'source.vault.user.unknown',
      `Source user ${sourceEmail}`,
      'Upload metadata not available — cannot verify user data exists.'
    )];
  }
  const u = uploadData.users.find(x =>
    (x.email || '').toLowerCase() === sourceEmail.toLowerCase()
  );
  if (!u) {
    return [blockerCheck(
      'source.vault.user.missing',
      `Source user ${sourceEmail}`,
      `${sourceEmail} not present in the Vault export.`,
      `Verify the Vault matter included this user, or remove from the mapping.`
    )];
  }
  const count = u.conversation_count ?? u.conversationCount ?? 0;
  if (count === 0) {
    return [warningCheck(
      'source.vault.user.empty',
      `Source user ${sourceEmail}`,
      `${sourceEmail} has 0 conversations in the Vault export — will be a no-op.`,
      `Either remove this user from the migration, or proceed.`
    )];
  }
  return [passingCheck('source.vault.user.ok', `Source user ${sourceEmail}`, { conversationCount: count })];
}
