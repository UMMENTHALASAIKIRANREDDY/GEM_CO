import { getValidToken } from '../../core/auth/microsoft.js';
import { getLogger } from '../../utils/logger.js';

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
  async _getOrCreateSection(targetEmail, sectionNameOverride = null) {
    const cacheKey = `${targetEmail}::${sectionNameOverride || ''}`;
    if (this._sectionIds[cacheKey]) return this._sectionIds[cacheKey];

    const headers = await this._headers();
    const notebookName = this.customerName;
    const sectionBase = sectionNameOverride || `${this.customerName} Conversations`.slice(0, 46);
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

    this._sectionIds[cacheKey] = section.id;
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

    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(
        `${GRAPH_BASE}/users/${targetEmail}/onenote/sections/${sectionId}/pages`,
        {
          method: 'POST',
          headers: { ...await this._headers(), 'Content-Type': 'text/html' },
          body: htmlContent
        }
      );

      if (response.ok) {
        const data = await response.json();
        logger.info(`OneNote page created for ${targetEmail}: "${conversation.title?.slice(0, 50)}"`);
        return data.id;
      }

      const body = await response.text();
      lastError = `OneNote page creation failed for ${targetEmail}: ${response.status} — ${body.slice(0, 300)}`;

      // Retry on transient server errors (5xx), give up immediately on client errors (4xx)
      if (response.status < 500 || attempt === MAX_RETRIES) break;

      const delay = attempt * 2000; // 2s, 4s
      logger.warn(`OneNote page creation transient error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms — "${conversation.title?.slice(0, 50)}"`);
      await new Promise(r => setTimeout(r, delay));
    }

    throw new Error(lastError);
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
  // ── Claude → Copilot page methods ───────────────────────────────────────────

  async createClaudePage(targetEmail, claudeConv) {
    const sectionId = await this._getOrCreateSection(targetEmail);
    const htmlContent = this._buildClaudePageHtml(claudeConv);
    return this._postPage(targetEmail, sectionId, htmlContent);
  }

  async createClaudeMemoryPage(targetEmail, memoryText, userName) {
    const sectionId = await this._getOrCreateSection(targetEmail, 'Claude Memory');
    const htmlContent = this._buildClaudeMemoryHtml(memoryText, userName);
    return this._postPage(targetEmail, sectionId, htmlContent);
  }

  async createClaudeProjectsPage(targetEmail, projects, userName) {
    const sectionId = await this._getOrCreateSection(targetEmail, 'Claude Projects');
    const htmlContent = this._buildClaudeProjectsHtml(projects, userName);
    return this._postPage(targetEmail, sectionId, htmlContent);
  }

  async _postPage(targetEmail, sectionId, htmlContent) {
    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(
        `${GRAPH_BASE}/users/${targetEmail}/onenote/sections/${sectionId}/pages`,
        { method: 'POST', headers: { ...await this._headers(), 'Content-Type': 'text/html' }, body: htmlContent }
      );
      if (response.ok) return (await response.json()).id;
      const body = await response.text();
      lastError = `OneNote page creation failed for ${targetEmail}: ${response.status} — ${body.slice(0, 300)}`;
      if (response.status < 500 || attempt === MAX_RETRIES) break;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
    throw new Error(lastError);
  }

  _buildClaudePageHtml(conv) {
    const title = conv.name?.trim() || 'Untitled Conversation';
    const date = conv.created_at ? new Date(conv.created_at).toLocaleString() : '';
    const messages = conv.chat_messages || [];

    const messagesHtml = messages.map(msg => {
      const isHuman = msg.sender === 'human';
      const text = extractMsgText(msg);
      if (!text) return '';
      const label = isHuman ? 'YOU' : 'CLAUDE';
      const color = isHuman ? '#0078d4' : '#c65c1a';
      const bgColor = isHuman ? '#deecf9' : '#fef3ec';
      const ts = msg.created_at ? `<span style="color:#a19f9d;font-size:11px;margin-left:8px">${new Date(msg.created_at).toLocaleString()}</span>` : '';
      return `
        <tr><td style="border-top:1px solid #edebe9;padding:12px 0 4px 0">
          <b style="color:${color};font-size:13px">[${label}]</b>${ts}
        </td></tr>
        <tr><td style="background:${bgColor};padding:12px 16px;border-left:3px solid ${color}">
          ${esc(text).replace(/\n/g, '<br/>')}
        </td></tr>
        <tr><td style="padding:4px 0">&nbsp;</td></tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><title>${esc(title)}</title><meta name="created" content="${new Date().toISOString()}"/></head>
<body style="font-family:Calibri,sans-serif">
  <h1 style="font-size:22px;color:#0078d4;margin-bottom:4px">${esc(title)}</h1>
  <table border="0" width="100%" cellpadding="0" cellspacing="0" style="width:720px;border-collapse:collapse">
    <tr><td style="background:#f3f2f1;padding:10px 16px;font-size:13px;color:#605e5c">
      📅 <b>Date:</b> ${date} &nbsp;|&nbsp; 💬 <b>Messages:</b> ${messages.length} &nbsp;|&nbsp; 🤖 <b>Source:</b> Claude
    </td></tr>
    <tr><td style="padding:8px 0">&nbsp;</td></tr>
    ${messagesHtml}
    <tr><td style="border-top:1px solid #e1dfdd;padding:10px 0;font-size:11px;color:#a19f9d">
      Migrated from Claude by CloudFuze · ${new Date().toISOString().slice(0, 10)}
    </td></tr>
  </table>
</body></html>`;
  }

  _buildClaudeMemoryHtml(memoryText, userName) {
    return `<!DOCTYPE html>
<html><head><title>Claude Memory</title><meta name="created" content="${new Date().toISOString()}"/></head>
<body style="font-family:Calibri,sans-serif">
  <h1 style="font-size:22px;color:#0078d4;margin-bottom:4px">Claude Memory</h1>
  <table border="0" width="100%" cellpadding="0" cellspacing="0" style="width:720px;border-collapse:collapse">
    <tr><td style="background:#f3f2f1;padding:10px 16px;font-size:13px;color:#605e5c">
      👤 <b>User:</b> ${esc(userName)} &nbsp;|&nbsp; 🤖 <b>Source:</b> Claude Memory
    </td></tr>
    <tr><td style="padding:12px 0">
      <div style="background:#fef3ec;padding:14px 16px;border-left:3px solid #c65c1a;font-size:14px;line-height:1.6">
        ${esc(memoryText).replace(/\n/g, '<br/>')}
      </div>
    </td></tr>
    <tr><td style="border-top:1px solid #e1dfdd;padding:10px 0;font-size:11px;color:#a19f9d">
      Migrated from Claude by CloudFuze · ${new Date().toISOString().slice(0, 10)}
    </td></tr>
  </table>
</body></html>`;
  }

  _buildClaudeProjectsHtml(projects, userName) {
    const projectsHtml = projects.map((p, i) => {
      const docsHtml = (p.docs || []).map(d => `
        <tr><td style="padding:6px 0 2px 0"><b style="color:#1E3A5F;font-size:13px">📄 ${esc(d.filename || '')}</b></td></tr>
        ${d.content ? `<tr><td style="background:#f8f8f8;padding:10px 14px;font-size:13px;line-height:1.5">${esc(d.content).replace(/\n/g,'<br/>')}</td></tr>` : ''}
      `).join('');
      return `
        <tr><td style="border-top:${i > 0 ? '2px solid #edebe9' : 'none'};padding:${i > 0 ? '16px' : '0'} 0 4px 0">
          <b style="font-size:16px;color:#0078d4">📁 ${esc(p.name || `Project ${i + 1}`)}</b>
          ${p.description ? `<br/><span style="font-size:12px;color:#605e5c">${esc(p.description)}</span>` : ''}
        </td></tr>
        ${docsHtml}`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><title>Claude Projects</title><meta name="created" content="${new Date().toISOString()}"/></head>
<body style="font-family:Calibri,sans-serif">
  <h1 style="font-size:22px;color:#0078d4;margin-bottom:4px">Claude Projects</h1>
  <table border="0" width="100%" cellpadding="0" cellspacing="0" style="width:720px;border-collapse:collapse">
    <tr><td style="background:#f3f2f1;padding:10px 16px;font-size:13px;color:#605e5c">
      👤 <b>User:</b> ${esc(userName)} &nbsp;|&nbsp; 📁 <b>Projects:</b> ${projects.length}
    </td></tr>
    <tr><td style="padding:8px 0">&nbsp;</td></tr>
    ${projectsHtml}
    <tr><td style="border-top:1px solid #e1dfdd;padding:10px 0;font-size:11px;color:#a19f9d">
      Migrated from Claude by CloudFuze · ${new Date().toISOString().slice(0, 10)}
    </td></tr>
  </table>
</body></html>`;
  }
}

function extractMsgText(msg) {
  if (msg.text && msg.text.trim()) return msg.text.trim();
  if (Array.isArray(msg.content)) return msg.content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n').trim();
  return '';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
