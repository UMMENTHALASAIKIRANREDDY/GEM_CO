import fs from 'fs';
import { getLogger } from '../utils/logger.js';

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

  addUserResult({ email, conversations, pagesCreated, visualAssetsFlagged, errors }) {
    this._users.push({
      email,
      conversations_processed: conversations,
      pages_created: pagesCreated,
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
    const totalErrors = this._users.reduce((s, u) => s + u.error_count, 0);
    const totalFlagged = this._users.reduce((s, u) => s + u.visual_assets_flagged, 0);

    const report = {
      report_type: 'migration_report',
      generated_at: endTime.toISOString(),
      summary: {
        total_users: this._users.length,
        total_pages_created: totalPages,
        total_errors: totalErrors,
        total_visual_assets_flagged: totalFlagged,
        total_duration_seconds: parseFloat(durationSeconds)
      },
      users: this._users
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    logger.info(`Migration report written: ${outputPath}`);
    logger.info(`Summary — users: ${this._users.length}, pages: ${totalPages}, errors: ${totalErrors}`);
  }
}
