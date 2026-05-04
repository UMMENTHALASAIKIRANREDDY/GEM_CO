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
    const auth = getServiceAccountAuth(destUserEmail);
    const mainFolder = await createDriveFolder(auth, folderName);

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

    // ── File 1: All Conversations merged into ONE DOCX ─────────────────────
    if (filteredConvs.length > 0) {
      try {
        const safeName = safeFileName(sourceDisplayName, 'User');
        const docxName = `${safeName}_All_Conversations.docx`;
        const buffer = await buildAllConversationsDocx(filteredConvs, sourceDisplayName);
        const uploaded = await uploadFileToDrive(
          auth, docxName,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer, mainFolder.id
        );
        result.filesUploaded++;
        result.files.push({ name: docxName, driveFileId: uploaded.id, webViewLink: uploaded.webViewLink });
      } catch (err) {
        result.errors.push(`Conversations DOCX: ${err.message}`);
      }
    }

    // ── File 2: Memory (optional) ──────────────────────────────────────────
    if (opts.includeMemory !== false && memory?.conversations_memory) {
      try {
        const buffer = await buildMemoryDocx(memory.conversations_memory, sourceDisplayName);
        const uploaded = await uploadFileToDrive(
          auth, 'Claude_Memory.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer, mainFolder.id
        );
        result.filesUploaded++;
        result.files.push({ name: 'Claude_Memory.docx', driveFileId: uploaded.id, webViewLink: uploaded.webViewLink });
      } catch (err) {
        result.errors.push(`Memory doc: ${err.message}`);
      }
    }

    // ── File 3: All Projects merged into ONE DOCX (optional) ──────────────
    if (opts.includeProjects !== false) {
      const validProjects = projects.filter(p => p.name || (p.docs || []).length);
      if (validProjects.length > 0) {
        try {
          const buffer = await buildAllProjectsDocx(validProjects, sourceDisplayName);
          const uploaded = await uploadFileToDrive(
            auth, 'Claude_Projects.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer, mainFolder.id
          );
          result.filesUploaded++;
          result.files.push({ name: 'Claude_Projects.docx', driveFileId: uploaded.id, webViewLink: uploaded.webViewLink });
        } catch (err) {
          result.errors.push(`Projects DOCX: ${err.message}`);
        }
      }
    }

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
