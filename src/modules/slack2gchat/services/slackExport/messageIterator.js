import fs from 'fs';
import path from 'path';

/**
 * Async generator that yields message batches per channel lazily.
 * Never loads all messages into memory at once.
 *
 * Yields: { channelId, channelName, dayFile, messages[] }
 */
export async function* iterateChannelMessages(exportDir, channelName, batchSize = 500) {
  const chDir = path.join(exportDir, channelName);
  if (!fs.existsSync(chDir)) return;

  const dayFiles = fs.readdirSync(chDir)
    .filter(f => f.endsWith('.json'))
    .sort(); // chronological order (YYYY-MM-DD.json)

  for (const dayFile of dayFiles) {
    let messages;
    try {
      messages = JSON.parse(fs.readFileSync(path.join(chDir, dayFile), 'utf8'));
    } catch { continue; }

    if (!Array.isArray(messages)) continue;

    // Sort by ts (ascending) within each day file
    messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    // Yield in batches of batchSize
    for (let i = 0; i < messages.length; i += batchSize) {
      yield {
        dayFile,
        messages: messages.slice(i, i + batchSize),
      };
    }
  }
}

/**
 * Count total messages in a channel directory without loading them all.
 */
export function countChannelMessages(exportDir, channelName) {
  const chDir = path.join(exportDir, channelName);
  if (!fs.existsSync(chDir)) return 0;
  let total = 0;
  const dayFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json'));
  for (const f of dayFiles) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
      total += Array.isArray(msgs) ? msgs.length : 0;
    } catch {}
  }
  return total;
}
