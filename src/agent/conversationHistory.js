import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:history');
const MAX_HISTORY = 50;
const LOAD_LIMIT = 20;

export async function loadHistory(db, appUserId) {
  try {
    const docs = await db.collection('chatHistory')
      .find({ appUserId })
      .sort({ timestamp: 1 })
      .limit(LOAD_LIMIT)
      .toArray();
    return docs.map(d => ({ role: d.role, content: d.content }));
  } catch (e) {
    logger.warn(`loadHistory failed for ${appUserId}: ${e.message}`);
    return [];
  }
}

export async function saveHistory(db, appUserId, role, content, migDir) {
  try {
    await db.collection('chatHistory').insertOne({
      appUserId,
      role,
      content,
      migDir: migDir ?? null,
      timestamp: new Date(),
    });
    // Trim to MAX_HISTORY — delete oldest beyond limit
    const count = await db.collection('chatHistory').countDocuments({ appUserId });
    if (count > MAX_HISTORY) {
      const oldest = await db.collection('chatHistory')
        .find({ appUserId })
        .sort({ timestamp: 1 })
        .limit(count - MAX_HISTORY)
        .toArray();
      const ids = oldest.map(d => d._id);
      await db.collection('chatHistory').deleteMany({ _id: { $in: ids } });
    }
  } catch (e) {
    logger.warn(`saveHistory failed for ${appUserId}: ${e.message}`);
  }
}

export async function clearHistory(db, appUserId) {
  try {
    await db.collection('chatHistory').deleteMany({ appUserId });
  } catch (e) {
    logger.warn(`clearHistory failed for ${appUserId}: ${e.message}`);
  }
}
