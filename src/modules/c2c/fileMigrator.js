/**
 * C2C — Copilot attachment download + reupload pipeline.
 *
 * Ported from src/modules/c2g/migration/migrate.js (the C2G implementation).
 * Same source-side shape (Microsoft Graph getAllEnterpriseInteractions returns
 * the same interaction.attachments / contexts / links structure), so the
 * extraction logic is reused. The difference is the destination — C2G uploads
 * to Google Drive, C2C uploads to Microsoft OneDrive via Files.ReadWrite.All
 * (Application).
 *
 * Public API:
 *   - extractAttachments(interaction)   → AttachmentRef[]
 *   - downloadBinary(url, token)        → { buffer, contentType } | null
 *   - guessExtension(contentType, url), guessMime(ext)
 *
 * AttachmentRef shape: { type, url, name, contentType, ... }
 */

import { getLogger } from '../../utils/logger.js';

const logger = getLogger('c2c:files');
const FETCH_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert a SharePoint / OneDrive URL to a Microsoft Graph "shares" download
 * URL. Graph's /shares/u!{base64}/driveItem/content endpoint accepts any
 * SharePoint URL after base64-encoding, making it downloadable with an
 * app-only token. Also unwraps asyncgw.teams.microsoft.com URLs that wrap a
 * real SharePoint URL in their query params.
 */
export function convertToGraphDownloadUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('asyncgw.teams.microsoft.com') ||
        u.hostname.includes('teams.cdn.office.net')) {
      const embedded = u.searchParams.get('url') || u.searchParams.get('originalUrl');
      if (embedded) {
        return convertToGraphDownloadUrl(decodeURIComponent(embedded));
      }
      return null;
    }
    if (u.hostname.includes('sharepoint.com')) {
      const encoded = Buffer.from(url).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem/content`;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Download a file by URL. Uses the supplied bearer token if the URL points at
 * Microsoft's CDN. Falls back to the Graph "shares" endpoint if direct download
 * fails (handles SharePoint URLs that aren't directly fetchable).
 *
 * Returns null on any failure — caller should skip the file and continue.
 */
export async function downloadBinary(url, accessToken) {
  if (!url) return null;
  const headers = { Accept: '*/*' };
  const needsAuth = url.includes('graph.microsoft.com') ||
    url.includes('sharepoint.com') ||
    url.includes('onedrive.com') ||
    url.includes('microsoft.com');
  if (accessToken && needsAuth) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  try {
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
      // Retry via Graph shares endpoint for SharePoint URLs
      if (needsAuth && accessToken) {
        const graphUrl = convertToGraphDownloadUrl(url);
        if (graphUrl && graphUrl !== url) {
          try {
            const retry = await fetchWithTimeout(graphUrl, {
              headers: { Accept: '*/*', Authorization: `Bearer ${accessToken}` },
            });
            if (retry.ok) {
              const buf = Buffer.from(await retry.arrayBuffer());
              if (buf.length > 0) {
                return {
                  buffer: buf,
                  contentType: retry.headers.get('content-type') || '',
                };
              }
            }
          } catch { /* timeout or network error on retry */ }
        }
      }
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return {
      buffer: buf,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (e) {
    // Silence placeholder URLs (file:///unknown-url, file:///null, empty etc.)
    // — those aren't real download attempts. Copilot conversations sometimes
    // reference attachments without resolvable URLs; logging every failure
    // is noise. Real http(s):// failures still surface.
    if (url && !url.startsWith('file:///')) {
      logger.warn(`downloadBinary(${url.slice(0, 60)}…) failed: ${e.message}`);
    }
    return null;
  }
}

export function guessExtension(contentType, url) {
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('svg')) return '.svg';
  if (contentType?.includes('pdf')) return '.pdf';
  if (contentType?.includes('word') || contentType?.includes('docx') || contentType?.includes('wordprocessingml')) return '.docx';
  if (contentType?.includes('excel') || contentType?.includes('xlsx') || contentType?.includes('spreadsheetml')) return '.xlsx';
  if (contentType?.includes('powerpoint') || contentType?.includes('pptx') || contentType?.includes('presentationml')) return '.pptx';
  const urlExt = (url || '').split('?')[0].match(/\.(\w{2,5})$/);
  if (urlExt) return '.' + urlExt[1].toLowerCase();
  return '.bin';
}

export function guessMime(ext) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Extract all file/image references from one interaction. Handles:
 *   - Direct attachments with contentUrl
 *   - Adaptive Card attachments — walks the card body for file URLs
 *   - Teams file download/staticviewer/consent cards
 *   - Reference attachments (SharePoint/OneDrive links from user uploads)
 *   - asyncgw.teams.microsoft.com URLs — replaces with Graph URL from content
 *   - contexts[] (files Copilot accessed during the conversation)
 *   - links[] (file links the AI returned)
 *   - <img src=…> tags in HTML body
 *
 * Returns deduplicated [{ type, url, name, contentType, ... }].
 */
/**
 * Walk an arbitrary object/string tree collecting every `data:image/...;base64,`
 * URL found. User-uploaded screenshots in Copilot chat are stored inline as
 * data URLs (not in OneDrive), so we have to extract them from the response
 * itself. Returns [{ url, mime, ext }] de-duplicated by the data URL string.
 */
function _collectInlineDataUrls(node, out, seen) {
  if (!node) return;
  if (typeof node === 'string') {
    // Find all data:image/...;base64,... substrings. There may be multiple per
    // string (e.g. an HTML body with several <img> tags).
    const re = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;
    let m;
    while ((m = re.exec(node)) !== null) {
      const mime = m[1].toLowerCase();
      const url = m[0]; // full data URL (used as a unique key)
      if (seen.has(url)) continue;
      seen.add(url);
      const ext = mime === 'image/jpeg' ? '.jpg'
                : mime === 'image/png'  ? '.png'
                : mime === 'image/gif'  ? '.gif'
                : mime === 'image/webp' ? '.webp'
                : mime === 'image/svg+xml' ? '.svg'
                : '.bin';
      out.push({ url, mime, ext });
    }
    return;
  }
  if (Array.isArray(node)) { for (const x of node) _collectInlineDataUrls(x, out, seen); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) _collectInlineDataUrls(node[k], out, seen);
  }
}

export function extractAttachments(interaction) {
  const attachments = [];
  const seen = new Set();

  // 0. Inline data:image/... URLs — user-uploaded screenshots that Microsoft
  // embeds directly in the chat content rather than persisting to OneDrive.
  // No download needed; the bytes are already in the response.
  const dataUrls = [];
  _collectInlineDataUrls(interaction, dataUrls, new Set());
  let inlineIdx = 0;
  for (const d of dataUrls) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    inlineIdx++;
    attachments.push({
      type: 'image',
      url: d.url,
      name: `inline_image_${inlineIdx}${d.ext}`,
      contentType: d.mime,
    });
  }

  const rawAtts = interaction.attachments || [];
  const rawCtxs = interaction.contexts || [];
  const rawLinks = interaction.links || [];

  for (const att of rawAtts) {
    const ct = att.contentType || '';

    // 1. Adaptive cards — walk for file URLs
    if (ct === 'application/vnd.microsoft.card.adaptive') {
      if (att.content) {
        try {
          const card = typeof att.content === 'string' ? JSON.parse(att.content) : att.content;
          const fileUrls = [];

          function extractMarkdownLinks(text) {
            const mdRegex = /\[([^\]]*)\]\((https?:[^)]+)\)/g;
            let m;
            while ((m = mdRegex.exec(text)) !== null) {
              const label = m[1].trim();
              const url = m[2];
              const isFileLike = url.includes('sharepoint.com') ||
                url.includes('graph.microsoft.com') ||
                url.includes('asyncgw.teams.microsoft.com') ||
                /\.(xlsx|docx|pptx|pdf|csv|txt|zip|py|json|png|jpg|jpeg|gif)(\?|$)/i.test(url);
              if (!isFileLike) continue;
              const urlFileName = url.split('/').pop()?.split('?')[0] || '';
              const name = /^\d+$/.test(label)
                ? (urlFileName && urlFileName.includes('.') ? urlFileName : att.name || 'file')
                : (label || att.name || 'file');
              fileUrls.push({ url, name });
            }
          }
          function walkCard(el) {
            if (!el || typeof el !== 'object') return;
            if (el.type === 'Action.OpenUrl' && el.url) fileUrls.push({ url: el.url, name: el.title || att.name || 'attachment' });
            if (el.type === 'Image' && el.url) fileUrls.push({ url: el.url, name: att.name || 'image' });
            if (el.downloadUrl) fileUrls.push({ url: el.downloadUrl, name: el.name || att.name || 'attachment' });
            if (el['@microsoft.graph.downloadUrl']) fileUrls.push({ url: el['@microsoft.graph.downloadUrl'], name: el.name || att.name || 'attachment' });
            if (el.webUrl && (el.webUrl.includes('sharepoint.com') || el.webUrl.includes('onedrive'))) fileUrls.push({ url: el.webUrl, name: el.name || att.name || 'attachment' });
            if ((el.type === 'TextBlock' || el.type === 'TextRun') && el.text) extractMarkdownLinks(el.text);
            for (const key of ['body', 'actions', 'items', 'columns', 'facts', 'inlines']) {
              if (Array.isArray(el[key])) el[key].forEach(walkCard);
            }
            if (el.column) walkCard(el.column);
          }
          walkCard(card);
          for (const { url, name } of fileUrls) {
            if (url && !seen.has(url)) {
              seen.add(url);
              const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(url);
              attachments.push({ type: isImage ? 'image' : 'file', url, name, contentType: '' });
            }
          }
          const topUrl = card.downloadUrl || card['@microsoft.graph.downloadUrl'];
          if (topUrl && !seen.has(topUrl)) {
            seen.add(topUrl);
            attachments.push({ type: 'file', url: topUrl, name: att.name || 'attachment', contentType: '' });
          }
        } catch { /* malformed card */ }
      }
      continue;
    }

    // 2. Teams file cards
    if (ct === 'application/vnd.microsoft.teams.file.download.info' ||
        ct === 'application/vnd.microsoft.teams.file.staticviewer' ||
        ct === 'application/vnd.microsoft.teams.card.file.consent') {
      if (att.content) {
        try {
          const ref = typeof att.content === 'string' ? JSON.parse(att.content) : att.content;
          const dlUrl = ref.downloadUrl || ref['@microsoft.graph.downloadUrl'] || ref.acceptContext?.uploadInfo?.contentUrl;
          const name = att.name || ref.fileName || ref.name || 'file';
          if (dlUrl && !seen.has(dlUrl)) {
            seen.add(dlUrl);
            attachments.push({ type: 'file', url: dlUrl, name, contentType: ref.fileType ? `application/${ref.fileType}` : '' });
          }
        } catch { /* ignore */ }
      }
      if (att.contentUrl && !seen.has(att.contentUrl)) {
        seen.add(att.contentUrl);
        attachments.push({ type: 'file', url: att.contentUrl, name: att.name || 'file', contentType: '' });
      }
      continue;
    }

    // 3. Reference attachments
    if (ct === 'reference' || ct === 'application/vnd.microsoft.teams.file.reference') {
      const url = att.contentUrl || '';
      const name = att.name || 'file';
      if (url && !seen.has(url)) {
        seen.add(url);
        attachments.push({ type: 'file', url, name, contentType: '' });
      }
      continue;
    }

    // 4. Generic — parse att.content for a Graph/SharePoint URL,
    //    handle asyncgw → Graph URL replacement.
    let graphUrlFromContent = null;
    if (att.content) {
      try {
        const ref = typeof att.content === 'string' ? JSON.parse(att.content) : att.content;
        const candidate = ref.downloadUrl || ref['@microsoft.graph.downloadUrl'] || ref.webUrl;
        if (candidate && (candidate.includes('graph.microsoft.com') || candidate.includes('sharepoint.com'))) {
          graphUrlFromContent = candidate;
        }
      } catch { /* not JSON */ }
    }

    if (att.contentUrl && !seen.has(att.contentUrl)) {
      const isAsyncGw = att.contentUrl.includes('asyncgw.teams.microsoft.com') ||
        att.contentUrl.includes('statics.teams.cdn.office.net');
      const effectiveUrl = (isAsyncGw && graphUrlFromContent) ? graphUrlFromContent : att.contentUrl;
      seen.add(effectiveUrl);
      seen.add(att.contentUrl);
      const isImage = ct.startsWith('image/') ||
        /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(effectiveUrl);
      attachments.push({
        type: isImage ? 'image' : 'file',
        url: effectiveUrl,
        name: att.name || att.id || '',
        contentType: ct,
      });
    }

    if (!att.contentUrl && graphUrlFromContent && !seen.has(graphUrlFromContent)) {
      seen.add(graphUrlFromContent);
      try {
        const ref = typeof att.content === 'string' ? JSON.parse(att.content) : att.content;
        attachments.push({
          type: 'file',
          url: graphUrlFromContent,
          name: ref.name || att.name || 'attachment',
          contentType: ref.file?.mimeType || ct || '',
        });
      } catch { /* ignore */ }
    }

    if (att.thumbnailUrl && !seen.has(att.thumbnailUrl)) {
      seen.add(att.thumbnailUrl);
      attachments.push({ type: 'image', url: att.thumbnailUrl, name: att.name || 'thumbnail', contentType: 'image/png' });
    }
  }

  // 5. contexts[] — files Copilot accessed during the conversation
  for (const ctx of rawCtxs) {
    const ctxRef = ctx.contextReference;
    if (!ctxRef) continue;
    const url = ctxRef['@odata.id'] || ctxRef.webUrl || ctxRef.url || '';
    const name = ctx.displayName || ctxRef.name || '';
    if (url && !seen.has(url)) {
      seen.add(url);
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(url) ||
                      /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(name);
      attachments.push({
        type: isImage ? 'image' : 'file',
        url,
        name: name || url.split('/').pop()?.split('?')[0] || 'context-file',
        contentType: '',
      });
    }
  }

  // 6. links[]
  for (const link of rawLinks) {
    const linkUrl = link.linkUrl || link.url || '';
    if (!linkUrl) continue;
    const isFile = linkUrl.includes('sharepoint.com') ||
      linkUrl.includes('graph.microsoft.com') ||
      /\.(pdf|docx|xlsx|pptx|csv|txt|zip|py|json)(\?|$)/i.test(linkUrl);
    if (linkUrl && !seen.has(linkUrl) && isFile) {
      seen.add(linkUrl);
      attachments.push({
        type: 'file',
        url: linkUrl,
        name: link.displayName || linkUrl.split('/').pop()?.split('?')[0] || 'linked-file',
        contentType: '',
      });
    }
  }

  return attachments;
}
