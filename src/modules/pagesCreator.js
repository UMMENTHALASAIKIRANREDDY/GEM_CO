import { getValidToken } from '../auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:pagesCreator');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Module 4 — OneNote Pages Creator.
 * Creates one OneNote page per Gemini conversation in each TARGET user's account.
 * Uses delegated admin token to access /users/{targetEmail}/onenote/.
 * Structure: {customerName} notebook → {customerName} Conversations section → pages
 */
export class PagesCreator {
  constructor(tenantId, customerName = 'Gemini', appUserId = null) {
    this.tenantId = tenantId;
    this.customerName = customerName;
    this.appUserId = appUserId;
    this._sectionIds = {};   // cached per target email
    this._usedSectionNames = {};  // track used section names per target email to handle duplicates
  }

  async _headers() {
    return { 'Authorization': `Bearer ${await getValidToken(this.appUserId)}` };
  }

  /**
   * Get or create notebook + section in the TARGET user's OneNote.
   * Creates: /users/{targetEmail}/onenote/notebooks/{customerName}/sections/{conversations}
   */
  async _getOrCreateSection(targetEmail) {
    if (this._sectionIds[targetEmail]) return this._sectionIds[targetEmail];

    const headers = await this._headers();
    const notebookName = this.customerName;
    // OneNote section names must be < 50 chars — truncate base and append suffix if needed
    const sectionBase = `${this.customerName} Conversations`.slice(0, 46);
    const sectionName = sectionBase;

    // 1. Find notebook by name using $filter (avoids listing all notebooks)
    const filterNb = encodeURIComponent(`displayName eq '${notebookName}'`);
    let nbRes = await fetch(
      `${GRAPH_BASE}/users/${targetEmail}/onenote/notebooks?$filter=${filterNb}`,
      { headers }
    );

    let notebook = null;

    if (nbRes.ok) {
      const nbData = await nbRes.json();
      notebook = (nbData.value || [])[0] || null;
    }

    // If filter fails (5000+ items error) or notebook not found, just create it
    // Creating a duplicate-named notebook is safe — OneNote allows it
    if (!notebook) {
      const createRes = await fetch(`${GRAPH_BASE}/users/${targetEmail}/onenote/notebooks`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: notebookName })
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Cannot create notebook for ${targetEmail}: ${createRes.status} — ${err.slice(0, 200)}`);
      }
      notebook = await createRes.json();
      logger.info(`Created notebook "${notebookName}" for ${targetEmail}`);
    }

    // 2. Find section by name using $filter (avoids listing all sections — fixes error 10008)
    const filterSec = encodeURIComponent(`displayName eq '${sectionName}'`);
    let secRes = await fetch(
      `${GRAPH_BASE}/users/${targetEmail}/onenote/notebooks/${notebook.id}/sections?$filter=${filterSec}`,
      { headers }
    );

    let section = null;

    if (secRes.ok) {
      const secData = await secRes.json();
      section = (secData.value || [])[0] || null;
    }

    // If filter fails or section not found, create it
    if (!section) {
      const createRes = await fetch(
        `${GRAPH_BASE}/users/${targetEmail}/onenote/notebooks/${notebook.id}/sections`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: sectionName })
        }
      );
      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`Cannot create section for ${targetEmail}: ${createRes.status} — ${err.slice(0, 200)}`);
      }
      section = await createRes.json();
      logger.info(`Created section "${sectionName}" for ${targetEmail}`);
    }

    this._sectionIds[targetEmail] = section.id;
    return section.id;
  }

  /**
   * Create a OneNote page in the TARGET user's account.
   * The page contains the full conversation with prompts, Copilot + Gemini responses.
   */
  async createPage(targetEmail, conversation, flaggedAssets = []) {
    const flaggedIds = new Set(flaggedAssets.map(f => f.conversation_id));
    const isFlagged = flaggedIds.has(conversation.id);

    const sectionId = await this._getOrCreateSection(targetEmail);
    const htmlContent = this._buildPageHtml(conversation, isFlagged);

    const response = await fetch(
      `${GRAPH_BASE}/users/${targetEmail}/onenote/sections/${sectionId}/pages`,
      {
        method: 'POST',
        headers: { ...await this._headers(), 'Content-Type': 'text/html' },
        body: htmlContent
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OneNote page creation failed for ${targetEmail}: ${response.status} — ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    logger.info(`OneNote page created for ${targetEmail}: "${conversation.title?.slice(0, 50)}"`);
    return data.id;
  }

  /**
   * Build OneNote-compatible HTML page.
   * Uses a single full-width table as the outer container so content fills the page.
   * OneNote ignores most CSS but respects table widths and cell backgrounds.
   */
  _buildPageHtml(conversation, isFlagged) {
    const title = conversation.title || 'Migrated Conversation';
    const date = conversation.created_at
      ? new Date(conversation.created_at).toLocaleString()
      : 'Unknown date';
    const geminiUrl = conversation.geminiUrl;
    const turns = conversation.turns || [];

    const geminiLink = geminiUrl
      ? `<a href="${esc(geminiUrl)}">Open in Gemini</a>`
      : 'Gemini URL unavailable';

    const warningRow = isFlagged ? `
        <tr>
          <td style="background:#fdf0f0;border-left:4px solid #d13438;padding:12px 16px;font-size:14px">
            <b>⚠️ Visual assets detected</b> — images or charts from the original conversation are not included.
            ${geminiUrl ? ` <a href="${esc(geminiUrl)}">View original in Gemini</a>` : ''}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>` : '';

    const turnsHtml = turns.map((turn, i) => {
      const prompt = esc(turn.prompt || '');
      const copilotResponse = esc(turn.copilotResponse || '').replace(/\n/g, '<br/>');
      const geminiResponse = esc(turn.response || '').replace(/\n/g, '<br/>');

      // Render Drive files migrated for this turn
      const driveFiles = turn.driveFiles || [];
      const driveFilesHtml = driveFiles.length > 0 ? `
        <tr>
          <td style="padding:4px 0"><b style="color:#8764b8">📁 Migrated Files from Google Drive</b></td>
        </tr>
        <tr>
          <td style="background:#f4f0fa;border:1px solid #c8b8e8;padding:12px 16px">
            ${driveFiles.map(f => f.oneDriveUrl
              ? `<a href="${esc(f.oneDriveUrl)}" style="color:#8764b8">${esc(f.fileName)}</a>`
              : `<span style="color:#605e5c">${esc(f.fileName)} <i>(upload failed)</i></span>`
            ).join('<br/>')}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>` : '';

      return `
        <tr><td style="border-bottom:2px solid #0078d4;padding:16px 0 4px 0"><b style="font-size:16px;color:#0078d4">Prompt ${i + 1}</b></td></tr>

        <tr>
          <td style="background:#deecf9;padding:12px 16px">
            <b style="color:#0078d4">YOU ASKED</b><br/><br/>
            ${prompt}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>

        <tr>
          <td style="padding:4px 0"><b style="color:#107c10">✦ Copilot Response</b></td>
        </tr>
        <tr>
          <td style="background:#dff6dd;padding:12px 16px">
            ${copilotResponse}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>

        <tr>
          <td style="padding:4px 0"><b style="color:#605e5c">📎 Original Gemini Answer</b></td>
        </tr>
        <tr>
          <td style="background:#f5f5f5;border:1px solid #d2d0ce;padding:12px 16px">
            ${geminiResponse}
            ${geminiUrl ? `<br/><br/><a href="${esc(geminiUrl)}" style="font-size:12px">Open original conversation in Gemini</a>` : ''}
          </td>
        </tr>
        <tr><td style="padding:6px 0">&nbsp;</td></tr>

        ${driveFilesHtml}
        <tr>
          <td style="border:2px dashed #c8c6c4;padding:12px 16px">
            <b>📝 Notes</b><br/><br/>
            <i style="color:#a19f9d">Add your notes here...</i>
          </td>
        </tr>
        <tr><td style="padding:12px 0">&nbsp;</td></tr>`;
    }).join('\n');

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
        📅 <b>Date:</b> ${date} &nbsp;&nbsp;|&nbsp;&nbsp; 💬 <b>Prompts:</b> ${turns.length} &nbsp;&nbsp;|&nbsp;&nbsp; ${geminiLink}
      </td>
    </tr>
    <tr><td style="padding:8px 0">&nbsp;</td></tr>
    ${warningRow}
    ${turnsHtml}
    <tr>
      <td style="border-top:1px solid #e1dfdd;padding:12px 0;font-size:11px;color:#a19f9d">
        Migrated from Gemini by CloudFuze · ${new Date().toISOString().slice(0, 10)}
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
