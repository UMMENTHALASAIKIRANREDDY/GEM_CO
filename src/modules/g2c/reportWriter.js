import fs from 'fs';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:reportWriter');

/**
 * Module 5 — Admin Migration Report.
 * Writes migration_report.json on completion.
 * Contains METADATA ONLY — zero conversation content, zero prompt/response text.
 */
export class ReportWriter {
  constructor() {
    this._users = [];
    this._startTime = new Date();
  }

  addUserResult({ email, destEmail, conversations, pagesCreated, migratedConversations, filesUploaded, visualAssetsFlagged, errors }) {
    // For G2C, OneNote pages ARE conversations — one page per conversation.
    // pages_created == migrated_conversations when status is success.
    // files_uploaded counts standalone attachments (images, PDFs, code blocks
    // dropped as attachments) — NEVER the OneNote page itself.
    const migrated = migratedConversations
      ?? (errors.length === 0 ? conversations : pagesCreated);
    this._users.push({
      email,
      destEmail: destEmail || '',
      conversations_processed: conversations,
      migrated_conversations: migrated,
      pages_created: pagesCreated,
      files_uploaded: filesUploaded ?? 0,
      visual_assets_flagged: visualAssetsFlagged,
      error_count: errors.length,
      errors: errors.map(e => ({
        conversation: e.conversation || 'unknown',
        error_message: e.error || '',
        recommended_action: 'Retry with --user flag'
      })),
      status: errors.length === 0
        ? 'success'
        : pagesCreated > 0 ? 'partial' : 'failed'
    });
  }

  write(outputPath) {
    const endTime = new Date();
    const durationSeconds = ((endTime - this._startTime) / 1000).toFixed(1);

    const totalPages = this._users.reduce((s, u) => s + u.pages_created, 0);
    const totalConversations = this._users.reduce((s, u) => s + (u.conversations_processed || 0), 0);
    const totalMigrated = this._users.reduce((s, u) => s + (u.migrated_conversations || 0), 0);
    const totalFiles = this._users.reduce((s, u) => s + (u.files_uploaded || 0), 0);
    const totalErrors = this._users.reduce((s, u) => s + u.error_count, 0);
    const totalFlagged = this._users.reduce((s, u) => s + u.visual_assets_flagged, 0);

    const report = {
      report_type: 'migration_report',
      generated_at: endTime.toISOString(),
      summary: {
        total_users: this._users.length,
        total_pages_created: totalPages,
        total_conversations: totalConversations,
        total_migrated_conversations: totalMigrated,
        total_files_uploaded: totalFiles,
        total_errors: totalErrors,
        total_visual_assets_flagged: totalFlagged,
        total_duration_seconds: parseFloat(durationSeconds)
      },
      users: this._users
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    logger.info(`Migration report written: ${outputPath}`);
    logger.info(`Summary — users: ${this._users.length}, conversations: ${totalConversations}, pages: ${totalPages}, errors: ${totalErrors}`);
  }

  getReport() {
    const endTime = new Date();
    const totalPages = this._users.reduce((s, u) => s + u.pages_created, 0);
    const totalConversations = this._users.reduce((s, u) => s + (u.conversations_processed || 0), 0);
    const totalMigrated = this._users.reduce((s, u) => s + (u.migrated_conversations || 0), 0);
    const totalFiles = this._users.reduce((s, u) => s + (u.files_uploaded || 0), 0);
    const totalErrors = this._users.reduce((s, u) => s + u.error_count, 0);
    const totalFlagged = this._users.reduce((s, u) => s + u.visual_assets_flagged, 0);
    return {
      report_type: 'migration_report',
      generated_at: endTime.toISOString(),
      summary: {
        total_users: this._users.length,
        total_pages_created: totalPages,
        total_conversations: totalConversations,
        total_migrated_conversations: totalMigrated,
        total_files_uploaded: totalFiles,
        total_errors: totalErrors,
        total_visual_assets_flagged: totalFlagged,
        total_duration_seconds: parseFloat(((endTime - this._startTime) / 1000).toFixed(1))
      },
      users: this._users
    };
  }
}
