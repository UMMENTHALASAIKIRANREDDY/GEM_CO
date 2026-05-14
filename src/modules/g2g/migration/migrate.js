/**
 * G2G Migration: Read Gemini conversations from Vault ZIP,
 * build DOCX files, and upload to destination Google Drive.
 */

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  ExternalHyperlink,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  PageBreak,
} from 'docx';
import { google } from 'googleapis';
import { VaultReader } from '../../g2c/vaultReader.js';
import { FileCorrelator } from '../../g2c/fileCorrelator.js';
import { getServiceAccountAuth } from '../../c2g/googleService.js';

// Google Docs editor MIME → export format
const EXPORT_FORMATS = {
  'application/vnd.google-apps.document':     { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet':  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.drawing':      { mime: 'application/pdf', ext: '.pdf' },
};

// Download a file from the source Google Drive — handles both binary and Google Docs editor types
async function downloadFromSourceDrive(sourceAuth, fileId, mimeType) {
  const drive = google.drive({ version: 'v3', auth: sourceAuth });
  const exportFmt = EXPORT_FORMATS[mimeType];
  if (exportFmt) {
    const res = await drive.files.export(
      { fileId, mimeType: exportFmt.mime },
      { responseType: 'arraybuffer' }
    );
    return { buffer: Buffer.from(res.data), mime: exportFmt.mime, ext: exportFmt.ext };
  }
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), mime: mimeType, ext: '' };
}

const BATCH_SIZE = 100;

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatTimestamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function textRuns(text, style = {}) {
  const lines = text.split('\n');
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) runs.push(new TextRun({ break: 1, ...style }));
    runs.push(new TextRun({ text: lines[i], ...style }));
  }
  return runs;
}

async function buildConversationDocx(turns, convIdx, userEmail) {
  const children = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Conversation ${convIdx}`, bold: true, size: 44 })],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({
        text: `${userEmail} — ${turns.length} turn${turns.length === 1 ? '' : 's'}`,
        size: 24, color: '666666', italics: true,
      })],
    })
  );

  const firstDate = turns[0]?.timestamp;
  if (firstDate) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        children: [new TextRun({ text: formatTimestamp(firstDate), size: 20, color: '888888' })],
      })
    );
  }

  for (const turn of turns) {
    if (turn.prompt) {
      children.push(
        new Paragraph({
          spacing: { before: 200, after: 40 },
          children: [
            new TextRun({ text: 'You', bold: true, size: 22, color: '0B5394' }),
            new TextRun({ text: `    ${formatTimestamp(turn.timestamp)}`, size: 16, color: 'AAAAAA' }),
          ],
        })
      );

      children.push(
        new Paragraph({
          spacing: { after: 80 },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 4, color: '0B5394', space: 8 } },
          children: textRuns(turn.prompt, { size: 21, font: 'Calibri', color: '333333' }),
        })
      );
    }

    if (turn.response) {
      children.push(
        new Paragraph({
          spacing: { before: 200, after: 40 },
          children: [
            new TextRun({ text: 'Gemini', bold: true, size: 22, color: '38761D' }),
            new TextRun({ text: `    ${formatTimestamp(turn.timestamp)}`, size: 16, color: 'AAAAAA' }),
          ],
        })
      );

      const responseText = stripHtml(turn.response);
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 4, color: '38761D', space: 8 } },
          children: textRuns(responseText, { size: 21, font: 'Calibri', color: '333333' }),
        })
      );
    }
  }

  const doc = new Document({
    creator: 'Gemini Migration Tool',
    title: `Conversation ${convIdx}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// Build paragraphs for any drive files attached to a turn:
//   - image MIME → embedded inline using ImageRun
//   - everything else → hyperlink to the migrated copy in destination Drive
function buildDriveFileParagraphs(driveFiles) {
  const paras = [];
  if (!driveFiles || driveFiles.length === 0) return paras;
  for (const f of driveFiles) {
    const isImage = (f.mimeType || '').startsWith('image/') && f._imageBuffer && Buffer.isBuffer(f._imageBuffer);
    if (isImage) {
      try {
        const imgType = f.mimeType.includes('png') ? 'png' : 'jpg';
        paras.push(new Paragraph({
          spacing: { before: 80, after: 80 },
          indent: { left: 360 },
          children: [
            new ImageRun({
              data: f._imageBuffer,
              transformation: { width: 380, height: 285 },
              type: imgType,
            }),
          ],
        }));
        paras.push(new Paragraph({
          spacing: { after: 60 },
          indent: { left: 360 },
          children: [new TextRun({ text: `📎 ${f.fileName}`, italics: true, size: 16, color: '888888' })],
        }));
      } catch {
        // fall through to hyperlink
      }
    } else {
      const linkUrl = f._uploadedLink || '';
      const prefix = f._uploadedLink ? '[Google Drive] ' : '[Source link] ';
      const color = f._uploadedLink ? '38761D' : '888888';
      const label = f.fileName || 'attached file';
      const children = [new TextRun({ text: prefix, size: 18, bold: true, color })];
      if (linkUrl) {
        children.push(new ExternalHyperlink({
          link: linkUrl,
          children: [new TextRun({ text: label, style: 'Hyperlink', size: 20, color: '0B5394', underline: {} })],
        }));
      } else {
        children.push(new TextRun({ text: label, size: 20, color: '0B5394' }));
      }
      paras.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        indent: { left: 360 },
        children,
      }));
    }
  }
  return paras;
}

async function buildMergedBatchDocx(batch, userEmail, startConvIdx) {
  const children = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: 'Gemini Conversations', bold: true, size: 48 })],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: userEmail, size: 28, color: '444444', italics: true })],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [new TextRun({
        text: `Batch ${startConvIdx} – ${startConvIdx + batch.length - 1}`,
        size: 20, color: '666666'
      })],
    })
  );

  let idx = startConvIdx;
  for (const conv of batch) {
    children.push(
      new Paragraph({
        pageBreakBefore: idx > startConvIdx,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 200, after: 100 },
        children: [new TextRun({ text: `Conversation ${idx}: ${conv.title || 'Untitled'}`, bold: true, size: 32 })],
      })
    );

    const firstDate = conv.turns[0]?.timestamp;
    if (firstDate) {
      children.push(
        new Paragraph({
          spacing: { after: 200 },
          children: [new TextRun({ text: formatTimestamp(firstDate), size: 18, color: '888888', italics: true })],
        })
      );
    }

    for (const turn of conv.turns) {
      if (turn.prompt) {
        children.push(
          new Paragraph({
            spacing: { before: 100, after: 20 },
            children: [new TextRun({ text: 'You', bold: true, size: 20, color: '0B5394' })],
          })
        );
        children.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 4, color: '0B5394', space: 8 } },
            children: textRuns(turn.prompt, { size: 20, font: 'Calibri', color: '333333' }),
          })
        );
      }

      if (turn.response) {
        children.push(
          new Paragraph({
            spacing: { before: 100, after: 20 },
            children: [new TextRun({ text: 'Gemini', bold: true, size: 20, color: '38761D' })],
          })
        );
        const responseText = stripHtml(turn.response);
        children.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 4, color: '38761D', space: 8 } },
            children: textRuns(responseText, { size: 20, font: 'Calibri', color: '333333' }),
          })
        );
      }

      // Attached / referenced Drive files for this turn (from FileCorrelator audit log match)
      if (turn.driveFiles && turn.driveFiles.length > 0) {
        for (const p of buildDriveFileParagraphs(turn.driveFiles)) children.push(p);
      }
    }

    idx++;
  }

  const doc = new Document({
    creator: 'Gemini Migration Tool',
    title: 'Gemini Conversations Batch',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

async function createDriveFolder(auth, folderName) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

async function uploadFileToDrive(auth, fileName, mimeType, content, parentFolderId) {
  const drive = google.drive({ version: 'v3', auth });
  const { Readable } = await import('node:stream');

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    media: {
      mimeType,
      body: Readable.from(Buffer.isBuffer(content) ? content : Buffer.from(content)),
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

export async function runG2GMigration(
  { vaultZipPath, extractPath, sourceAuth, destAuth, isDryRun, selectedUsers, userMappings, opts },
  onLog
) {
  const result = {
    conversationsCount: 0,
    filesUploaded: 0,
    errors: [],
    migratedUsers: 0,
    users: [],
  };

  let tempDir = null;
  let usingTempDir = false;

  try {
    // Support both new (extractPath) and legacy (vaultZipPath) callers
    let readerPath = extractPath;
    if (!readerPath && vaultZipPath) {
      onLog({ type: 'info', message: 'Extracting Vault ZIP...' });
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2g-'));
      const zip = new AdmZip(vaultZipPath);
      zip.extractAllTo(tempDir, true);
      readerPath = tempDir;
      usingTempDir = true;
    }

    if (!readerPath) {
      result.errors.push('No vault data path provided (extractPath or vaultZipPath required)');
      onLog({ type: 'error', message: 'No vault data path provided' });
      return result;
    }

    onLog({ type: 'info', message: 'Reading conversations from Vault export...' });

    const vaultReader = new VaultReader(readerPath);
    const allUsers = await vaultReader.discoverUsers();

    if (!allUsers.length) {
      result.errors.push('No users found in Vault export');
      if (usingTempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      return result;
    }

    // Filter users by selectedUsers if provided
    const selectedSet = Array.isArray(selectedUsers) && selectedUsers.length > 0
      ? new Set(selectedUsers.map(e => e.toLowerCase()))
      : null;
    const users = selectedSet
      ? allUsers.filter(u => selectedSet.has(u.email.toLowerCase()))
      : allUsers;

    onLog({ type: 'info', message: `Discovered ${allUsers.length} user(s) — migrating ${users.length} selected` });

    const mappings = userMappings || {};

    // Emit progress helper
    const emitProgress = () => {
      onLog({
        type: 'progress',
        message: JSON.stringify({
          files: result.filesUploaded,
          errors: result.errors.length,
          conversationCount: result.conversationsCount,
          migratedUsers: result.migratedUsers,
          totalUsers: users.length,
        }),
      });
    };

    for (const user of users) {
      const sourceEmail = user.email;
      // Mapping value may be a local-part (e.g. "alice") or a full email — normalize to email
      let mappedTo = mappings[sourceEmail];
      if (!mappedTo) mappedTo = sourceEmail;
      if (mappedTo && !mappedTo.includes('@')) {
        // Local-part only — derive domain from source email
        const sourceDomain = sourceEmail.split('@')[1];
        if (sourceDomain) mappedTo = `${mappedTo}@${sourceDomain}`;
      }

      const userRecord = {
        email: sourceEmail,
        destEmail: mappedTo,
        status: 'pending',
        pages_created: 0,
        files_created: 0,
        error_count: 0,
        errors: [],
      };

      onLog({ type: 'info', message: `Processing: ${sourceEmail} → ${mappedTo}` });
      onLog({ type: 'user', message: sourceEmail });

      let conversations = [];
      try {
        conversations = await vaultReader.loadUserConversations(
          sourceEmail,
          opts?.fromDate,
          opts?.toDate
        );
      } catch (err) {
        const errMsg = `${sourceEmail}: load failed — ${err.message}`;
        result.errors.push(errMsg);
        userRecord.status = 'failed';
        userRecord.error_count++;
        userRecord.errors.push({ conversation: '', error_message: err.message });
        result.users.push(userRecord);
        onLog({ type: 'error', message: errMsg });
        emitProgress();
        continue;
      }

      if (!conversations.length) {
        onLog({ type: 'warn', message: `No conversations for ${sourceEmail}` });
        userRecord.status = 'success';
        result.users.push(userRecord);
        result.migratedUsers++;
        emitProgress();
        continue;
      }

      result.conversationsCount += conversations.length;

      if (isDryRun) {
        onLog({
          type: 'info',
          message: `[DRY RUN] Would upload ${conversations.length} conversation(s) for ${sourceEmail} → ${mappedTo}`
        });
        userRecord.status = 'success';
        userRecord.pages_created = conversations.length;
        result.users.push(userRecord);
        result.migratedUsers++;
        emitProgress();
        continue;
      }

      // Live: get service account auth for the destination user
      let destUserAuth;
      try {
        destUserAuth = getServiceAccountAuth(mappedTo);
      } catch (err) {
        const errMsg = `${sourceEmail}: cannot impersonate ${mappedTo} — ${err.message}`;
        result.errors.push(errMsg);
        userRecord.status = 'failed';
        userRecord.error_count++;
        userRecord.errors.push({ conversation: '', error_message: err.message });
        result.users.push(userRecord);
        onLog({ type: 'error', message: errMsg });
        emitProgress();
        continue;
      }

      // Create destination folder in the user's own Drive
      const folderName = opts?.gemName || 'Gemini Conversations';
      let mainFolder;
      try {
        mainFolder = await createDriveFolder(destUserAuth, folderName);
        onLog({ type: 'info', message: `Created folder "${folderName}" in ${mappedTo}'s Drive` });
      } catch (err) {
        const errMsg = `${sourceEmail}: folder create failed in ${mappedTo}'s Drive — ${err.message}`;
        result.errors.push(errMsg);
        userRecord.status = 'failed';
        userRecord.error_count++;
        userRecord.errors.push({ conversation: '', error_message: err.message });
        result.users.push(userRecord);
        onLog({ type: 'error', message: errMsg });
        emitProgress();
        continue;
      }

      // --- Drive file correlation: find files this user accessed during chat windows ---
      // Uses Admin Reports API + Drive metadata to attach referenced files to each turn.
      // Requires sourceAuth (admin OAuth client with admin.reports + drive scopes).
      let enrichedConvs = conversations;
      if (sourceAuth) {
        try {
          const correlator = new FileCorrelator(sourceAuth, sourceEmail);
          enrichedConvs = await correlator.enrichConversations(conversations);
          const refCount = enrichedConvs.reduce((sum, c) => sum + (c.turns?.filter(t => t.driveFiles?.length > 0).length || 0), 0);
          if (refCount > 0) onLog({ type: 'info', message: `Audit log matched files for ${refCount} turn(s) of ${sourceEmail}` });
        } catch (err) {
          onLog({ type: 'warn', message: `Drive file correlation skipped for ${sourceEmail}: ${err.message}` });
          enrichedConvs = conversations;
        }
      }

      // --- Download referenced files from source Drive, upload to dest user's Drive ---
      // Cached per fileId so a file referenced in multiple turns is only migrated once.
      const fileMigrationCache = new Map();
      let migratedAssetCount = 0;
      for (const conv of enrichedConvs) {
        for (const turn of (conv.turns || [])) {
          if (!turn.driveFiles?.length) continue;
          for (const f of turn.driveFiles) {
            if (!f.driveFileId) continue;
            if (fileMigrationCache.has(f.driveFileId)) {
              const cached = fileMigrationCache.get(f.driveFileId);
              if (cached) { f._uploadedLink = cached.webViewLink; f._imageBuffer = cached.imageBuffer; }
              continue;
            }
            try {
              const dl = await downloadFromSourceDrive(sourceAuth, f.driveFileId, f.mimeType);
              const uploadName = dl.ext ? `${f.fileName}${dl.ext}` : f.fileName;
              const uploaded = await uploadFileToDrive(destUserAuth, uploadName, dl.mime, dl.buffer, mainFolder.id);
              const imageBuffer = (f.mimeType || '').startsWith('image/') ? dl.buffer : null;
              fileMigrationCache.set(f.driveFileId, { webViewLink: uploaded.webViewLink, imageBuffer });
              f._uploadedLink = uploaded.webViewLink;
              f._imageBuffer = imageBuffer;
              result.filesUploaded++;
              migratedAssetCount++;
              userRecord.files_created++;
              onLog({ type: 'success', message: `  Drive file migrated: "${f.fileName}" → ${mappedTo}'s Drive` });
            } catch (err) {
              fileMigrationCache.set(f.driveFileId, null);
              userRecord.errors.push({ conversation: f.fileName, error_message: err.message });
              onLog({ type: 'warn', message: `  Drive file copy failed for "${f.fileName}": ${err.message}` });
            }
          }
        }
      }
      if (migratedAssetCount > 0) onLog({ type: 'info', message: `Migrated ${migratedAssetCount} attached file(s) for ${sourceEmail}` });

      const batches = [];
      for (let i = 0; i < enrichedConvs.length; i += BATCH_SIZE) {
        batches.push(enrichedConvs.slice(i, i + BATCH_SIZE));
      }

      onLog({
        type: 'info',
        message: `Uploading ${enrichedConvs.length} conversation(s) in ${batches.length} batch(es) to ${mappedTo}'s Drive...`
      });

      let userBatchErrors = 0;
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const startConvNum = batchIdx * BATCH_SIZE + 1;

        try {
          const docxBuffer = await buildMergedBatchDocx(batch, sourceEmail, startConvNum);
          const partLabel = batches.length > 1 ? `_Part${batchIdx + 1}` : '';
          const localPart = sourceEmail.split('@')[0];
          const docxName = `${localPart}_Conversations${partLabel}.docx`;

          await uploadFileToDrive(
            destUserAuth,
            docxName,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            docxBuffer,
            mainFolder.id
          );

          result.filesUploaded++;
          userRecord.files_created++;
          userRecord.pages_created += batch.length;

          onLog({
            type: 'success',
            message: `${sourceEmail} → ${mappedTo}: batch ${batchIdx + 1}/${batches.length} uploaded → ${docxName}`
          });
          emitProgress();
        } catch (err) {
          userBatchErrors++;
          const errMsg = `${sourceEmail} batch ${batchIdx + 1}: ${err.message}`;
          result.errors.push(errMsg);
          userRecord.error_count++;
          userRecord.errors.push({ conversation: `batch ${batchIdx + 1}`, error_message: err.message });
          onLog({
            type: 'warn',
            message: `${sourceEmail}: batch ${batchIdx + 1} error: ${err.message}`
          });
          emitProgress();
        }
      }

      userRecord.status = userBatchErrors === 0
        ? 'success'
        : (userRecord.files_created > 0 ? 'partial' : 'failed');
      result.users.push(userRecord);
      result.migratedUsers++;
      onLog({
        type: 'success',
        message: `Completed ${sourceEmail} → ${mappedTo}: ${userRecord.files_created} file(s) uploaded`
      });
      emitProgress();
    }

    if (usingTempDir) fs.rmSync(tempDir, { recursive: true, force: true });

  } catch (err) {
    console.error('[G2G] Migration error:', err);
    result.errors.push(err.message || String(err));
    onLog({ type: 'error', message: err.message });
    if (usingTempDir && tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }

  return result;
}
