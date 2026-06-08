/**
 * C2C migration runner: Copilot interactions from SOURCE tenant → OneNote in DESTINATION tenant.
 *
 * Mirrors G2C's pattern:
 *   - Each conversation becomes ONE OneNote page in the destination user's notebook
 *   - Notebook: "{customerName}" (default "Copilot")
 *   - Section:  "{customerName} Conversations"
 *   - Page footer: "Migrated from {SourceTenantName} by CloudFuze"
 *   - Attached files → "Migrated from {SourceTenantName}" folder in destination user's OneDrive
 *   - File links embedded in OneNote pages
 *
 * Source fetch reuses C2G's copilotService — zero impact on existing modules.
 * Destination uses app-only tokens (multiTenantAuth) so it works cross-tenant.
 */

import { fetchAllEnterpriseInteractions } from '../../c2g/graph.js';
import { isCopilotChatSurface, buildCopilotChatOnlyFilter } from '../../c2g/appClass.js';
import { getTenantAccessToken } from '../multiTenantAuth.js';
import { resolveDestUser, createOneDriveFolder, uploadFileToOneDrive, getDestDriveRoot } from '../destGraph.js';
import { OneNotePagesCreator } from '../oneNotePages.js';
import {
  extractAttachments,
  downloadBinary,
  guessExtension,
  guessMime,
} from '../fileMigrator.js';
import {
  regenerateFilesFromInteraction,
  pickRegeneratedFileByName,
  cleanupRegen,
} from '../codeRegenerator.js';
import fs from 'fs';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('c2c:migrate');

// ── Text + grouping helpers ─────────────────────────────────────────

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Recursively walk an Adaptive Card element tree and concatenate all "text"
// fields. BizChat encodes the final Copilot response as an Adaptive Card
// inside `attachments[].content` while `body.content` is just the placeholder
// `<attachment id="...">`. Without this, the migrated OneNote pages only show
// Copilot's tool-use intents ("OK, I'll search for...") and not the answer.
function _walkAdaptiveCard(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.text === 'string' && node.text.trim()) out.push(node.text);
  for (const key of ['body', 'items', 'columns', 'actions', 'elements']) {
    const arr = node[key];
    if (Array.isArray(arr)) for (const child of arr) _walkAdaptiveCard(child, out);
  }
}

function _extractFromAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const chunks = [];
  for (const att of attachments) {
    const ct = att?.contentType || '';
    let payload = att?.content;
    if (typeof payload === 'string' && ct.includes('adaptive')) {
      try { payload = JSON.parse(payload); } catch { continue; }
    }
    if (payload && typeof payload === 'object') _walkAdaptiveCard(payload, chunks);
    else if (typeof att?.content === 'string' && !ct.includes('adaptive')) {
      chunks.push(att.content);
    }
  }
  return chunks.join('\n\n').trim();
}

function extractText(interaction) {
  const body = interaction.body?.content ?? '';
  const contentType = interaction.body?.contentType ?? 'text';
  const rawBody = contentType === 'html' ? stripHtml(body) : String(body).trim();

  // If body is just an <attachment ...> placeholder (or empty after strip),
  // the real text lives in `attachments[].content` (Adaptive Card JSON).
  const bodyIsAttachmentOnly = !rawBody || /^<?attachment\b/i.test(rawBody);
  if (bodyIsAttachmentOnly) {
    const fromAtt = _extractFromAttachments(interaction.attachments);
    if (fromAtt) return fromAtt;
  }
  return rawBody;
}

function groupBySession(interactions) {
  const map = new Map();
  for (const item of interactions) {
    const sid = item.sessionId || 'unknown';
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(item);
  }
  for (const items of map.values()) {
    items.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
  }
  return map;
}

function conversationTitle(items) {
  for (const item of items) {
    if (item.interactionType === 'userPrompt') {
      const text = extractText(item);
      if (text) return text.slice(0, 80).replace(/\n/g, ' ');
    }
  }
  return 'Untitled';
}

// Check whether an attachment URL points at source-tenant PERSONAL OneDrive.
// True only for URLs like `<tenant>-my.sharepoint.com/personal/<user>/...`
// — these are user-personal OneDrive files that CloudFuze Content Migration
// copies to the destination's equivalent personal OneDrive path, so C2C
// SKIPS the upload to avoid duplicating.
//
// Returns false for:
//  - SharePoint site URLs (`*.sharepoint.com/sites/...`) — Content Migration
//    may not cover them or may put them in a different path. Safer to
//    download + re-upload via C2C.
//  - `_layouts/15/Doc.aspx?sourcedoc=...` viewer URLs — the sourcedoc GUID
//    references the source tenant; rewriting the host alone breaks the link.
//  - asyncgw URLs — those are ephemeral, never in OneDrive.
function _isInSourceOneDrive(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('-my.sharepoint.com')) return false;
    // Must be a personal site, with a real Documents path (not a Doc.aspx
    // viewer URL whose sourcedoc references the source tenant).
    if (!/^\/personal\/[^/]+\//i.test(u.pathname)) return false;
    if (/_layouts\/15\/Doc\.aspx/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// Rewrite a source-OneDrive URL to its predicted destination URL.
// CloudFuze Content Migration preserves the path structure, only the
// MySite host + personal site segment change between tenants. We swap:
//   <source>-my.sharepoint.com/personal/<source_user>/...
// → <dest>-my.sharepoint.com/personal/<dest_user>/...
// If OneDrive renames the file on the destination side (dup handling),
// it still resolves to a real file because OneDrive keeps both copies.
function _rewriteSourceUrlForDest(sourceUrl, destMySiteHost, destPersonalSegment) {
  if (!sourceUrl || !destMySiteHost || !destPersonalSegment) return sourceUrl;
  try {
    const u = new URL(sourceUrl);
    u.hostname = destMySiteHost;
    // Replace the /personal/<...>/ segment if present
    u.pathname = u.pathname.replace(
      /\/personal\/[^/]+\//i,
      `/personal/${destPersonalSegment}/`
    );
    return u.toString();
  } catch {
    return sourceUrl;
  }
}

// Build a safe filename for OneDrive upload — keeps the original name when it
// already has an extension, otherwise infers from contentType.
function _safeFileName(name, contentType) {
  const trimmed = String(name || '').trim() || 'attachment';
  // Strip characters OneDrive doesn't allow
  const cleaned = trimmed.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
  if (/\.[a-z0-9]{2,5}$/i.test(cleaned)) return cleaned;
  const ext = guessExtension(contentType, '');
  return cleaned + ext;
}

// ── Source fetch ─────────────────────────────────────────────────────

async function fetchInteractionsWithToken(accessToken, userId) {
  const apiVersion = process.env.GRAPH_API_VERSION?.trim() || 'v1.0';
  const top = Math.min(999, Math.max(1, parseInt(process.env.GRAPH_TOP || '100', 10) || 100));
  const copilotChatOnly =
    String(process.env.COPILOT_CHAT_ONLY ?? 'true').toLowerCase() !== 'false';
  const filter = copilotChatOnly ? buildCopilotChatOnlyFilter() : undefined;

  let interactions = await fetchAllEnterpriseInteractions({
    accessToken, apiVersion, userId, top, filter,
  });

  if (copilotChatOnly) {
    const validSessionIds = new Set(
      interactions.filter(i => isCopilotChatSurface(i.appClass)).map(i => i.sessionId)
    );
    interactions = interactions.filter(i =>
      isCopilotChatSurface(i.appClass) ||
      (i.interactionType === 'userPrompt' && validSessionIds.has(i.sessionId))
    );
  }

  return interactions;
}

// ── Main per-user migration ──────────────────────────────────────────

/**
 * Migrate one user-pair: source user in source tenant → destination user in dest tenant.
 *
 * @param {object} opts
 * @param {string} opts.sourceTenantId
 * @param {string} opts.sourceUserId          GUID in source tenant
 * @param {string} opts.sourceDisplayName
 * @param {string} opts.destTenantId
 * @param {string} opts.destUserEmail         UPN / mail in destination tenant
 * @param {string} [opts.sourceLabel]         For OneNote footers + folder names (e.g. "Filefuze")
 * @param {object} [opts.runOpts]             { folderName, fromDate, toDate, dryRun }
 * @param {Function} [onProgress]
 * @returns {Promise<{ sourceUserId, sourceDisplayName, destUserEmail, conversationsCount, pagesCreated, filesUploaded, errors, pages }>}
 */
export async function migrateC2CUserPair(
  { sourceTenantId, sourceUserId, sourceDisplayName, destTenantId, destUserEmail, sourceLabel, runOpts = {}, destDelegatedAuth = null },
  onProgress = null
) {
  const result = {
    sourceUserId,
    sourceDisplayName: sourceDisplayName || sourceUserId,
    destUserEmail,
    conversationsCount: 0,
    pagesCreated: 0,
    filesUploaded: 0,
    filesSkipped: 0,  // counts files already in source OneDrive (Content Migration handles)
    errors: [],
    pages: [],
  };

  try {
    // 1. Source-tenant token
    let sourceToken;
    try {
      sourceToken = await getTenantAccessToken(sourceTenantId);
    } catch (e) {
      result.errors.push(`Cannot acquire source-tenant token: ${e.message}`);
      return result;
    }

    // 2. Fetch Copilot interactions for the source user
    let interactions;
    try {
      interactions = await fetchInteractionsWithToken(sourceToken, sourceUserId);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('Copilot license')) {
        result.errors.push(`User does not have a valid M365 Copilot license.`);
      } else if (msg.includes('403')) {
        result.errors.push(`Access denied fetching Copilot data: ${msg}`);
      } else {
        result.errors.push(`Failed to fetch Copilot data: ${msg}`);
      }
      return result;
    }

    // 3. Date filter
    if (runOpts.fromDate || runOpts.toDate) {
      const from = runOpts.fromDate ? new Date(runOpts.fromDate) : null;
      const to = runOpts.toDate ? new Date(runOpts.toDate + 'T23:59:59Z') : null;
      interactions = interactions.filter(i => {
        const d = new Date(i.createdDateTime);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
    }

    // 4. Group into conversations (sessions)
    const sessions = groupBySession(interactions);
    result.conversationsCount = sessions.size;
    if (sessions.size === 0) {
      result.errors.push('No Copilot conversations found for this user.');
      return result;
    }

    // 5. Dry run stops here — we have the counts
    if (runOpts.dryRun) {
      return result;
    }

    // 6. Resolve destination user GUID
    let destUser;
    try {
      destUser = await resolveDestUser(destTenantId, destUserEmail);
    } catch (e) {
      result.errors.push(`Destination user not found: ${e.message}`);
      return result;
    }

    // 6.5 Resolve destination MySite host + personal-site segment once.
    // Used to rewrite source-OneDrive URLs to predicted destination paths
    // (Content Migration preserves folder structure between tenants).
    let destMySiteHost = '';
    let destPersonalSegment = destUserEmail.replace('@', '_').replace(/\./g, '_');
    try {
      const driveRoot = await getDestDriveRoot(destTenantId, destUser.id);
      if (driveRoot.webUrl) {
        const u = new URL(driveRoot.webUrl);
        destMySiteHost = u.hostname;
        const m = u.pathname.match(/\/personal\/([^/]+)\//i);
        if (m) destPersonalSegment = m[1];
      }
    } catch (e) {
      logger.warn(`Could not resolve dest MySite host (URL rewrite for source-OneDrive files disabled): ${e.message}`);
    }

    // 7. Set up OneNote pages creator. Uses the destination admin's DELEGATED
    //    token (app-only OneNote API is deprecated by Microsoft).
    if (!destDelegatedAuth?.appUserId) {
      result.errors.push('Destination admin not signed in to this app. C2C requires the destination tenant admin to complete the Connect Clouds sign-in flow.');
      return result;
    }

    // 7.5 Pre-flight (best-effort): try to grant Site Collection Admin to
    // destination admin so OneNote cross-user writes succeed. Currently
    // Microsoft restricts this for federated multi-tenant apps — both Graph
    // and SP REST reject app-only tokens. Helper is kept for future use when
    // Microsoft re-enables app-only SP REST, OR when we add legacy ACS auth.
    // For now: customer admins must do a one-time SCA grant per destination
    // user (UI: "Get access to files" or PowerShell Set-SPOUser). If it fails
    // here, we don't block — the subsequent OneNote call's 40007 error gives
    // the operator a clearer, action-oriented message.
    if (destDelegatedAuth.adminEmail) {
      try {
        const { ensureAdminHasSiteAccess } = await import('../sitePermissions.js');
        await ensureAdminHasSiteAccess({
          destTenantId,
          destUserId: destUser.id,
          destUserEmail,
          adminUserId: destDelegatedAuth.adminUserId,
          adminEmail: destDelegatedAuth.adminEmail,
        });
      } catch (e) {
        logger.warn(`Pre-flight site-access grant failed for ${destUserEmail} (continuing): ${e.message}`);
      }
    }

    const customerName = runOpts.folderName || 'Copilot';
    // OneDrive folder for migrated attachments — fixed name per product spec
    // so the agent manifest can reference a stable path. The OneNote page
    // footer still says "Migrated from <sourceLabel>" for source identification.
    const sourceFolderName = 'Migrated from Copilot';
    const pagesCreator = new OneNotePagesCreator(destTenantId, customerName, sourceLabel || 'Copilot', destDelegatedAuth);

    // 8. Lazy: create attachments folder only if we actually have files to upload
    let attachmentsFolder = null;
    const ensureAttachmentsFolder = async () => {
      if (attachmentsFolder) return attachmentsFolder;
      attachmentsFolder = await createOneDriveFolder(destTenantId, destUser.id, sourceFolderName);
      return attachmentsFolder;
    };

    // 9. For each conversation: extract attachments, download from source,
    //    upload to destination user's "Migrated from <Source>" OneDrive folder,
    //    then create a OneNote page that links to the new copies (not the
    //    source tenant URLs).
    const fileLinks = new Map();      // source URL → uploaded OneDrive webUrl (used by OneNote page renderer)
    const uploadedByUrl = new Map();  // source URL → true (so we don't re-download)
    let convIdx = 0;
    for (const [, items] of sessions.entries()) {
      convIdx++;
      const title = conversationTitle(items);

      // Build turn-shape + collect this conversation's attachment refs.
      // We track WHICH interaction each attachment came from so we can re-run
      // its Python code if direct download fails (Copilot Analysis-tool case).
      const turns = [];
      const conversationAttachments = []; // { att, sourceItem }
      for (const item of items) {
        const text = extractText(item);
        const isUser = item.interactionType === 'userPrompt';
        const attachments = extractAttachments(item);
        if (!text && attachments.length === 0) continue;
        turns.push({
          isUser, text,
          timestamp: item.createdDateTime,
          attachments,
        });
        for (const a of attachments) {
          if (a.url) conversationAttachments.push({ att: a, sourceItem: item });
        }
      }
      if (turns.length === 0) continue;

      // Cache regen results per SESSION — one Python run can produce many files;
      // and the Python source for a given session is often in a different
      // interaction than the one carrying the asyncgw URL. Caching at session
      // level avoids redundant Python execution and finds the code reliably.
      let sessionRegen = null;
      let sessionRegenAttempted = false;
      const uploadedRegenPaths = new Set();  // fullPath of every regen file already uploaded this session

      // Download each unique attachment from source tenant + upload to dest
      // user's OneDrive. Idempotent across conversations (dedup by source URL).
      //
      // We attempt to download EVERY referenced URL (SharePoint, asyncgw, etc.).
      // SharePoint URLs succeed via Graph's /shares/u!{base64} download endpoint
      // using our app-only Files.ReadWrite.All token. asyncgw URLs typically
      // fail because Microsoft locks them behind Teams session auth that bearer
      // tokens can't replicate — those files remain referenced as source-URL
      // links in the OneNote page (user can open in Copilot to grab them).
      for (const { att, sourceItem } of conversationAttachments) {
        if (!att.url || uploadedByUrl.has(att.url)) continue;
        uploadedByUrl.set(att.url, true);

        // Inline data:image/... URLs — user-uploaded screenshots embedded
        // in the chat content as base64. Decode and upload directly; no
        // network fetch needed.
        if (att.url.startsWith('data:')) {
          try {
            const m = att.url.match(/^data:([^;]+);base64,(.+)$/);
            if (!m) {
              logger.warn(`Skip inline image "${att.name}" — malformed data URL`);
              continue;
            }
            const mime = m[1];
            const buf = Buffer.from(m[2], 'base64');
            if (buf.length === 0) {
              logger.warn(`Skip inline image "${att.name}" — empty buffer`);
              continue;
            }
            const fileName = _safeFileName(att.name, mime);
            const folder = await ensureAttachmentsFolder();
            const uploaded = await uploadFileToOneDrive(
              destTenantId, destUser.id, folder.id, fileName, mime, buf
            );
            const link = uploaded?.webUrl || '';
            if (link) fileLinks.set(att.url, link);
            result.filesUploaded++;
            logger.info(`Uploaded inline image "${fileName}" (${buf.length} bytes)`);
            if (onProgress) onProgress({
              pagesCreated: result.pagesCreated,
              filesUploaded: result.filesUploaded,
              convIdx,
              totalConvs: sessions.size,
            });
          } catch (e) {
            result.errors.push(`Inline image "${att.name}": ${e.message}`);
          }
          continue;
        }

        // Files already living in source OneDrive/SharePoint are moved by
        // CloudFuze Content Migration. C2C does NOT re-migrate them (would
        // duplicate). Instead, rewrite the URL to point at the predicted
        // destination location and let the OneNote page link there.
        if (_isInSourceOneDrive(att.url) && destMySiteHost) {
          const rewritten = _rewriteSourceUrlForDest(att.url, destMySiteHost, destPersonalSegment);
          fileLinks.set(att.url, rewritten);
          result.filesSkipped++;
          logger.info(`Skip "${att.name}" — source OneDrive (Content Migration handles). Link rewritten to ${rewritten.slice(0, 100)}`);
          continue;
        }

        try {
          const dl = await downloadBinary(att.url, sourceToken);

          // Direct download worked (SharePoint or directly-accessible URL).
          if (dl) {
            const fileName = _safeFileName(att.name, dl.contentType);
            const mime = dl.contentType || guessMime(fileName.slice(fileName.lastIndexOf('.')));
            const folder = await ensureAttachmentsFolder();
            const uploaded = await uploadFileToOneDrive(
              destTenantId, destUser.id, folder.id, fileName, mime, dl.buffer
            );
            const link = uploaded?.webUrl || '';
            if (link) fileLinks.set(att.url, link);
            result.filesUploaded++;
            if (onProgress) onProgress({
              pagesCreated: result.pagesCreated,
              filesUploaded: result.filesUploaded,
              convIdx,
              totalConvs: sessions.size,
            });
            continue;
          }

          // Direct download failed (asyncgw URLs are locked behind Teams session
          // auth; SharePoint URLs may 401/404 for various reasons). For ANY
          // download failure, try the code-regeneration fallback: if Copilot's
          // Python code that generated the file is anywhere in this session,
          // re-run it and use the regenerated file. This way no attachment
          // referenced in chat is silently lost.

          // Lazy: do regen for the whole session once, reuse for all attachments.
          if (!sessionRegenAttempted) {
            sessionRegenAttempted = true;
            try {
              sessionRegen = await regenerateFilesFromInteraction(items);
            } catch (e) {
              logger.warn(`Session regen failed: ${e.message}`);
            }
          }
          const regen = sessionRegen;
          if (!regen || (regen.files.length === 0)) {
            logger.warn(`Skip attachment "${att.name}" — direct download failed and code-regen produced no files`);
            continue;
          }

          // Match the asyncgw filename to a regen output
          let expectedName = att.name;
          // The URL often ends with the actual filename — prefer that
          const lastSeg = att.url.split('/').pop()?.split('?')[0] || '';
          if (lastSeg && lastSeg.includes('.')) expectedName = lastSeg;
          let match = pickRegeneratedFileByName(regen, expectedName);
          if (!match) {
            // Fallback: pick any regen file we haven't uploaded yet. Better to
            // migrate a file under its true generated name than to skip it.
            match = regen.files.find(f => !uploadedRegenPaths.has(f.fullPath));
            if (match) {
              logger.info(`Attachment "${att.name}" — name match failed for "${expectedName}", uploading unmatched regen file "${match.name}" instead`);
            }
          }
          if (!match) {
            logger.warn(`Skip attachment "${att.name}" — regen produced [${regen.files.map(f => f.name).join(', ')}] but none unused for "${expectedName}"`);
            continue;
          }
          uploadedRegenPaths.add(match.fullPath);

          const fileBuf = fs.readFileSync(match.fullPath);
          const fileName = _safeFileName(match.name, '');
          const mime = guessMime(fileName.slice(fileName.lastIndexOf('.')));
          const folder = await ensureAttachmentsFolder();
          const uploaded = await uploadFileToOneDrive(
            destTenantId, destUser.id, folder.id, fileName, mime, fileBuf
          );
          const link = uploaded?.webUrl || '';
          if (link) fileLinks.set(att.url, link);
          result.filesUploaded++;
          logger.info(`Regenerated + uploaded "${fileName}" (${match.size} bytes) for "${att.name}"`);
          if (onProgress) onProgress({
            pagesCreated: result.pagesCreated,
            filesUploaded: result.filesUploaded,
            convIdx,
            totalConvs: sessions.size,
          });
        } catch (e) {
          result.errors.push(`Attachment "${att.name}": ${e.message}`);
        }
      }

      // Cleanup any regen temp dir for this session
      if (sessionRegen) cleanupRegen(sessionRegen);

      const conv = {
        title,
        createdDateTime: items[0]?.createdDateTime,
        turns,
      };

      try {
        const pageId = await pagesCreator.createConversationPage(destUserEmail, conv, fileLinks);
        result.pagesCreated++;
        result.pages.push({ title, pageId });
        if (onProgress) onProgress({
          pagesCreated: result.pagesCreated,
          filesUploaded: result.filesUploaded,
          convIdx,
          totalConvs: sessions.size,
        });
      } catch (err) {
        result.errors.push(`Page "${title.slice(0, 50)}": ${err.message}`);
        if (err.message?.includes('ONENOTE_NOT_PROVISIONED')) {
          break;
        }
      }
    }
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}

/** Sequential runner for an array of pairs. */
export async function runC2CMigration(pairs, opts = {}, onProgress = null) {
  const results = [];
  for (const pair of pairs) {
    const r = await migrateC2CUserPair({ ...pair, runOpts: opts }, onProgress);
    results.push(r);
  }
  return results;
}
