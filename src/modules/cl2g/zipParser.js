/**
 * Claude export ZIP parser.
 * Reads users.json, conversations.json, memories.json, projects.json
 * and returns structured data for the migration runner.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createUnzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

// ── Unzip ────────────────────────────────────────────────────────────────────

export async function extractZip(zipPath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });

  // adm-zip is fully synchronous — all bytes are on disk before it returns.
  // unzipper's stream-based Extract resolves before fs writes are flushed,
  // causing silent parse failures on large files (e.g. 40+ MB conversations.json).
  try {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
    return;
  } catch {}

  // Fallback: unzipper (stream-based, may have flush lag on large files)
  try {
    const unzipper = await import('unzipper');
    await pipeline(
      createReadStream(zipPath),
      unzipper.Extract({ path: destDir })
    );
    // Give the OS a tick to flush any buffered writes before the caller reads
    await new Promise(r => setTimeout(r, 200));
  } catch {
    throw new Error('No ZIP extraction library found. Run: npm install adm-zip');
  }
}

// ── JSON file reader ─────────────────────────────────────────────────────────

function readJson(dir, filename) {
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`[CL2G zipParser] Failed to parse ${filename}:`, e.message);
    return null;
  }
}

/**
 * Claude ZIPs sometimes extract into a single subdirectory instead of the root.
 * Walk up to two levels of subdirectories to find where conversations.json lives,
 * or where a conversations/ directory lives (newer export format).
 */
function resolveDataDir(extractDir) {
  // Check root first
  if (fs.existsSync(path.join(extractDir, 'conversations.json'))) return extractDir;
  if (fs.existsSync(path.join(extractDir, 'conversations')) &&
      fs.statSync(path.join(extractDir, 'conversations')).isDirectory()) return extractDir;

  try {
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(extractDir, e.name);
      // One level deep
      if (fs.existsSync(path.join(sub, 'conversations.json'))) return sub;
      if (fs.existsSync(path.join(sub, 'conversations')) &&
          fs.statSync(path.join(sub, 'conversations')).isDirectory()) return sub;
      // Two levels deep
      try {
        const subEntries = fs.readdirSync(sub, { withFileTypes: true });
        for (const se of subEntries) {
          if (!se.isDirectory()) continue;
          const sub2 = path.join(sub, se.name);
          if (fs.existsSync(path.join(sub2, 'conversations.json'))) return sub2;
          if (fs.existsSync(path.join(sub2, 'conversations')) &&
              fs.statSync(path.join(sub2, 'conversations')).isDirectory()) return sub2;
        }
      } catch {}
    }
  } catch {}
  return extractDir; // fallback
}

/**
 * Log the top-level structure of the extracted ZIP for debugging.
 */
function logExtractStructure(extractDir) {
  try {
    const list = fs.readdirSync(extractDir).slice(0, 20);
    console.log(`[CL2G zipParser] Extract root (${extractDir}):`, list);
    for (const name of list) {
      const full = path.join(extractDir, name);
      if (fs.statSync(full).isDirectory()) {
        const sub = fs.readdirSync(full).slice(0, 10);
        console.log(`  ${name}/`, sub);
      }
    }
  } catch {}
}

/**
 * Read all JSON files from a directory and merge them into a single array.
 * Used when Claude exports conversations as individual files in a conversations/ folder.
 */
function readJsonDir(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const result = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (Array.isArray(data)) result.push(...data);
        else if (data && typeof data === 'object') result.push(data);
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

// ── Main parser ──────────────────────────────────────────────────────────────

export function parseClaudeExport(extractDir) {
  logExtractStructure(extractDir);
  const dataDir      = resolveDataDir(extractDir);
  console.log(`[CL2G zipParser] dataDir resolved to: ${dataDir}`);

  const users        = readJson(dataDir, 'users.json')        || [];

  // Support both single-file (conversations.json) and directory (conversations/) formats
  const convsFile    = readJson(dataDir, 'conversations.json');
  const conversations= convsFile != null
    ? convsFile
    : readJsonDir(path.join(dataDir, 'conversations'));

  const memories     = readJson(dataDir, 'memories.json')     || [];
  const projects     = readJson(dataDir, 'projects.json')     || [];

  console.log(`[CL2G zipParser] Found: ${users.length} users, ${conversations.length} convs, ${memories.length} memories, ${projects.length} projects`);

  // Index memories by account_uuid
  const memoryByUser = {};
  for (const m of memories) {
    if (m.account_uuid) memoryByUser[m.account_uuid] = m.conversations_memory || '';
  }

  // Count conversations per user
  const convCountByUser = {};
  for (const c of conversations) {
    const uid = c.account?.uuid;
    if (uid) convCountByUser[uid] = (convCountByUser[uid] || 0) + 1;
  }

  // Count projects per user (by creator)
  const projCountByUser = {};
  for (const p of projects) {
    const uid = p.creator?.uuid;
    if (uid) projCountByUser[uid] = (projCountByUser[uid] || 0) + 1;
  }

  // Build enriched user list
  const enrichedUsers = users.map(u => ({
    uuid:              u.uuid,
    full_name:         u.full_name || '',
    email_address:     u.email_address || '',
    conversationCount: convCountByUser[u.uuid] || 0,
    hasMemory:         !!memoryByUser[u.uuid],
    projectCount:      projCountByUser[u.uuid] || 0,
  }));

  return {
    users:         enrichedUsers,
    conversations,
    memoryByUser,
    projects,
    totalConversations: conversations.length,
    totalMemories:      memories.length,
    totalProjects:      projects.length,
  };
}

// ── Per-user data fetcher (used by migrate.js) ───────────────────────────────

export function getUserData(extractDir, userUuid) {
  const dataDir       = resolveDataDir(extractDir);
  const convsFile     = readJson(dataDir, 'conversations.json');
  const conversations = convsFile != null
    ? convsFile
    : readJsonDir(path.join(dataDir, 'conversations'));
  const memories      = readJson(dataDir, 'memories.json')      || [];
  const projects      = readJson(dataDir, 'projects.json')      || [];

  const userConversations = conversations.filter(c => c.account?.uuid === userUuid);
  const userMemory        = memories.find(m => m.account_uuid === userUuid) || null;
  const userProjects      = projects.filter(p => p.creator?.uuid === userUuid);

  return { conversations: userConversations, memory: userMemory, projects: userProjects };
}

// ── Text extraction from a chat message ─────────────────────────────────────

export function extractMessageText(msg) {
  // Primary: top-level text field
  if (msg.text && msg.text.trim()) return msg.text.trim();
  // Fallback: content[].text joined
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n')
      .trim();
  }
  return '';
}
