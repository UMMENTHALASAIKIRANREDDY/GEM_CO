import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import unzipper from 'unzipper';

/**
 * Stream-extract a Slack export ZIP to destDir.
 * Uses unzipper (streaming) — never loads the full ZIP into RAM.
 * Returns list of extracted top-level entries.
 */
export async function extractSlackZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  await pipeline(
    fs.createReadStream(zipPath),
    unzipper.Extract({ path: destDir })
  );

  return fs.readdirSync(destDir);
}
