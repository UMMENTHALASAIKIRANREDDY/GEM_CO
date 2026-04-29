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
  // Use the 'unzipper' package if available, otherwise fall back to adm-zip
  let unzipper;
  try {
    unzipper = await import('unzipper');
  } catch {
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(destDir, true);
      return;
    } catch {
      throw new Error('No ZIP extraction library found. Run: npm install unzipper');
    }
  }

  await fs.promises.mkdir(destDir, { recursive: true });
  await pipeline(
    createReadStream(zipPath),
    unzipper.Extract({ path: destDir })
  );
}

// ── JSON file reader ─────────────────────────────────────────────────────────

function readJson(dir, filename) {
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Claude ZIPs sometimes extract into a single subdirectory instead of the root.
 * Walk one level of subdirectories to find where conversations.json lives.
 */
function resolveDataDir(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'conversations.json'))) return extractDir;
  try {
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(extractDir, e.name);
        if (fs.existsSync(path.join(sub, 'conversations.json'))) return sub;
      }
    }
  } catch {}
  return extractDir; // fallback: return original even if not found
}

// ── Main parser ──────────────────────────────────────────────────────────────

export function parseClaudeExport(extractDir) {
  const dataDir      = resolveDataDir(extractDir);
  const users        = readJson(dataDir, 'users.json')        || [];
  const conversations= readJson(dataDir, 'conversations.json')|| [];
  const memories     = readJson(dataDir, 'memories.json')     || [];
  const projects     = readJson(dataDir, 'projects.json')     || [];

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
  const conversations = readJson(dataDir, 'conversations.json') || [];
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
