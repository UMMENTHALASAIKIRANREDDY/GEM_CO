import fs from 'fs';
import { getLogger } from './logger.js';

const logger = getLogger('utils:checkpoint');

/**
 * Per-user checkpoint file for resumable migrations (FR-3.6).
 * Stores: user email + completion boolean only.
 * NEVER stores prompt text, response text, or conversation content.
 */
export class CheckpointManager {
  constructor(checkpointPath) {
    this.path = checkpointPath;
    this._data = this._load();
  }

  _load() {
    if (fs.existsSync(this.path)) {
      return JSON.parse(fs.readFileSync(this.path, 'utf8'));
    }
    return { completed_users: [] };
  }

  _save() {
    fs.writeFileSync(this.path, JSON.stringify(this._data, null, 2));
  }

  markComplete(email) {
    if (!this._data.completed_users.includes(email)) {
      this._data.completed_users.push(email);
      this._save();
    }
    logger.info(`Checkpoint: marked complete — ${email}`);
  }

  getCompletedUsers() {
    return new Set(this._data.completed_users || []);
  }

  reset() {
    this._data = { completed_users: [] };
    this._save();
  }
}
