/**
 * OneNote page creator for C2C — uses the DESTINATION tenant's app-only token
 * (so we can write to any destination user's OneNote without that user being
 * signed in interactively).
 *
 * Structure (mirrors G2C's PagesCreator):
 *   {customerName} notebook → {customerName} Conversations section → pages
 *
 * Requires Microsoft Graph Application permission: Notes.ReadWrite.All
 * (admin consent required on the destination tenant).
 */

import { getValidToken } from '../../core/auth/microsoft.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('c2c:onenote');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return String(iso); }
}

/**
 * fetch() with retry on 5xx responses (502 Bad Gateway, 503 Service Unavailable,
 * 504 Gateway Timeout, 500 Internal Server Error). OneNote's Graph API is one of
 * the flakier Microsoft endpoints — bursts of UnknownError + 504 are common
 * when the destination user's mailbox region is busy. Microsoft's own SDK docs
 * recommend retry-with-backoff for 5xx.
 *
 * 4xx responses are NOT retried (client errors won't get better with retries).
 * Returns the last response regardless of success — caller still checks .ok.
 */
async function _fetchWithRetry(url, opts, label) {
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(url, opts);
    if (res.ok) return res;
    if (res.status < 500 || attempt === 3) return res;
    const waitMs = Math.pow(3, attempt - 1) * 1000; // 1s, 3s, 9s
    logger.warn(`${label}: HTTP ${res.status} — retry ${attempt}/3 in ${waitMs}ms`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  return res;
}

export class OneNotePagesCreator {
  /**
   * @param {string} destTenantId      Destination tenant GUID (kept for logging/back-compat)
   * @param {string} customerName      Notebook display name (e.g. "Copilot")
   * @param {string} sourceLabel       For the page footer (e.g. "Filefuze" — source tenant display name)
   * @param {object} [delegatedAuth]   { appUserId, accountId } — the destination tenant
   *   admin's MS account in our session map. Required because Microsoft has
   *   deprecated APPLICATION-permission access to /users/{id}/onenote/* —
   *   we must use the admin's DELEGATED Notes.ReadWrite.All token instead.
   *   (Same approach as G2C's PagesCreator.)
   */
  constructor(destTenantId, customerName = 'Copilot', sourceLabel = 'Copilot', delegatedAuth = null) {
    this.destTenantId = destTenantId;
    this.customerName = customerName;
    this.sourceLabel = sourceLabel;
    this.delegatedAuth = delegatedAuth;
    this._sectionIds = {}; // cached per target email
  }

  async _headers() {
    if (!this.delegatedAuth?.appUserId) {
      throw new Error('OneNotePagesCreator: destination admin delegated token not configured. App-only OneNote API is deprecated by Microsoft; the destination admin must be signed in via OAuth.');
    }
    const token = await getValidToken(this.delegatedAuth.appUserId, this.delegatedAuth.accountId);
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Get or create the notebook + Conversations section in the target user's OneNote.
   */
  async _getOrCreateSection(targetEmail) {
    if (this._sectionIds[targetEmail]) return this._sectionIds[targetEmail];

    const headers = await this._headers();
    const notebookName = this.customerName;
    const sectionName = `${this.customerName} Conversations`.slice(0, 46);

    // Find or create notebook
    const filterNb = encodeURIComponent(`displayName eq '${notebookName}'`);
    let nbRes = await fetch(
      `${GRAPH_BASE}/users/${encodeURIComponent(targetEmail)}/onenote/notebooks?$filter=${filterNb}`,
      { headers }
    );
    let notebook = null;
    if (nbRes.ok) {
      const nbData = await nbRes.json();
      notebook = (nbData.value || [])[0] || null;
    }

    if (!notebook) {
      const createRes = await fetch(
        `${GRAPH_BASE}/users/${encodeURIComponent(targetEmail)}/onenote/notebooks`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: notebookName }),
        }
      );
      if (!createRes.ok) {
        const errText = await createRes.text();
        let errCode = null;
        try { errCode = JSON.parse(errText)?.error?.code; } catch {}
        if (createRes.status === 404 && errCode === '20102') {
          throw new Error(
            `ONENOTE_NOT_PROVISIONED:${targetEmail} — OneNote/OneDrive not yet provisioned. ` +
            `${targetEmail} must sign in to OneDrive (https://onedrive.com) or OneNote at least once.`
          );
        }
        throw new Error(`Cannot create notebook for ${targetEmail}: ${createRes.status} — ${errText.slice(0, 200)}`);
      }
      notebook = await createRes.json();
      logger.info(`Created notebook "${notebookName}" for ${targetEmail}`);
    }

    // Find or create section (retry-with-backoff on 5xx — OneNote's API flakes
    // intermittently with 504 / 503 / UnknownError when the mailbox region is busy)
    const filterSec = encodeURIComponent(`displayName eq '${sectionName}'`);
    const secRes = await _fetchWithRetry(
      `${GRAPH_BASE}/users/${encodeURIComponent(targetEmail)}/onenote/notebooks/${notebook.id}/sections?$filter=${filterSec}`,
      { headers },
      `[onenote] lookup section "${sectionName}" for ${targetEmail}`
    );
    let section = null;
    if (secRes.ok) {
      const secData = await secRes.json();
      section = (secData.value || [])[0] || null;
    }

    if (!section) {
      const createSec = await _fetchWithRetry(
        `${GRAPH_BASE}/users/${encodeURIComponent(targetEmail)}/onenote/notebooks/${notebook.id}/sections`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: sectionName }),
        },
        `[onenote] create section "${sectionName}" for ${targetEmail}`
      );
      if (!createSec.ok) {
        const err = await createSec.text();
        // After 3 retries, surface a clearer error message so the operator knows
        // this was a transient OneNote/Graph backend issue (likely retryable in
        // a few minutes), not a permission or data problem.
        const hint = createSec.status >= 500
          ? ' (OneNote API transient error — retry the migration in a few minutes)'
          : '';
        throw new Error(`Cannot create section for ${targetEmail}: ${createSec.status}${hint} — ${err.slice(0, 200)}`);
      }
      section = await createSec.json();
      logger.info(`Created section "${sectionName}" for ${targetEmail}`);
    }

    this._sectionIds[targetEmail] = section.id;
    return section.id;
  }

  /**
   * Create one OneNote page per Copilot conversation.
   *
   * @param {string} targetEmail
   * @param {object} conversation  { title, createdDateTime, turns: [{senderLabel, text, timestamp}] }
   * @param {Map<string,string>} [fileLinks]  optional: original URL → uploaded OneDrive URL
   * @returns {Promise<string>} page id
   */
  async createConversationPage(targetEmail, conversation, fileLinks = null) {
    const sectionId = await this._getOrCreateSection(targetEmail);
    const html = this._buildPageHtml(conversation, fileLinks);

    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(
        `${GRAPH_BASE}/users/${encodeURIComponent(targetEmail)}/onenote/sections/${sectionId}/pages`,
        {
          method: 'POST',
          headers: { ...await this._headers(), 'Content-Type': 'text/html' },
          body: html,
        }
      );
      if (res.ok) {
        const data = await res.json();
        return data.id;
      }
      const body = await res.text();
      lastError = `OneNote page failed for ${targetEmail}: ${res.status} — ${body.slice(0, 300)}`;
      if (res.status < 500 || attempt === MAX_RETRIES) break;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
    throw new Error(lastError);
  }

  _buildPageHtml(conv, fileLinks) {
    const title = conv.title || 'Migrated Copilot Conversation';
    const date = conv.createdDateTime ? formatTimestamp(conv.createdDateTime) : 'Unknown date';
    const turns = conv.turns || [];

    const turnsHtml = turns.map((t, i) => {
      const senderColor = t.isUser ? '#0078d4' : '#107c10';
      const senderBg = t.isUser ? '#deecf9' : '#dff6dd';
      const senderLabel = t.isUser ? 'YOU' : 'COPILOT';
      const text = esc(t.text || '').replace(/\n/g, '<br/>');
      const ts = t.timestamp ? formatTimestamp(t.timestamp) : '';

      // Attached files rendered as links to the migrated copy in OneDrive
      const atts = (t.attachments || []).filter(a => a.name);
      const attsHtml = atts.length > 0 ? `
        <tr>
          <td style="padding:4px 0"><b style="color:#8764b8">📎 Attached Files</b></td>
        </tr>
        <tr>
          <td style="background:#f4f0fa;border:1px solid #c8b8e8;padding:12px 16px">
            ${atts.map(a => {
              const link = fileLinks?.get?.(a.url) || a.url || '';
              return link
                ? `<a href="${esc(link)}" style="color:#8764b8">${esc(a.name)}</a>`
                : `<span style="color:#605e5c">${esc(a.name)} <i>(no link)</i></span>`;
            }).join('<br/>')}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>` : '';

      return `
        <tr><td style="border-bottom:2px solid ${senderColor};padding:16px 0 4px 0"><b style="font-size:16px;color:${senderColor}">${senderLabel} ${i + 1}</b>${ts ? `&nbsp;&nbsp;<span style="color:#a19f9d;font-size:12px">${esc(ts)}</span>` : ''}</td></tr>
        <tr>
          <td style="background:${senderBg};padding:12px 16px">
            ${text || '<i style="color:#a19f9d">(empty)</i>'}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>
        ${attsHtml}`;
    }).join('\n');

    const dateLine = `${new Date().toISOString().slice(0, 10)}`;

    return `<!DOCTYPE html>
<html>
<head>
  <title>${esc(title)}</title>
  <meta name="created" content="${new Date().toISOString()}" />
</head>
<body style="font-family:Calibri,sans-serif">
  <h1 style="font-size:24px;color:#0078d4;margin-bottom:4px">${esc(title)}</h1>
  <table border="0" width="100%" cellpadding="0" cellspacing="0" style="width:720px;border-collapse:collapse">
    <tr>
      <td style="background:#f3f2f1;padding:10px 16px;font-size:13px;color:#605e5c">
        📅 <b>Date:</b> ${esc(date)} &nbsp;&nbsp;|&nbsp;&nbsp; 💬 <b>Messages:</b> ${turns.length}
      </td>
    </tr>
    <tr><td style="padding:8px 0">&nbsp;</td></tr>
    ${turnsHtml}
    <tr>
      <td style="border-top:1px solid #e1dfdd;padding:12px 0;font-size:11px;color:#a19f9d">
        Migrated from ${esc(this.sourceLabel)} by CloudFuze · ${dateLine}
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
