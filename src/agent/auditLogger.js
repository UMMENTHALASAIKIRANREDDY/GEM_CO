// src/agent/auditLogger.js
import { getDb } from '../db/mongo.js';
import { getLogger } from '../utils/logger.js';
import { EventEmitter } from 'events';

const logger = getLogger('agent:audit');
export const auditEmitter = new EventEmitter();
auditEmitter.setMaxListeners(50);

/**
 * Write a structured audit event to MongoDB and emit it on auditEmitter.
 * Called from agentLoop at: session start, each tool call, each tool result,
 * each LLM response, confirmation gates, errors, session end.
 *
 * @param {string} sessionId  - unique per chat request
 * @param {string} type       - 'session_start'|'llm_response'|'tool_call'|'tool_result'|'confirmation_gate'|'error'|'session_end'
 * @param {object} payload    - event-specific data
 */
export async function auditLog(sessionId, type, payload = {}) {
  const event = { ...payload, sessionId, type, ts: new Date() };
  try {
    const db = getDb();
    await db.collection('agentAuditLog').insertOne(event);
    auditEmitter.emit('event', event);
  } catch (e) {
    // Never crash the agent loop due to audit failure
    logger.warn(`auditLog failed: ${e.message}`);
  }
}
