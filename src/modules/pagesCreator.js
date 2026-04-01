import { getDelegatedToken } from '../auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:pagesCreator');
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Module 4 — Pages Creator.
 * Creates one HTML page per Gemini conversation in each user's OneDrive.
 * Uses delegated admin token (Files.ReadWrite.All) to write to any user's OneDrive.
 * Folder structure: OneDrive / {customerName} / {conversation title}.html
 */
export class PagesCreator {
  constructor(tenantId, customerName = 'Gemini') {
    this.tenantId = tenantId;
    this.customerName = customerName;
  }

  _headers() {
    return { 'Authorization': `Bearer ${getDelegatedToken()}` };
  }

  /**
   * Create a single page for one Gemini conversation.
   * Uploads HTML file to the mapped user's OneDrive under /{customerName}/ folder.
   */
  async createPage(email, conversation, flaggedAssets = []) {
    const flaggedIds = new Set(flaggedAssets.map(f => f.conversation_id));
    const isFlagged = flaggedIds.has(conversation.id);

    const pageTitle = (conversation.title || 'Migrated Conversation')
      .replace(/[<>:"/\\|?*]/g, '_')
      .slice(0, 100);
    const htmlContent = this._buildPageHtml(conversation, isFlagged);

    // Upload HTML to user's OneDrive: /{customerName}/{pageTitle}.html
    const url = `${GRAPH_BASE}/users/${email}/drive/root:/${this.customerName}/${pageTitle}.html:/content`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...this._headers(), 'Content-Type': 'text/html' },
      body: htmlContent
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Graph API ${response.status} for ${email}: ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    logger.info(`Page created for ${email}: "${pageTitle}" → OneDrive/${this.customerName}/`);
    return data.id;
  }

  /**
   * Build HTML page per the PRD page structure (Section 7).
   */
  _buildPageHtml(conversation, isFlagged) {
    const title = conversation.title || 'Migrated Conversation';
    const date = conversation.created_at
      ? new Date(conversation.created_at).toLocaleString()
      : 'Unknown date';
    const geminiUrl = conversation.geminiUrl;
    const turns = conversation.turns || [];

    const geminiLink = geminiUrl
      ? `<a href="${esc(geminiUrl)}" style="color:#0078d4;text-decoration:none">Open in Gemini ↗</a>`
      : '<span style="color:#a19f9d">Gemini URL unavailable</span>';

    const warningBanner = isFlagged ? `
      <div style="background:#fdf0f0;border-left:4px solid #d13438;padding:12px 16px;margin:0 0 20px;border-radius:6px;font-size:14px">
        ⚠️ <strong>Visual assets detected</strong> — this conversation may contain images or charts not included here.
        ${geminiUrl ? ` <a href="${esc(geminiUrl)}" style="color:#d13438">View original in Gemini ↗</a>` : ''}
      </div>` : '';

    const turnsHtml = turns.map((turn, i) => {
      const prompt = esc(turn.prompt || '');
      const copilotResponse = esc(turn.copilotResponse || '').replace(/\n/g, '<br>');
      const geminiResponse = esc(turn.response || '').replace(/\n/g, '<br>');

      return `
      <div style="margin:24px 0">
        <div style="border-top:1px solid #e1dfdd;margin-bottom:20px"></div>
        <h2 style="color:#0078d4;font-size:16px;margin:0 0 12px">Prompt ${i + 1}</h2>

        <div style="background:#eff6fc;border-left:4px solid #0078d4;padding:14px 18px;border-radius:6px;margin-bottom:16px;font-size:14px;line-height:1.6">
          <strong style="color:#0078d4;font-size:12px;text-transform:uppercase;letter-spacing:.5px">You asked</strong><br>
          <span style="color:#201f1e">${prompt}</span>
        </div>

        <h3 style="color:#107c10;font-size:14px;margin:0 0 8px">✦ Copilot Response</h3>
        <div style="background:#f0f8f0;border-left:4px solid #107c10;padding:14px 18px;border-radius:6px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#201f1e">
          ${copilotResponse}
        </div>

        <h3 style="color:#605e5c;font-size:13px;margin:12px 0 6px">📎 Original Gemini Answer</h3>
        <div style="background:#faf9f8;border:1px solid #e1dfdd;padding:14px 18px;border-radius:6px;margin-bottom:16px;font-size:14px;line-height:1.6;color:#323130">
          ${geminiResponse}
          ${geminiUrl ? `<div style="margin-top:12px"><a href="${esc(geminiUrl)}" style="color:#0078d4;font-size:12px">Open original Gemini conversation ↗</a></div>` : ''}
        </div>

        <div style="border:1px dashed #c8c6c4;padding:14px 18px;border-radius:6px;min-height:40px">
          <span style="color:#605e5c;font-size:13px;font-weight:600">📝 Your Notes</span><br>
          <span style="color:#a19f9d;font-style:italic;font-size:13px">Add your notes here...</span>
        </div>
      </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body { font-family: 'Segoe UI', system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 32px 24px; background: #fff; color: #201f1e; }
    a { color: #0078d4; }
  </style>
</head>
<body>
  <h1 style="color:#0078d4;font-size:22px;border-bottom:2px solid #0078d4;padding-bottom:10px;margin-bottom:16px">${esc(title)}</h1>

  <div style="background:#f3f2f1;padding:12px 18px;border-radius:6px;margin-bottom:20px;font-size:13px;color:#605e5c;display:flex;gap:16px;flex-wrap:wrap;align-items:center">
    <span>📅 <strong>Original date:</strong> ${date}</span>
    <span>💬 <strong>Prompts:</strong> ${turns.length}</span>
    <span>${geminiLink}</span>
  </div>

  ${warningBanner}
  ${turnsHtml}

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e1dfdd;font-size:11px;color:#a19f9d">
    Migrated from Gemini by CloudFuze · ${new Date().toISOString().slice(0, 10)}
  </div>
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
