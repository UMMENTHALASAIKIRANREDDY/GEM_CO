/**
 * CL2G migration runner.
 * Produces ONE merged DOCX per user (all conversations + index) so the
 * user can create a single Gemini Gem with the full conversation history.
 * Memory and Projects are kept as separate files (max 3 files total per user).
 */

import fs from 'node:fs';
import {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, BorderStyle, AlignmentType, PageBreak,
} from 'docx';
import {
  getServiceAccountAuth,
  createDriveFolder,
  uploadFileToDrive,
} from '../../c2g/googleService.js';
import { getUserData, extractMessageText } from '../../cl2g/zipParser.js';
import {
  CONVERSATIONS_SUBFOLDER,
  attachmentsSubfolderName,
} from '../../_shared/destinationFolders.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function textRuns(text, style = {}) {
  const lines = String(text || '').split('\n');
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) runs.push(new TextRun({ break: 1, ...style }));
    runs.push(new TextRun({ text: lines[i], ...style }));
  }
  return runs;
}

function safeFileName(name, fallback) {
  return (name || fallback)
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
    .trim() || fallback;
}

function dividerParagraph() {
  return new Paragraph({
    spacing: { before: 400, after: 400 },
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } },
    children: [],
  });
}

// ── Build merged ALL conversations DOCX ─────────────────────────────────────

async function buildAllConversationsDocx(conversations, userName) {
  const children = [];

  // ── Cover ──────────────────────────────────────────────────────────────────
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text: 'Claude Conversation History', bold: true, size: 48 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: userName, size: 28, color: '444444', italics: true })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 500 },
    children: [new TextRun({
      text: `${conversations.length} conversation${conversations.length !== 1 ? 's' : ''} · Exported ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`,
      size: 20, color: '888888',
    })],
  }));

  // ── Conversation Index (Table of Contents) ────────────────────────────────
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 200, after: 160 },
    children: [new TextRun({ text: 'CONVERSATION INDEX', bold: true, size: 26, color: '0B5394', allCaps: true })],
  }));

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const title = conv.name?.trim() || `Conversation ${i + 1}`;
    const dateStr = conv.created_at ? formatTimestamp(conv.created_at) : '';
    const msgCount = (conv.chat_messages || []).length;

    children.push(new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `${i + 1}.  `, bold: true, size: 20, color: '0B5394' }),
        new TextRun({ text: title, size: 20, color: '1E3A5F', bold: true }),
        new TextRun({ text: dateStr ? `\t${dateStr}` : '', size: 18, color: '999999' }),
        new TextRun({ text: `  (${msgCount} msg${msgCount !== 1 ? 's' : ''})`, size: 17, color: 'AAAAAA' }),
      ],
    }));
  }

  // Page break before conversations start
  children.push(new Paragraph({
    spacing: { before: 400 },
    children: [new PageBreak()],
  }));

  // ── Conversations ──────────────────────────────────────────────────────────
  for (let convIdx = 0; convIdx < conversations.length; convIdx++) {
    const conv = conversations[convIdx];
    const messages = conv.chat_messages || [];
    const title = conv.name?.trim() || `Conversation ${convIdx + 1}`;

    if (convIdx > 0) children.push(dividerParagraph());

    // Conversation header
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 100, after: 60 },
      children: [new TextRun({
        text: `Conversation ${convIdx + 1}: ${title}`,
        bold: true, size: 30, color: '0B5394',
      })],
    }));

    if (conv.created_at) {
      children.push(new Paragraph({
        spacing: { after: 180 },
        children: [new TextRun({
          text: `Date: ${formatTimestamp(conv.created_at)}`,
          size: 18, color: '888888', italics: true,
        })],
      }));
    }

    if (!messages.length) {
      children.push(new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: '(No messages)', size: 20, color: 'AAAAAA', italics: true })],
      }));
      continue;
    }

    // Messages
    for (const msg of messages) {
      const isUser = msg.sender === 'human';
      const text = extractMessageText(msg);
      const hasAttachments = (msg.attachments || []).some(a => a.file_name);
      if (!text && !hasAttachments) continue;

      const roleLabel = isUser ? 'Human' : 'Claude';
      const roleColor = isUser ? '0B5394' : 'C65C1A';

      // Role + timestamp row
      children.push(new Paragraph({
        spacing: { before: 180, after: 40 },
        children: [
          new TextRun({ text: `[${roleLabel}]`, bold: true, size: 21, color: roleColor }),
          msg.created_at
            ? new TextRun({ text: `  ${formatTimestamp(msg.created_at)}`, size: 17, color: 'BBBBBB' })
            : new TextRun({ text: '' }),
        ],
      }));

      // Message body with left border
      if (text) {
        children.push(new Paragraph({
          spacing: { after: 60 },
          indent: { left: 320 },
          border: { left: { style: BorderStyle.SINGLE, size: 4, color: roleColor, space: 8 } },
          children: textRuns(text, { size: 21, font: 'Calibri', color: '2D2D2D' }),
        }));
      }

      // Attachments — show filename + extracted text content (binary not available in Claude export)
      for (const att of msg.attachments || []) {
        if (!att.file_name) continue;

        // Filename header
        children.push(new Paragraph({
          indent: { left: 320 },
          spacing: { before: 60, after: 20 },
          children: [new TextRun({ text: `📎 ${att.file_name}`, size: 19, bold: true, color: '444444' })],
        }));

        // Extracted text content (if available)
        if (att.extracted_content?.trim()) {
          const preview = att.extracted_content.trim();
          children.push(new Paragraph({
            indent: { left: 360 },
            spacing: { after: 60 },
            border: {
              left: { style: BorderStyle.SINGLE, size: 3, color: 'D1D5DB', space: 6 },
              top: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB', space: 2 },
              bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB', space: 2 },
            },
            children: textRuns(preview, { size: 18, font: 'Calibri', color: '555555', italics: true }),
          }));
        } else {
          children.push(new Paragraph({
            indent: { left: 360 },
            spacing: { after: 60 },
            children: [new TextRun({ text: '(file content not available in export)', size: 17, color: 'AAAAAA', italics: true })],
          }));
        }
      }
    }
  }

  const doc = new Document({
    creator: 'CloudFuze Migration Tool',
    title: `Claude Conversation History — ${userName}`,
    description: `All Claude conversations for ${userName}, exported for Gemini Gem knowledge`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Build memory DOCX ────────────────────────────────────────────────────────

async function buildMemoryDocx(memoryText, userName) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: 'Claude Memory', bold: true, size: 44 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: userName, size: 24, color: '666666', italics: true })],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: textRuns(memoryText, { size: 21, font: 'Calibri', color: '333333' }),
    }),
  ];

  const doc = new Document({
    creator: 'CloudFuze Migration Tool',
    title: 'Claude Memory',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Build merged projects DOCX ───────────────────────────────────────────────

async function buildAllProjectsDocx(projects, userName) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: 'Claude Projects', bold: true, size: 44 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({
        text: `${userName} · ${projects.length} project${projects.length !== 1 ? 's' : ''}`,
        size: 24, color: '666666', italics: true,
      })],
    }),
  ];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (i > 0) children.push(dividerParagraph());

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 100, after: 80 },
      children: [new TextRun({ text: project.name || `Project ${i + 1}`, bold: true, size: 28, color: '0B5394' })],
    }));

    if (project.description) {
      children.push(new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({ text: project.description, size: 21, color: '555555', italics: true })],
      }));
    }

    for (const doc of project.docs || []) {
      if (doc.filename) {
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 80 },
          children: [new TextRun({ text: doc.filename, bold: true, size: 24, color: '1E3A5F' })],
        }));
      }
      if (doc.content) {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: textRuns(doc.content, { size: 21, font: 'Calibri', color: '333333' }),
        }));
      }
    }
  }

  const docxDoc = new Document({
    creator: 'CloudFuze Migration Tool',
    title: `Claude Projects — ${userName}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(docxDoc);
}

// ── Main migration function ──────────────────────────────────────────────────

export async function migrateUserPair({
  sourceUuid,
  sourceDisplayName,
  destUserEmail,
  extractPath,
  // New optional ctx for DB-first read:
  appUserId,
  uploadId,
  sourceEmail,
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
    // DB-only: conversations are loaded from conversationStore. The disk
    // extract is deleted at upload time and Memory/Projects are intentionally
    // not migrated (see uploads-folder cleanup scope decision).
    const { loadConversationsFromStore } = await import('../../_shared/conversationStore.js');
    const conversations = await loadConversationsFromStore({
      appUserId,
      sourceEmail,
      uploadId,
      fromDate: opts?.fromDate,
      toDate: opts?.toDate,
      includeMigrated: !opts?.isResume,
    }) || [];

    if (conversations.length === 0) {
      result.errors.push(`No conversations found in conversationStore for ${sourceEmail}. The upload may have failed at ingest time — please re-upload the ZIP.`);
      return result;
    }
    result.conversationsCount = conversations.length;

    const folderName = opts.folderName || 'ClaudeChats';
    const auth = getServiceAccountAuth(destUserEmail);
    // Universal 2-subfolder pattern (see _shared/destinationFolders.js).
    // CL2G doesn't currently extract standalone attachments from Claude
    // exports (media is inlined into the DOCX), so the "Migrated from Claude"
    // folder will stay empty for now — created anyway for layout parity with
    // every other direction and as a placeholder for future attachment work.
    const filesSubfolderName = attachmentsSubfolderName('claude');
    const mainFolder = await createDriveFolder(auth, folderName);
    const convoFolder = await createDriveFolder(auth, CONVERSATIONS_SUBFOLDER, mainFolder.id);
    // eslint-disable-next-line no-unused-vars
    const filesFolder = await createDriveFolder(auth, filesSubfolderName, mainFolder.id);
    console.log(`[CL2G] Folder layout: ${folderName}/ → ${CONVERSATIONS_SUBFOLDER}/, ${filesSubfolderName}/ (empty for now)`);

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

    // ── Split conversations into batches (5000 per file) for memory efficiency ──
    const BATCH_SIZE = 5000;
    if (filteredConvs.length > 0) {
      const batches = [];
      for (let i = 0; i < filteredConvs.length; i += BATCH_SIZE) {
        batches.push(filteredConvs.slice(i, i + BATCH_SIZE));
      }

      const safeName = safeFileName(sourceDisplayName, 'User');

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const startIdx = batchIdx * BATCH_SIZE + 1;
        const endIdx = Math.min((batchIdx + 1) * BATCH_SIZE, filteredConvs.length);

        try {
          // File naming: single file if only 1 batch, else Part1, Part2, etc.
          const partLabel = batches.length > 1 ? `_Part${batchIdx + 1}` : '';
          const docxName = `${safeName}_Conversations${partLabel}.docx`;

          console.log(`[CL2G] Building conversations batch ${batchIdx + 1}/${batches.length} (${startIdx}-${endIdx} of ${filteredConvs.length})...`);

          const buffer = await buildAllConversationsDocx(batch, sourceDisplayName);
          const uploaded = await uploadFileToDrive(
            auth, docxName,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer, convoFolder.id
          );

          result.filesUploaded++;
          result.files.push({
            name: docxName,
            driveFileId: uploaded.id,
            webViewLink: uploaded.webViewLink,
            batchInfo: { part: batchIdx + 1, totalParts: batches.length, conversationRange: [startIdx, endIdx, filteredConvs.length] }
          });

          console.log(`[CL2G] Uploaded batch: ${docxName}`);
        } catch (err) {
          result.errors.push(`Conversations batch ${batchIdx + 1}: ${err.message}`);
        }
      }
    }

    // Memory + Projects DOCXs are no longer generated — those files lived
    // only on disk and were dropped when we moved to DB-only storage.
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}

export async function runMigration(pairs, opts = {}) {
  const results = [];
  for (const pair of pairs) {
    results.push(await migrateUserPair(pair, opts));
  }
  return results;
}
