import { getDb } from '../db/mongo.js';
import { getLogger } from './logger.js';

const logger = getLogger('utils:checkpoint');

/**
 * Per-user checkpoint for resumable migrations (FR-3.6).
 * Stores: user email + completion boolean only.
 * NEVER stores prompt text, response text, or conversation content.
 * Backed by MongoDB `checkpoints` collection.
 */
export class CheckpointManager {
  constructor(batchId) {
    this.batchId = batchId;
    this._col = getDb().collection('checkpoints');
  }

  async markComplete(email) {
    await this._col.updateOne(
      { batchId: this.batchId },
      { $addToSet: { completedUsers: email }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    logger.info(`Checkpoint: marked complete — ${email}`);
  }

  async getCompletedUsers() {
    const doc = await this._col.findOne({ batchId: this.batchId });
    return new Set(doc?.completedUsers || []);
  }

  async reset() {
    await this._col.updateOne(
      { batchId: this.batchId },
      { $set: { completedUsers: [], updatedAt: new Date() } },
      { upsert: true }
    );
  }
}
