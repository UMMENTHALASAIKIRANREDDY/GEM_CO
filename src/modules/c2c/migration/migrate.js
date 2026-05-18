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
import { resolveDestUser, createOneDriveFolder, uploadFileToOneDrive } from '../destGraph.js';
import { OneNotePagesCreator } from '../oneNotePages.js';
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

// Light-weight attachment extraction — flag-only, no download (Phase 1).
// Future enhancement: fully download + reupload like C2G does.
function extractAttachmentNames(item) {
  const out = [];
  for (const a of (item.attachments || [])) {
    if (a.name) out.push({ name: a.name, url: a.contentUrl || '' });
  }
  for (const c of (item.contexts || [])) {
    const ref = c.contextReference;
    if (ref?.name) out.push({ name: ref.name, url: ref.webUrl || ref['@odata.id'] || '' });
  }
  return out;
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
    const sourceFolderName = `Migrated from ${sourceLabel || 'Copilot'}`;
    const pagesCreator = new OneNotePagesCreator(destTenantId, customerName, sourceLabel || 'Copilot', destDelegatedAuth);

    // 8. Lazy: create attachments folder only if we actually have files to upload
    let attachmentsFolder = null;
    const ensureAttachmentsFolder = async () => {
      if (attachmentsFolder) return attachmentsFolder;
      attachmentsFolder = await createOneDriveFolder(destTenantId, destUser.id, sourceFolderName);
      return attachmentsFolder;
    };

    // 9. For each conversation, optionally upload attached files + create OneNote page
    const fileLinks = new Map(); // original URL → uploaded OneDrive URL (per-user, used by pages)
    for (const [, items] of sessions.entries()) {
      const title = conversationTitle(items);

      // Build the turn-shape that OneNotePagesCreator expects
      const turns = [];
      const conversationAttachments = [];
      for (const item of items) {
        const text = extractText(item);
        const isUser = item.interactionType === 'userPrompt';
        const attachments = extractAttachmentNames(item);
        if (!text && attachments.length === 0) continue;
        turns.push({
          isUser,
          text,
          timestamp: item.createdDateTime,
          attachments,
        });
        for (const a of attachments) conversationAttachments.push(a);
      }

      // Skip empty conversations (no readable content)
      if (turns.length === 0) continue;

      const conv = {
        title,
        createdDateTime: items[0]?.createdDateTime,
        turns,
      };

      // Try to upload attached files (best-effort — Phase 1 doesn't fetch binary content,
      // it just stores the original Copilot URL). Future enhancement: fully download + reupload.
      // For now we skip the upload step but still surface the file name as a link in the page.

      try {
        const pageId = await pagesCreator.createConversationPage(destUserEmail, conv, fileLinks);
        result.pagesCreated++;
        result.pages.push({ title, pageId });
        if (onProgress) onProgress({
          pagesCreated: result.pagesCreated,
          filesUploaded: result.filesUploaded,
          totalConvs: sessions.size,
        });
      } catch (err) {
        result.errors.push(`Page "${title.slice(0, 50)}": ${err.message}`);
        if (err.message?.includes('ONENOTE_NOT_PROVISIONED')) {
          // Stop further attempts for this user — OneNote isn't activated
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
