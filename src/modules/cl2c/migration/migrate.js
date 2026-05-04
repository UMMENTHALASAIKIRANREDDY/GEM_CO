/**
 * CL2C (Claude → Copilot/OneNote) migration runner.
 * Reads Claude export ZIP and creates OneNote pages in each target user's M365 account.
 * Reuses PagesCreator from g2c and zipParser from cl2g.
 */

import fs from 'node:fs';
import { PagesCreator } from '../../g2c/pagesCreator.js';
import { getUserData } from '../../cl2g/zipParser.js';

export async function migrateUserPair({
  sourceUuid,
  sourceDisplayName,
  destUserEmail,
  extractPath,
  appUserId,
}, opts = {}) {
  const result = {
    sourceUuid,
    sourceDisplayName: sourceDisplayName || sourceUuid,
    destUserEmail,
    conversationsCount: 0,
    filesUploaded: 0,
    errors: [],
    files: [],
  };

  try {
    if (!fs.existsSync(extractPath)) {
      result.errors.push(`Upload directory not found: ${extractPath}. The uploaded ZIP was likely lost after a server restart. Please re-upload the ZIP file.`);
      return result;
    }

    const { conversations, memory, projects } = getUserData(extractPath, sourceUuid);
    result.conversationsCount = conversations.length;

    const folderName = opts.folderName || 'ClaudeChats';
    const creator = new PagesCreator(null, folderName, appUserId);

    // Apply date filter
    let filteredConvs = conversations;
    if (opts.fromDate || opts.toDate) {
      const from = opts.fromDate ? new Date(opts.fromDate) : null;
      const to   = opts.toDate   ? new Date(opts.toDate + 'T23:59:59Z') : null;
      filteredConvs = conversations.filter(c => {
        const d = new Date(c.created_at);
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
      });
    }

    // One OneNote page per conversation
    for (const conv of filteredConvs) {
      try {
        await creator.createClaudePage(destUserEmail, conv);
        result.filesUploaded++;
        result.files.push({ name: conv.name || 'Untitled', type: 'onenote-page' });
      } catch (err) {
        result.errors.push(`Conversation "${(conv.name || 'Untitled').slice(0, 60)}": ${err.message}`);
      }
    }

    // Memory page (optional)
    if (opts.includeMemory !== false && memory?.conversations_memory) {
      try {
        await creator.createClaudeMemoryPage(destUserEmail, memory.conversations_memory, sourceDisplayName);
        result.filesUploaded++;
        result.files.push({ name: 'Claude Memory', type: 'onenote-page' });
      } catch (err) {
        result.errors.push(`Memory: ${err.message}`);
      }
    }

    // Projects page (optional)
    if (opts.includeProjects !== false) {
      const validProjects = projects.filter(p => p.name || (p.docs || []).length);
      if (validProjects.length > 0) {
        try {
          await creator.createClaudeProjectsPage(destUserEmail, validProjects, sourceDisplayName);
          result.filesUploaded++;
          result.files.push({ name: 'Claude Projects', type: 'onenote-page' });
        } catch (err) {
          result.errors.push(`Projects: ${err.message}`);
        }
      }
    }

  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}
