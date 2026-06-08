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
import {
  recoverFilesFromConversation,
  cleanupWorkDirs,
} from '../../gemini/fileRegenerator.js';
import {
  CONVERSATIONS_SUBFOLDER,
  attachmentsSubfolderName,
} from '../../_shared/destinationFolders.js';

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
      // Choose prefix based on origin:
      //   - _uploadedLink set → AI-generated file uploaded by GEM_CO
      //   - _contentMigrated → Drive-attached file moved separately by Content Migration
      //   - neither → fallback (rare)
      const linkUrl = f._uploadedLink || '';
      const prefix = f._uploadedLink
        ? '[Destination Drive] '
        : f._contentMigrated
          ? '[Migrated via Content Migration] '
          : '[Source link] ';
      const color = f._uploadedLink ? '38761D' : f._contentMigrated ? '0B5394' : '888888';
      const label = f.fileName || 'attached file';
      const children = [new TextRun({ text: prefix, size: 18, bold: true, color })];
      if (linkUrl) {
        children.push(new ExternalHyperlink({
          link: linkUrl,
          children: [new TextRun({ text: label, style: 'Hyperlink', size: 20, color: '0B5394', underline: {} })],
        }));
      } else {
        // No link to a destination file — show the filename so the user can
        // find it in their own Drive after Content Migration completes.
        children.push(new TextRun({ text: label, size: 20, color: '0B5394', italics: true }));
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

export async function buildMergedBatchDocx(batch, userEmail, startConvIdx) {
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

  // ── Conversation Index (first page) ────────────────────────────────
  // Lists every conversation title with its first-message timestamp and
  // message count so the user can navigate the bundled DOCX at a glance.
  // Matches the layout used by C2G and CL2G.
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 160 },
      children: [new TextRun({ text: 'CONVERSATION INDEX', bold: true, size: 26, color: '0B5394', allCaps: true })],
    })
  );
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];
    const convIdx = startConvIdx + i;
    const title = c.title || `Conversation ${convIdx}`;
    const firstDate = c.turns?.[0]?.timestamp;
    const dateStr = firstDate ? formatTimestamp(firstDate) : '';
    const msgCount = (c.turns || []).length;

    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${convIdx}.  `, bold: true, size: 20, color: '0B5394' }),
          new TextRun({ text: title, size: 20, color: '1E3A5F', bold: true }),
          new TextRun({ text: dateStr ? `\t${dateStr}` : '', size: 18, color: '999999' }),
          new TextRun({ text: `  (${msgCount} msg${msgCount !== 1 ? 's' : ''})`, size: 17, color: 'AAAAAA' }),
        ],
      })
    );
  }
  // Page break so conversations start on a fresh page
  children.push(new Paragraph({ spacing: { before: 400 }, children: [new PageBreak()] }));

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

async function createDriveFolder(auth, folderName, parentFolderId) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentFolderId ? [parentFolderId] : undefined,
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
  { vaultZipPath, extractPath, sourceAuth, destAuth, isDryRun, selectedUsers, userMappings, opts,
    batchId, appUserId, sourceAccountId, destAccountId, uploadId: rawUploadId },
  onLog
) {
  // The upload endpoint stores the raw filename hash as uploadId in conversationStore.
  // G2G receives the full extractPath (e.g. ".../uploads/extracted_<hash>"). Derive
  // the actual uploadId by stripping the "extracted_" prefix from the path basename,
  // so DB-first read and status marking match the row keys.
  let uploadId = rawUploadId;
  if (uploadId && typeof uploadId === 'string') {
    const base = path.basename(uploadId);
    if (base.startsWith('extracted_')) {
      uploadId = base.slice('extracted_'.length);
    } else {
      uploadId = base;
    }
  }
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

    // After the move to DB-only storage, the disk extract is deleted at upload
    // time. VaultReader is now only instantiated when the disk path actually
    // exists (legacy uploads + dev/test); otherwise we use the upload metadata
    // document for user discovery and conversationStore for conversation
    // loading.
    const diskAvailable = !!readerPath && fs.existsSync(readerPath);
    const vaultReader = diskAvailable ? new VaultReader(readerPath) : null;

    let allUsers;
    if (vaultReader) {
      onLog({ type: 'info', message: 'Reading conversations from Vault export...' });
      allUsers = await vaultReader.discoverUsers();
    } else {
      // DB-only path: look up the upload doc for the user list
      onLog({ type: 'info', message: 'Reading user list from upload metadata (DB-only mode)...' });
      const { getDb } = await import('../../../db/mongo.js');
      const uploadDoc = uploadId ? await getDb().collection('geminiUploads').findOne({ _id: uploadId }) : null;
      if (!uploadDoc) {
        result.errors.push(`Upload ${uploadId || '(none)'} not found in DB and disk extract is gone — please re-upload the Vault ZIP.`);
        onLog({ type: 'error', message: result.errors[0] });
        return result;
      }
      allUsers = (uploadDoc.users || []).map(u => ({ email: u.email, displayName: u.displayName, conversationCount: u.conversationCount }));
    }

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
        // Total conversations read for this user (source count). Set after we
        // load them below. Reports panel + CSV "Total Conversations" column.
        conversations_processed: 0,
        // Migrated conversations = how many actually made it into the DOCX(s)
        // at the destination. <= conversations_processed.
        migrated_conversations: 0,
        // Attachment files only (images / PDFs uploaded as standalone files).
        // The conversation DOCX is NOT counted here — it's the conversation
        // container, not a "file" in the Reports/CSV sense.
        files_uploaded: 0,
        error_count: 0,
        errors: [],
      };

      onLog({ type: 'info', message: `Processing: ${sourceEmail} → ${mappedTo}` });
      onLog({ type: 'user', message: sourceEmail });

      let conversations = [];
      let userAlreadyFullyMigrated = false;
      try {
        // DB-first: try conversationStore (populated at upload time)
        if (appUserId && uploadId) {
          try {
            const { loadConversationsFromStore } = await import('../../_shared/conversationStore.js');
            // On RESUME, only load unmigrated rows. If user has 0 unmigrated rows
            // (already fully migrated), skip them. Fresh runs load everything.
            const fromStore = await loadConversationsFromStore({
              appUserId,
              sourceEmail,
              uploadId,
              fromDate: opts?.fromDate,
              toDate: opts?.toDate,
              includeMigrated: !opts?.isResume,   // ← key change: resume skips already-done
            });
            if (fromStore && fromStore.length > 0) {
              conversations = fromStore;
              onLog({ type: 'info', message: `  Loaded ${conversations.length} conversations from conversationStore for ${sourceEmail}${opts?.isResume ? ' (RESUME)' : ''}` });
            } else if (opts?.isResume) {
              // Resume + empty result = this user pair is fully migrated already
              userAlreadyFullyMigrated = true;
              onLog({ type: 'info', message: `  Skipping ${sourceEmail} — all conversations already migrated (resume)` });
            }
          } catch (_) { /* fall through to disk */ }
        }
        // Disk fallback only when we actually have a disk reader (legacy uploads).
        // After the DB-only move, vaultReader is null and the migration is
        // entirely DB-driven — a 0-length result here means the conversationStore
        // doesn't have this user's data, and we should fail loudly.
        if (conversations.length === 0 && !userAlreadyFullyMigrated) {
          if (vaultReader) {
            conversations = await vaultReader.loadUserConversations(
              sourceEmail,
              opts?.fromDate,
              opts?.toDate
            );
          } else {
            onLog({ type: 'warn', message: `  No conversations in conversationStore for ${sourceEmail} — upload may need to be re-done.` });
          }
        }
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
        const msg = userAlreadyFullyMigrated
          ? `All conversations for ${sourceEmail} already migrated — skipping (resume)`
          : `No conversations for ${sourceEmail}`;
        onLog({ type: userAlreadyFullyMigrated ? 'info' : 'warn', message: msg });
        userRecord.status = 'success';
        result.users.push(userRecord);
        result.migratedUsers++;
        emitProgress();
        continue;
      }

      result.conversationsCount += conversations.length;
      userRecord.conversations_processed = conversations.length;

      // Note: conversations already persisted to conversationStore at upload time
      // (via the shared /api/upload endpoint that serves both G2C and G2G).

      if (isDryRun) {
        onLog({
          type: 'info',
          message: `[DRY RUN] Would upload ${conversations.length} conversation(s) for ${sourceEmail} → ${mappedTo}`
        });
        userRecord.status = 'success';
        userRecord.pages_created = conversations.length;
        userRecord.migrated_conversations = conversations.length;
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

      // Create destination folder structure in the user's own Drive.
      // Universal 2-subfolder pattern (see _shared/destinationFolders.js):
      //   {folderName}/
      //   ├── Conversations/          ← bundled DOCXs go here
      //   └── Migrated from Gemini/   ← regenerated images / attachments
      const folderName = opts?.gemName || 'Gemini Conversations';
      const filesSubfolderName = attachmentsSubfolderName('gemini');
      let mainFolder, convoFolder, filesFolder;
      try {
        mainFolder = await createDriveFolder(destUserAuth, folderName);
        convoFolder = await createDriveFolder(destUserAuth, CONVERSATIONS_SUBFOLDER, mainFolder.id);
        filesFolder = await createDriveFolder(destUserAuth, filesSubfolderName, mainFolder.id);
        onLog({ type: 'info', message: `Created folder layout in ${mappedTo}'s Drive: ${folderName}/ → ${CONVERSATIONS_SUBFOLDER}/, ${filesSubfolderName}/` });
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

      // --- Process referenced files from source Drive ---
      // CloudFuze Content Migration is the canonical Drive → Drive mover.
      // G2G must NOT re-upload Drive-source files — that would create
      // duplicates in the destination. Instead:
      //   • For IMAGES → download bytes for INLINE embedding in the DOCX
      //     (so the conversation visually makes sense). No upload to dest.
      //   • For non-image files → insert a "[Content Migration]" hyperlink
      //     to the source URL; no download, no upload.
      // AI-generated files (regenerated below) are still uploaded since
      // they never existed in the source user's Drive.
      const fileMigrationCache = new Map();
      let inlineImageCount = 0;
      for (const conv of enrichedConvs) {
        for (const turn of (conv.turns || [])) {
          if (!turn.driveFiles?.length) continue;
          for (const f of turn.driveFiles) {
            if (!f.driveFileId) continue;
            if (fileMigrationCache.has(f.driveFileId)) {
              const cached = fileMigrationCache.get(f.driveFileId);
              if (cached) { f._uploadedLink = cached.webViewLink; f._imageBuffer = cached.imageBuffer; f._contentMigrated = cached.contentMigrated; }
              continue;
            }
            // Mark as Content-Migration-handled so the DOCX renderer can
            // label the link clearly ("Migrated via Content Migration").
            f._contentMigrated = true;
            // For images only, fetch the bytes so we can embed inline. This
            // is read-only on source and does NOT create a destination file.
            const isImage = (f.mimeType || '').startsWith('image/');
            if (isImage && sourceAuth) {
              try {
                const dl = await downloadFromSourceDrive(sourceAuth, f.driveFileId, f.mimeType);
                f._imageBuffer = dl.buffer;
                inlineImageCount++;
                fileMigrationCache.set(f.driveFileId, { webViewLink: null, imageBuffer: dl.buffer, contentMigrated: true });
              } catch (err) {
                onLog({ type: 'warn', message: `  Could not fetch image bytes for inline embed "${f.fileName}": ${err.message}` });
                fileMigrationCache.set(f.driveFileId, { webViewLink: null, imageBuffer: null, contentMigrated: true });
              }
            } else {
              fileMigrationCache.set(f.driveFileId, { webViewLink: null, imageBuffer: null, contentMigrated: true });
            }
          }
        }
      }
      if (inlineImageCount > 0) onLog({ type: 'info', message: `Embedded ${inlineImageCount} inline image(s) for ${sourceEmail} (other Drive attachments will be moved by Content Migration)` });

      // --- Phase 1 + Phase 2 file recovery from Vault response text ---
      // Files Gemini generated inside the chat (inline CSV/JSON/HTML, or
      // Python-executed PDFs/XLSXs) live ONLY as text in Vault. FileCorrelator
      // can't catch these because they were never in Drive.
      //
      // CRITICAL: this step has a per-user time budget. Python sandbox
      // execution (60s timeout per block) can pile up — if a user has many
      // Python file-writing blocks, regen could take 30+ minutes and BLOCK
      // the conversation DOCX upload that follows. We cap total regen time
      // per user; once exhausted we skip remaining and continue to DOCX so
      // conversations always migrate (the most important part of G2G).
      const REGEN_BUDGET_MS = 90_000; // 90 seconds per user
      const regenStart = Date.now();
      let regeneratedCount = 0;
      let regenBudgetExceeded = false;
      const regenWorkDirs = [];
      for (const conv of enrichedConvs) {
        if (Date.now() - regenStart > REGEN_BUDGET_MS) {
          regenBudgetExceeded = true;
          break;
        }
        let recovered;
        try {
          recovered = await recoverFilesFromConversation(conv);
        } catch (err) {
          onLog({ type: 'warn', message: `  Gemini regen failed for "${conv.title}": ${err.message}` });
          continue;
        }
        if (!recovered.length) continue;
        regenWorkDirs.push(...recovered.filter(r => r.workDir));

        for (const f of recovered) {
          // Surface failed/empty regen attempts so the migration report
          // can show them (instead of silently dropping). Each one becomes
          // a row in userRecord.errors with a customer-readable reason.
          if (f._failed) {
            userRecord.errors.push({
              conversation: conv.title,
              error_message: `Could not regenerate file from ${f.sourceTag}: ${f.reason}. ${(f.stderr || '').slice(0, 100)}`,
            });
            onLog({ type: 'warn', message: `  Gemini regen failed in "${conv.title}" (${f.sourceTag}): ${f.reason}` });
            continue;
          }
          try {
            const buf = f.buffer || fs.readFileSync(f.fullPath);
            const uploaded = await uploadFileToDrive(destUserAuth, f.name, f.mime, buf, filesFolder.id);
            const turn = conv.turns?.[f.turnIndex];
            if (turn) {
              if (!turn.driveFiles) turn.driveFiles = [];
              turn.driveFiles.push({
                fileName: f.name,
                mimeType: f.mime,
                _uploadedLink: uploaded.webViewLink,
                _imageBuffer: (f.mime || '').startsWith('image/') ? buf : null,
              });
            }
            result.filesUploaded++;
            userRecord.files_created++;
            // Real attachment (image regen) — counts toward "Files" in CSV/Reports.
            userRecord.files_uploaded++;
            regeneratedCount++;
            onLog({ type: 'success', message: `  Gemini-regenerated: "${f.name}" (${buf.length} bytes) → ${mappedTo}'s Drive` });
          } catch (err) {
            userRecord.errors.push({ conversation: f.name, error_message: err.message });
            onLog({ type: 'warn', message: `  Gemini regen upload failed for "${f.name}": ${err.message}` });
          }
        }
      }
      if (regenBudgetExceeded) {
        onLog({ type: 'warn', message: `Gemini regen time budget exceeded (${Math.round(REGEN_BUDGET_MS/1000)}s) for ${sourceEmail} — continuing to DOCX upload so conversations still migrate. Recovered ${regeneratedCount} file(s) before stopping.` });
      } else if (regeneratedCount > 0) {
        onLog({ type: 'info', message: `Regenerated ${regeneratedCount} file(s) from Gemini chat content for ${sourceEmail}` });
      }
      cleanupWorkDirs(regenWorkDirs);

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
            convoFolder.id
          );

          result.filesUploaded++;
          userRecord.files_created++;
          userRecord.pages_created += batch.length;
          // batch.length conversations just landed at the destination — that's
          // what "Migrated Conversations" counts. The DOCX itself is NOT a file
          // (it's the conversation container), so files_uploaded is not bumped here.
          userRecord.migrated_conversations += batch.length;

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
      // Mark conversationStore rows for this user pair (live runs only)
      if (!isDryRun && batchId && appUserId) {
        try {
          const { markUserPairMigrated, markUserPairFailed } = await import('../../_shared/conversationStore.js');
          if (userRecord.status === 'failed') {
            await markUserPairFailed({ appUserId, uploadId, batchId, sourceEmail, error: `${userBatchErrors} batch error(s)` });
          } else {
            await markUserPairMigrated({ appUserId, uploadId, batchId, sourceEmail, destEmail: mappedTo });
          }
        } catch (_) { /* non-fatal */ }
      }
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
