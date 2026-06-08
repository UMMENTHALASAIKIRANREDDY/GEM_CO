/**
 * Migration runner: for each user pair, fetch Copilot interactions,
 * generate per-conversation DOCX files, download attached images/files,
 * and upload everything to the destination user's Google Drive.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  ExternalHyperlink,
  PageBreak,
} from "docx";
import {
  getServiceAccountAuth,
  createDriveFolder,
  uploadFileToDrive,
} from "../googleService.js";
import { getCopilotInteractionsForUser } from "../copilotService.js";
import { createSourceGraphClient } from "../copilotService.js";
import {
  regenerateFilesFromInteraction,
  pickRegeneratedFileByName,
  cleanupRegen,
} from "../../c2c/codeRegenerator.js";
import fs from "fs";

// ── Download a binary file from a URL (Graph or public) ──────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadBinary(url, accessToken) {
  const headers = { Accept: "*/*" };
  const needsAuth = url.includes("graph.microsoft.com") ||
    url.includes("sharepoint.com") ||
    url.includes("onedrive.com") ||
    url.includes("microsoft.com");
  if (accessToken && needsAuth) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  try {
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
      if (needsAuth && accessToken) {
        const graphUrl = convertToGraphDownloadUrl(url);
        if (graphUrl && graphUrl !== url) {
          try {
            const retry = await fetchWithTimeout(graphUrl, { headers: { Accept: "*/*", Authorization: `Bearer ${accessToken}` } });
            if (retry.ok) {
              const buf = Buffer.from(await retry.arrayBuffer());
              if (buf.length > 0) return { buffer: buf, contentType: retry.headers.get("content-type") || "", disposition: retry.headers.get("content-disposition") || "" };
            }
          } catch { /* timeout or network error on retry */ }
        }
      }
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return { buffer: buf, contentType: res.headers.get("content-type") || "", disposition: res.headers.get("content-disposition") || "" };
  } catch {
    return null;
  }
}

function convertToGraphDownloadUrl(url) {
  try {
    const u = new URL(url);
    // asyncgw URLs wrap a SharePoint URL in their query params — extract it
    if (u.hostname.includes("asyncgw.teams.microsoft.com") || u.hostname.includes("teams.cdn.office.net")) {
      const embedded = u.searchParams.get("url") || u.searchParams.get("originalUrl");
      if (embedded) {
        console.log(`[Migration] Unwrapping asyncgw URL → ${embedded.slice(0, 80)}`);
        return convertToGraphDownloadUrl(decodeURIComponent(embedded));
      }
      return null;
    }
    if (u.hostname.includes("sharepoint.com")) {
      const encoded = Buffer.from(url).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem/content`;
    }
  } catch { /* ignore */ }
  return null;
}

function guessExtension(contentType, url) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("svg")) return ".svg";
  if (contentType?.includes("pdf")) return ".pdf";
  if (contentType?.includes("word") || contentType?.includes("docx") || contentType?.includes("wordprocessingml")) return ".docx";
  if (contentType?.includes("excel") || contentType?.includes("xlsx") || contentType?.includes("spreadsheetml")) return ".xlsx";
  if (contentType?.includes("powerpoint") || contentType?.includes("pptx") || contentType?.includes("presentationml")) return ".pptx";
  const urlExt = (url || "").split("?")[0].match(/\.(\w{2,5})$/);
  if (urlExt) return "." + urlExt[1].toLowerCase();
  return ".bin";
}

function guessMime(ext) {
  const map = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] || "application/octet-stream";
}

// ── Extract attachments from an interaction ───────────────────────────

function extractAttachments(interaction) {
  const attachments = [];
  const seen = new Set();

  const rawAtts = interaction.attachments || [];
  const rawCtxs = interaction.contexts || [];
  const rawLinks = interaction.links || [];
  if (rawAtts.length || rawCtxs.length || rawLinks.length) {
    console.log(`[Migration] Interaction ${interaction.id?.slice(-8)}: ${rawAtts.length} attachments, ${rawCtxs.length} contexts, ${rawLinks.length} links`);
    rawAtts.forEach(a => console.log(`[Migration]   att: name="${a.name}" contentType="${a.contentType}" hasContentUrl=${!!a.contentUrl} hasContent=${!!a.content}`));
  }

  for (const att of rawAtts) {
    const ct = att.contentType || "";

    // Adaptive cards: extract file references from the card body instead of skipping
    // OneDrive file uploads to Copilot are returned as adaptive cards containing the download URL
    if (ct === "application/vnd.microsoft.card.adaptive") {
      if (att.content) {
        try {
          const card = typeof att.content === "string" ? JSON.parse(att.content) : att.content;
          // Walk the card body for Action.OpenUrl, Image sources, and TextBlock with URLs
          const fileUrls = [];
          function extractMarkdownLinks(text) {
            const mdRegex = /\[([^\]]*)\]\((https?:[^)]+)\)/g;
            let m;
            while ((m = mdRegex.exec(text)) !== null) {
              const label = m[1].trim();
              const url = m[2];
              // Only include file-like URLs: SharePoint, Graph, asyncgw, or known file extensions.
              // Numeric labels (e.g. [1]) that point to SharePoint are valid file citations — keep them.
              // Numeric labels pointing to web search results (bing.com, etc.) will fail the isFileLike check.
              const isFileLike = url.includes("sharepoint.com") ||
                url.includes("graph.microsoft.com") ||
                url.includes("asyncgw.teams.microsoft.com") ||
                /\.(xlsx|docx|pptx|pdf|csv|txt|zip|py|json|png|jpg|jpeg|gif)(\?|$)/i.test(url);
              if (!isFileLike) continue;
              // Use the label as name; for numeric-only labels fall back to the filename from URL
              const urlFileName = url.split("/").pop()?.split("?")[0] || "";
              const name = /^\d+$/.test(label)
                ? (urlFileName && urlFileName.includes(".") ? urlFileName : att.name || "file")
                : (label || att.name || "file");
              fileUrls.push({ url, name });
            }
            // Bare SharePoint/Graph URLs with a clear file extension only
            const bareRegex = /https?:\/\/[^\s\])"]+/g;
            while ((m = bareRegex.exec(text)) !== null) {
              const u = m[0].replace(/[.,;!?]+$/, "");
              const isFileLike = (u.includes("sharepoint.com") || u.includes("graph.microsoft.com") ||
                u.includes("asyncgw.teams.microsoft.com")) &&
                /\.(xlsx|docx|pptx|pdf|csv|txt|zip|py|json|png|jpg)(\?|$)/i.test(u);
              if (isFileLike) fileUrls.push({ url: u, name: att.name || "file" });
            }
          }
          function walkCard(el) {
            if (!el || typeof el !== "object") return;
            if (el.type === "Action.OpenUrl" && el.url) fileUrls.push({ url: el.url, name: el.title || att.name || "attachment" });
            if (el.type === "Image" && el.url) fileUrls.push({ url: el.url, name: att.name || "image" });
            if (el.downloadUrl) fileUrls.push({ url: el.downloadUrl, name: el.name || att.name || "attachment" });
            if (el["@microsoft.graph.downloadUrl"]) fileUrls.push({ url: el["@microsoft.graph.downloadUrl"], name: el.name || att.name || "attachment" });
            if (el.webUrl && (el.webUrl.includes("sharepoint.com") || el.webUrl.includes("onedrive"))) fileUrls.push({ url: el.webUrl, name: el.name || att.name || "attachment" });
            // Extract markdown download links embedded in TextBlock text
            if ((el.type === "TextBlock" || el.type === "TextRun") && el.text) extractMarkdownLinks(el.text);
            for (const key of ["body", "actions", "items", "columns", "facts", "inlines"]) {
              if (Array.isArray(el[key])) el[key].forEach(walkCard);
            }
            if (el.column) walkCard(el.column);
          }
          walkCard(card);
          for (const { url, name } of fileUrls) {
            if (url && !seen.has(url)) {
              seen.add(url);
              const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(url);
              console.log(`[Migration] Adaptive card file extracted: "${name}" → ${url.slice(0, 80)}`);
              attachments.push({ type: isImage ? "image" : "file", url, name, contentType: "" });
            }
          }
          // Also check top-level downloadUrl / file reference on the card itself
          const topUrl = card.downloadUrl || card["@microsoft.graph.downloadUrl"];
          if (topUrl && !seen.has(topUrl)) {
            seen.add(topUrl);
            console.log(`[Migration] Adaptive card top-level download: "${att.name}" → ${topUrl.slice(0, 80)}`);
            attachments.push({ type: "file", url: topUrl, name: att.name || "attachment", contentType: "" });
          }
          if (fileUrls.length === 0 && !topUrl) {
            console.log(`[Migration] Adaptive card skipped (no file URLs found): name="${att.name}" content=${JSON.stringify(card).slice(0, 200)}`);
          }
        } catch { /* malformed card */ }
      }
      continue;
    }

    // Teams file download info / static viewer
    if (ct === "application/vnd.microsoft.teams.file.download.info" ||
        ct === "application/vnd.microsoft.teams.file.staticviewer" ||
        ct === "application/vnd.microsoft.teams.card.file.consent") {
      if (att.content) {
        try {
          const ref = typeof att.content === "string" ? JSON.parse(att.content) : att.content;
          const dlUrl = ref.downloadUrl || ref["@microsoft.graph.downloadUrl"] || ref.acceptContext?.uploadInfo?.contentUrl;
          const name = att.name || ref.fileName || ref.name || "file";
          if (dlUrl && !seen.has(dlUrl)) {
            seen.add(dlUrl);
            console.log(`[Migration] Teams file card: "${name}" → ${dlUrl.slice(0, 80)}`);
            attachments.push({ type: "file", url: dlUrl, name, contentType: ref.fileType ? `application/${ref.fileType}` : "" });
          }
        } catch { /* ignore */ }
      }
      // Also handle contentUrl on the attachment itself for consent cards
      if (att.contentUrl && !seen.has(att.contentUrl)) {
        seen.add(att.contentUrl);
        attachments.push({ type: "file", url: att.contentUrl, name: att.name || "file", contentType: "" });
      }
      continue;
    }

    // Reference attachments — direct SharePoint/OneDrive file links (user uploads from OneDrive)
    if (ct === "reference" || ct === "application/vnd.microsoft.teams.file.reference") {
      const url = att.contentUrl || "";
      const name = att.name || "file";
      if (url && !seen.has(url)) {
        seen.add(url);
        console.log(`[Migration] Reference attachment: "${name}" → ${url.slice(0, 80)}`);
        attachments.push({ type: "file", url, name, contentType: "" });
      }
      continue;
    }

    // Always parse att.content for a Graph/OneDrive URL — even when contentUrl exists,
    // asyncgw.teams.microsoft.com URLs require delegated tokens and often can't be
    // downloaded with app-only credentials. The Graph URL from content is preferable.
    let graphUrlFromContent = null;
    if (att.content) {
      try {
        const ref = typeof att.content === "string" ? JSON.parse(att.content) : att.content;
        const candidate = ref.downloadUrl || ref["@microsoft.graph.downloadUrl"] || ref.webUrl;
        if (candidate && (candidate.includes("graph.microsoft.com") || candidate.includes("sharepoint.com"))) {
          graphUrlFromContent = candidate;
        }
      } catch { /* not JSON */ }
    }

    if (att.contentUrl && !seen.has(att.contentUrl)) {
      const isAsyncGw = att.contentUrl.includes("asyncgw.teams.microsoft.com") ||
        att.contentUrl.includes("statics.teams.cdn.office.net");
      // Prefer Graph URL over asyncgw — asyncgw requires delegated tokens
      const effectiveUrl = (isAsyncGw && graphUrlFromContent) ? graphUrlFromContent : att.contentUrl;
      if (isAsyncGw && graphUrlFromContent) {
        console.log(`[Migration] Replaced asyncgw URL with Graph URL for "${att.name}"`);
      } else if (isAsyncGw) {
        console.log(`[Migration] asyncgw attachment "${att.name}" — no Graph URL in content, will try delegated token`);
      }
      seen.add(effectiveUrl);
      seen.add(att.contentUrl);
      const isImage = ct.startsWith("image/") ||
        /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(effectiveUrl);
      attachments.push({
        type: isImage ? "image" : "file",
        url: effectiveUrl,
        name: att.name || att.id || "",
        contentType: ct,
        isAsyncGw: isAsyncGw && !graphUrlFromContent,
        asyncGwUrl: isAsyncGw ? att.contentUrl : undefined,
      });
    }

    if (!att.contentUrl && graphUrlFromContent && !seen.has(graphUrlFromContent)) {
      seen.add(graphUrlFromContent);
      try {
        const ref = typeof att.content === "string" ? JSON.parse(att.content) : att.content;
        attachments.push({
          type: "file",
          url: graphUrlFromContent,
          name: ref.name || att.name || "attachment",
          contentType: ref.file?.mimeType || ct || "",
        });
      } catch { /* ignore */ }
    } else if (!att.contentUrl && att.content && !graphUrlFromContent) {
      try {
        const ref = typeof att.content === "string" ? JSON.parse(att.content) : att.content;
        const downloadUrl = ref.downloadUrl || ref["@microsoft.graph.downloadUrl"] || ref.webUrl;
        if (downloadUrl && !seen.has(downloadUrl)) {
          seen.add(downloadUrl);
          attachments.push({
            type: "file",
            url: downloadUrl,
            name: ref.name || att.name || "attachment",
            contentType: ref.file?.mimeType || ct || "",
          });
        }
      } catch { /* not a JSON reference */ }
    }

    if (att.thumbnailUrl && !seen.has(att.thumbnailUrl)) {
      seen.add(att.thumbnailUrl);
      attachments.push({ type: "image", url: att.thumbnailUrl, name: att.name || "thumbnail", contentType: "image/png" });
    }

    // Attachments with only attachmentId + name but no URL — try to find in body
    if (!att.contentUrl && !att.thumbnailUrl && att.name && att.attachmentId) {
      const key = `ref:${att.attachmentId}`;
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push({
          type: "file",
          url: "",
          name: att.name,
          contentType: ct,
          attachmentId: att.attachmentId,
          needsContextLookup: true,
        });
      }
    }
  }

  // contexts[] — files Copilot accessed (OneDrive/SharePoint docs, uploaded files)
  for (const ctx of interaction.contexts || []) {
    const ctxRef = ctx.contextReference;
    if (!ctxRef) continue;
    console.log(`[Migration] Context found: "${ctx.displayName || ctxRef.name}" id=${ctxRef.id || ctxRef.driveItemId} @odata.id=${ctxRef["@odata.id"] || ""} webUrl=${ctxRef.webUrl || ""}`);

    const url = ctxRef["@odata.id"] || ctxRef.webUrl || ctxRef.url || "";
    const name = ctx.displayName || ctxRef.name || "";

    if (url && !seen.has(url)) {
      seen.add(url);
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(url) || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(name);
      attachments.push({
        type: isImage ? "image" : "file",
        url,
        name: name || url.split("/").pop()?.split("?")[0] || "context-file",
        contentType: "",
      });
    } else if (name && !url) {
      const driveItemId = ctxRef.id || ctxRef.driveItemId;
      if (driveItemId && !seen.has(driveItemId)) {
        seen.add(driveItemId);
        attachments.push({
          type: "file",
          url: "",
          name,
          contentType: "",
          driveItemId,
          needsDriveDownload: true,
        });
      }
    }
  }

  // links[] array
  for (const link of rawLinks) {
    const linkUrl = link.linkUrl || link.url || "";
    if (!linkUrl) continue;
    const isFile = linkUrl.includes("sharepoint.com") ||
      linkUrl.includes("graph.microsoft.com") ||
      /\.(pdf|docx|xlsx|pptx|csv|txt|zip|py|json)(\?|$)/i.test(linkUrl);
    console.log(`[Migration] Link: type=${link.linkType || "?"} file=${isFile} url=${linkUrl.slice(0, 100)}`);
    if (linkUrl && !seen.has(linkUrl) && isFile) {
      seen.add(linkUrl);
      attachments.push({
        type: "file", url: linkUrl,
        name: link.displayName || linkUrl.split("/").pop()?.split("?")[0] || "linked-file",
        contentType: "",
      });
    }
  }

  const body = interaction.body?.content ?? "";
  const bodyType = interaction.body?.contentType ?? "text";

  if (bodyType === "html") {
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = imgRegex.exec(body)) !== null) {
      const src = match[1];
      if (src && !seen.has(src) && src.startsWith("http")) {
        seen.add(src);
        attachments.push({ type: "image", url: src, name: "", contentType: "image/png" });
      }
    }

    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
    while ((match = linkRegex.exec(body)) !== null) {
      const href = match[1];
      const text = match[2];
      if (href && !seen.has(href)) {
        const isGraphFile = href.includes("graph.microsoft.com") && (href.includes("/content") || href.includes("/driveItem"));
        const isSharePoint = href.includes("sharepoint.com");
        if (isGraphFile || isSharePoint) {
          seen.add(href);
          attachments.push({ type: "file", url: href, name: text || "attachment", contentType: "" });
        }
      }
    }
  }

  return attachments;
}

// ── Extract code blocks from HTML body → save as files ───────────────

function extractCodeFiles(interaction) {
  const body = interaction.body?.content ?? "";
  const bodyType = interaction.body?.contentType ?? "text";
  const files = [];

  if (bodyType === "html") {
    const codeRegex = /<pre[^>]*><code[^>]*(?:class=["'](?:language-)?(\w+)["'])?[^>]*>([\s\S]*?)<\/code><\/pre>/gi;
    let match;
    let idx = 0;
    while ((match = codeRegex.exec(body)) !== null) {
      idx++;
      const lang = match[1] || "";
      let code = match[2]
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .trim();
      if (!code || code.length < 20) continue;

      const extMap = { python: ".py", javascript: ".js", typescript: ".ts", java: ".java", csharp: ".cs", cpp: ".cpp", c: ".c", html: ".html", css: ".css", sql: ".sql", bash: ".sh", shell: ".sh", json: ".json", xml: ".xml", yaml: ".yml", csv: ".csv", r: ".r", ruby: ".rb", go: ".go", rust: ".rs", php: ".php" };
      const ext = extMap[lang.toLowerCase()] || ".txt";
      const name = `generated_code_${idx}${ext}`;
      files.push({ name, content: code, mime: "text/plain" });
    }
  }

  // Also check for CSV-like content in text responses
  const textBody = bodyType === "text" ? body : "";
  if (textBody && textBody.includes(",") && textBody.split("\n").length > 3) {
    const lines = textBody.split("\n").filter((l) => l.trim());
    const commaLines = lines.filter((l) => l.split(",").length >= 2);
    if (commaLines.length >= 3 && commaLines.length / lines.length > 0.5) {
      files.push({ name: "generated_data.csv", content: textBody, mime: "text/csv" });
    }
  }

  return files;
}

// ── Text extraction ──────────────────────────────────────────────────

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textFromAdaptiveCard(json) {
  try {
    const card = typeof json === "string" ? JSON.parse(json) : json;
    const parts = [];
    function walk(elements) {
      if (!Array.isArray(elements)) return;
      for (const el of elements) {
        if (el.type === "TextBlock" && el.text) parts.push(el.text);
        if (el.type === "RichTextBlock" && Array.isArray(el.inlines)) {
          for (const inline of el.inlines) {
            if (inline.text) parts.push(inline.text);
          }
        }
        if (Array.isArray(el.body)) walk(el.body);
        if (Array.isArray(el.columns)) {
          for (const col of el.columns) {
            if (Array.isArray(col.items)) walk(col.items);
          }
        }
        if (Array.isArray(el.items)) walk(el.items);
      }
    }
    walk(card.body ?? [card]);
    return parts.join("\n\n").trim();
  } catch {
    return "";
  }
}

function extractText(interaction) {
  const body = interaction.body?.content ?? "";
  const contentType = interaction.body?.contentType ?? "text";
  const attachmentTexts = (interaction.attachments || [])
    .filter((a) => a.contentType === "application/vnd.microsoft.card.adaptive" && a.content)
    .map((a) => textFromAdaptiveCard(a.content))
    .filter(Boolean);
  if (attachmentTexts.length > 0) return attachmentTexts.join("\n\n");
  return contentType === "html" ? stripHtml(body) : body.trim();
}

// ── Grouping ─────────────────────────────────────────────────────────

function groupBySession(interactions) {
  const map = new Map();
  for (const item of interactions) {
    const sid = item.sessionId || "unknown";
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(item);
  }
  for (const items of map.values()) {
    items.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));
  }
  return map;
}

function formatTimestamp(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function textRuns(text, style = {}) {
  const lines = text.split("\n");
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) runs.push(new TextRun({ break: 1, ...style }));
    runs.push(new TextRun({ text: lines[i], ...style }));
  }
  return runs;
}

// ── Build DOCX with embedded images ──────────────────────────────────

async function buildConversationDocx(items, convIdx, userName, downloadedImages, uploadedFileLinks) {
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
        text: `${userName} — ${items.length} message${items.length === 1 ? "" : "s"}`,
        size: 24, color: "666666", italics: true,
      })],
    })
  );

  const firstDate = items[0]?.createdDateTime;
  if (firstDate) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        children: [new TextRun({ text: formatTimestamp(firstDate), size: 20, color: "888888" })],
      })
    );
  }

  const isChatGPT = items.some((i) => i.sessionId?.startsWith("chatgpt-") || i._conversationTitle);

  for (const item of items) {
    const isUser = item.interactionType === "userPrompt";
    const senderLabel = isUser ? "You" : isChatGPT ? "ChatGPT" : "Copilot";
    const text = extractText(item);
    const attachments = extractAttachments(item);

    if (!text && attachments.length === 0) continue;

    children.push(
      new Paragraph({
        spacing: { before: 200, after: 40 },
        children: [
          new TextRun({ text: senderLabel, bold: true, size: 22, color: isUser ? "0B5394" : "38761D" }),
          new TextRun({ text: `    ${formatTimestamp(item.createdDateTime)}`, size: 16, color: "AAAAAA" }),
        ],
      })
    );

    if (text) {
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 4, color: isUser ? "0B5394" : "38761D", space: 8 } },
          children: textRuns(text, { size: 21, font: "Calibri", color: "333333" }),
        })
      );
    }

    for (const att of attachments) {
      if (att.type === "image" && downloadedImages.has(att.url)) {
        const imgBuf = downloadedImages.get(att.url);
        try {
          children.push(
            new Paragraph({
              spacing: { after: 80 },
              indent: { left: 360 },
              children: [
                new ImageRun({
                  data: imgBuf,
                  transformation: { width: 400, height: 300 },
                  type: att.contentType?.includes("png") ? "png" : "jpg",
                }),
              ],
            })
          );
        } catch {
          children.push(
            new Paragraph({
              indent: { left: 360 },
              children: [new TextRun({ text: `[Image: ${att.name || att.url}]`, italics: true, size: 18, color: "888888" })],
            })
          );
        }
      } else if (att.type === "file") {
        const label = att.name || "Attached file";
        const driveLink = uploadedFileLinks?.get(att.url);
        const linkUrl = driveLink || att.url;
        const prefix = driveLink ? "Google Drive" : "Original";
        children.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 360 },
            children: [
              new TextRun({ text: `[${prefix}] `, size: 18, bold: true, color: driveLink ? "38761D" : "888888" }),
              new ExternalHyperlink({
                link: linkUrl,
                children: [new TextRun({ text: label, style: "Hyperlink", size: 20, color: "0B5394", underline: {} })],
              }),
            ],
          })
        );
      }
    }
  }

  const doc = new Document({
    creator: "Copilot Migration Tool",
    title: `Conversation ${convIdx}`,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Build merged DOCX for batch of conversations ──────────────────────

async function buildMergedBatchDocx(batchEntries, userName, uploadedFileLinks, startConvIdx) {
  const children = [];

  // Cover page
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: "Copilot Conversations", bold: true, size: 48 })],
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: userName, size: 28, color: "444444", italics: true })],
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 500 },
      children: [new TextRun({
        text: `${batchEntries.length} conversation${batchEntries.length !== 1 ? "s" : ""} · Batch exported ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
        size: 20, color: "888888",
      })],
    })
  );

  // Index
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 160 },
      children: [new TextRun({ text: "CONVERSATION INDEX", bold: true, size: 26, color: "0B5394", allCaps: true })],
    })
  );

  for (let i = 0; i < batchEntries.length; i++) {
    const [, items] = batchEntries[i];
    const convIdx = startConvIdx + i;
    const title = conversationTitle(items);
    const dateStr = items[0]?.createdDateTime
      ? new Date(items[0].createdDateTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "";
    const msgCount = items.length;

    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${convIdx}.  `, bold: true, size: 20, color: "0B5394" }),
          new TextRun({ text: title, size: 20, color: "1E3A5F", bold: true }),
          new TextRun({ text: dateStr ? `\t${dateStr}` : "", size: 18, color: "999999" }),
          new TextRun({ text: `  (${msgCount} msg${msgCount !== 1 ? "s" : ""})`, size: 17, color: "AAAAAA" }),
        ],
      })
    );
  }

  // Page break
  children.push(new Paragraph({ spacing: { before: 400 }, children: [new PageBreak()] }));

  // Conversations
  for (let i = 0; i < batchEntries.length; i++) {
    const [, items] = batchEntries[i];
    const convIdx = startConvIdx + i;
    const title = conversationTitle(items);

    if (i > 0) {
      children.push(
        new Paragraph({
          spacing: { before: 400, after: 400 },
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB", space: 1 } },
          children: [],
        })
      );
    }

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 100, after: 60 },
        children: [new TextRun({ text: `Conversation ${convIdx}: ${title}`, bold: true, size: 30, color: "0B5394" })],
      })
    );

    const firstDate = items[0]?.createdDateTime;
    if (firstDate) {
      children.push(
        new Paragraph({
          spacing: { after: 180 },
          children: [new TextRun({ text: `Date: ${formatTimestamp(firstDate)}`, size: 18, color: "888888", italics: true })],
        })
      );
    }

    // Messages
    for (const item of items) {
      const isUser = item.interactionType === "userPrompt";
      const senderLabel = isUser ? "You" : "Copilot";
      const text = extractText(item);
      const attachments = extractAttachments(item);

      if (!text && attachments.length === 0) continue;

      children.push(
        new Paragraph({
          spacing: { before: 200, after: 40 },
          children: [
            new TextRun({ text: senderLabel, bold: true, size: 22, color: isUser ? "0B5394" : "38761D" }),
            new TextRun({ text: `    ${formatTimestamp(item.createdDateTime)}`, size: 16, color: "AAAAAA" }),
          ],
        })
      );

      if (text) {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 4, color: isUser ? "0B5394" : "38761D", space: 8 } },
            children: textRuns(text, { size: 21, font: "Calibri", color: "333333" }),
          })
        );
      }

      for (const att of attachments) {
        if (att.type === "file") {
          const label = att.name || "Attached file";
          const driveLink = uploadedFileLinks?.get(att.url);
          const linkUrl = driveLink || att.url;
          const prefix = driveLink ? "Google Drive" : "Original";
          children.push(
            new Paragraph({
              spacing: { after: 60 },
              indent: { left: 360 },
              children: [
                new TextRun({ text: `[${prefix}] `, size: 18, bold: true, color: driveLink ? "38761D" : "888888" }),
                new ExternalHyperlink({
                  link: linkUrl,
                  children: [new TextRun({ text: label, style: "Hyperlink", size: 20, color: "0B5394", underline: {} })],
                }),
              ],
            })
          );
        }
      }
    }
  }

  const doc = new Document({
    creator: "Copilot Migration Tool",
    title: "Copilot Conversations Batch",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Conversation title ───────────────────────────────────────────────

function conversationTitle(items) {
  const chatgptTitle = items[0]?._conversationTitle;
  if (chatgptTitle && chatgptTitle !== "Untitled Conversation") return chatgptTitle.slice(0, 80);
  for (const item of items) {
    if (item.interactionType === "userPrompt") {
      const text = extractText(item);
      if (text) return text.slice(0, 80).replace(/\n/g, " ");
    }
  }
  return "Untitled";
}

// ── Download all attachments for a conversation ──────────────────────

async function downloadConversationAssets(items, accessToken, sourceUserId, userDelegatedToken = null, uploadedFileLinks = null) {
  const downloadedImages = new Map();
  const filesToUpload = [];
  const seen = new Set();

  // Session-scoped Python regen cache. Copilot's Analysis-tool outputs are
  // served from asyncgw URLs that are locked behind Teams session auth. When
  // every other download attempt fails (delegated token, OneDrive search,
  // Graph shares), the Python source code Copilot used to generate the file
  // is embedded in the adaptive card — re-running it locally produces the
  // same file bytes. Runs once per session, used for any number of attachments.
  let sessionRegen = null;
  let sessionRegenAttempted = false;
  const usedRegenPaths = new Set();
  async function tryRegenFallback(att) {
    if (!sessionRegenAttempted) {
      sessionRegenAttempted = true;
      try {
        sessionRegen = await regenerateFilesFromInteraction(items);
      } catch (e) {
        console.warn(`[Migration] Session regen failed: ${e.message}`);
      }
    }
    if (!sessionRegen || !sessionRegen.files || sessionRegen.files.length === 0) return null;
    const lastSeg = att.url?.split("/").pop()?.split("?")[0] || "";
    const expectedName = (lastSeg && lastSeg.includes(".")) ? lastSeg : (att.name || "");
    let match = pickRegeneratedFileByName(sessionRegen, expectedName);
    if (!match) {
      match = sessionRegen.files.find(f => !usedRegenPaths.has(f.fullPath));
      if (match) console.log(`[Migration] Regen name match failed for "${expectedName}", using unmatched file "${match.name}"`);
    }
    if (!match) return null;
    usedRegenPaths.add(match.fullPath);
    return match;
  }

  // Search the user's OneDrive by file name as a fallback
  async function searchUserDrive(fileName) {
    if (!accessToken || !sourceUserId || !fileName) return null;
    try {
      const searchUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sourceUserId)}/drive/root/search(q='${encodeURIComponent(fileName)}')`;
      const res = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const item = data.value?.[0];
      if (item?.["@microsoft.graph.downloadUrl"]) return item["@microsoft.graph.downloadUrl"];
      if (item?.id) {
        return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sourceUserId)}/drive/items/${item.id}/content`;
      }
    } catch { /* ignore */ }
    return null;
  }

  for (const item of items) {
    const attachments = extractAttachments(item);
    for (const att of attachments) {
      const key = att.url || att.attachmentId || att.driveItemId || att.name;
      if (seen.has(key)) continue;
      // Cross-session dedup: if a previous conversation in this run already
      // uploaded this exact URL to Drive, skip download+upload entirely.
      // The DOCX renderer will still pick up the existing webViewLink from
      // uploadedFileLinks for the hyperlink.
      if (att.url && uploadedFileLinks?.has(att.url)) {
        seen.add(key);
        continue;
      }
      seen.add(key);

      let downloadUrl = att.url;

      // Resolve driveItem references using the source user's drive
      if (!downloadUrl && att.needsDriveDownload && att.driveItemId) {
        downloadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sourceUserId)}/drive/items/${att.driveItemId}/content`;
      }

      // Graph entity URLs from contexts[].contextReference["@odata.id"] are entity endpoints,
      // not download endpoints — append /content to get the binary.
      if (downloadUrl &&
        downloadUrl.includes("graph.microsoft.com") &&
        !downloadUrl.includes("/content") &&
        (downloadUrl.includes("/drives/") || downloadUrl.includes("/driveItems/") || downloadUrl.includes("/items/"))) {
        downloadUrl = downloadUrl.replace(/\/$/, "") + "/content";
      }

      // asyncgw URLs wrap SharePoint URLs — unwrap first, then convert to Graph
      if (downloadUrl && (downloadUrl.includes("asyncgw.teams.microsoft.com") || downloadUrl.includes("teams.cdn.office.net"))) {
        const unwrapped = convertToGraphDownloadUrl(downloadUrl);
        if (unwrapped) {
          downloadUrl = unwrapped;
        }
        // If no embedded SharePoint URL found, try with delegated token directly
      }

      // SharePoint webUrls — convert to Graph sharing link for download
      if (downloadUrl && downloadUrl.includes("sharepoint.com") && !downloadUrl.includes("graph.microsoft.com")) {
        const graphUrl = convertToGraphDownloadUrl(downloadUrl);
        if (graphUrl) downloadUrl = graphUrl;
      }

      // For attachments with only a name, search the user's OneDrive
      if (!downloadUrl && att.name && (att.needsContextLookup || att.needsDriveDownload)) {
        downloadUrl = await searchUserDrive(att.name);
        if (downloadUrl) console.log(`[Migration] Found "${att.name}" in OneDrive → downloading`);
      }

      console.log(`[Migration] Resolved: type=${att.type} name="${att.name}" url=${downloadUrl?.slice(0, 80) || "null"}`);

      // For asyncgw URLs that couldn't be replaced with a Graph URL, try delegated token
      const isAsyncGwUrl = downloadUrl && (downloadUrl.includes("asyncgw.teams.microsoft.com") || downloadUrl.includes("teams.cdn.office.net"));
      const effectiveToken = (isAsyncGwUrl && userDelegatedToken) ? userDelegatedToken : accessToken;
      // asyncgwUrl fallback for attachments from the attachments[] path (has att.asyncGwUrl)
      const asyncGwFallback = (att.isAsyncGw && att.asyncGwUrl) ? att.asyncGwUrl : (isAsyncGwUrl ? downloadUrl : null);

      if (att.type === "image" && downloadUrl) {
        try {
          let result = await downloadBinary(downloadUrl, effectiveToken);
          if (!result && asyncGwFallback && userDelegatedToken) {
            result = await downloadBinary(asyncGwFallback, userDelegatedToken);
          }
          if (result) {
            const { buffer: buf, contentType: resCt } = result;
            downloadedImages.set(att.url || downloadUrl, buf);
            const ext = guessExtension(resCt || att.contentType, downloadUrl);
            filesToUpload.push({
              name: att.name || `image${downloadedImages.size}${ext}`,
              buffer: buf, mime: guessMime(ext), type: "image",
              originalUrl: att.url || downloadUrl,
            });
            console.log(`[Migration] Image downloaded: ${att.name || downloadUrl}`);
          } else if (isAsyncGwUrl) {
            // Final fallback: Python regen for ephemeral asyncgw images
            const regenFile = await tryRegenFallback(att);
            if (regenFile) {
              const buf = fs.readFileSync(regenFile.fullPath);
              downloadedImages.set(att.url || downloadUrl, buf);
              const ext = guessExtension("", regenFile.name);
              filesToUpload.push({
                name: regenFile.name || `image${downloadedImages.size}${ext}`,
                buffer: buf, mime: guessMime(ext), type: "image",
                originalUrl: att.url || downloadUrl,
              });
              console.log(`[Migration] Image regenerated via Python: ${regenFile.name} (${regenFile.size} bytes)`);
            } else {
              console.warn(`[Migration] Image download returned empty: ${att.name || downloadUrl}`);
            }
          } else {
            console.warn(`[Migration] Image download returned empty: ${att.name || downloadUrl}`);
          }
        } catch (e) {
          console.warn(`[Migration] Image download error for ${att.name}: ${e.message}`);
        }
      } else if (att.type === "file" && downloadUrl) {
        console.log(`[Migration] Downloading file: ${att.name} from ${downloadUrl.slice(0, 80)}...`);
        try {
          let result = await downloadBinary(downloadUrl, effectiveToken);
          if (!result && asyncGwFallback && userDelegatedToken) {
            console.log(`[Migration] Retrying "${att.name}" with delegated token on asyncgw URL`);
            result = await downloadBinary(asyncGwFallback, userDelegatedToken);
          }
          if (result) {
            const { buffer: buf, contentType: resCt, disposition } = result;
            // Prefer filename from Content-Disposition header over the label from the card
            const rawDispositionName = disposition?.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i)?.[1]?.trim();
            const dispositionName = rawDispositionName ? (() => { try { return decodeURIComponent(rawDispositionName); } catch { return rawDispositionName; } })() : null;
            const ext = guessExtension(resCt || att.contentType, downloadUrl);
            let name = dispositionName || (att.name && !/^\d+$/.test(att.name) && att.name !== "null" ? att.name : null);
            if (name) {
              name = name.includes(".") ? name : name + ext;
            } else {
              name = `file_${filesToUpload.length + 1}${ext}`;
            }
            filesToUpload.push({
              name, buffer: buf, mime: resCt || guessMime(ext), type: "file",
              originalUrl: att.url || downloadUrl,
            });
            console.log(`[Migration] File downloaded: ${name} (${buf.length} bytes)`);
          } else {
            console.warn(`[Migration] File download returned empty: ${att.name} — trying OneDrive search`);
            const fallbackUrl = await searchUserDrive(att.name);
            let recovered = false;
            if (fallbackUrl) {
              const result2 = await downloadBinary(fallbackUrl, accessToken);
              if (result2) {
                const { buffer: buf2, contentType: resCt2, disposition: disp2 } = result2;
                const dispositionName2 = disp2?.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i)?.[1]?.trim();
                const ext2 = guessExtension(resCt2 || att.contentType, fallbackUrl);
                const name2 = dispositionName2 || (att.name?.includes(".") ? att.name : (att.name || "file") + ext2);
                filesToUpload.push({ name: name2, buffer: buf2, mime: resCt2 || guessMime(ext2), type: "file", originalUrl: att.url || fallbackUrl });
                console.log(`[Migration] Downloaded "${name2}" via OneDrive search fallback`);
                recovered = true;
              }
            }
            // Final fallback: Python regen for ephemeral asyncgw files
            if (!recovered && isAsyncGwUrl) {
              const regenFile = await tryRegenFallback(att);
              if (regenFile) {
                const buf = fs.readFileSync(regenFile.fullPath);
                const ext = guessExtension("", regenFile.name);
                filesToUpload.push({
                  name: regenFile.name,
                  buffer: buf,
                  mime: guessMime(ext),
                  type: "file",
                  originalUrl: att.url || downloadUrl,
                });
                console.log(`[Migration] File regenerated via Python: ${regenFile.name} (${regenFile.size} bytes)`);
                recovered = true;
              }
            }
            if (!recovered) {
              console.warn(`[Migration] All fallbacks exhausted for "${att.name}"`);
            }
          }
        } catch (e) {
          console.warn(`[Migration] File download error for ${att.name}: ${e.message}`);
        }
      } else if (!downloadUrl && att.name) {
        // No URL at all — but it might still be an asyncgw attachment whose
        // download URL we couldn't resolve. If isAsyncGw flag was set during
        // extraction, try Python regen.
        if (att.isAsyncGw) {
          const regenFile = await tryRegenFallback(att);
          if (regenFile) {
            const buf = fs.readFileSync(regenFile.fullPath);
            const ext = guessExtension("", regenFile.name);
            filesToUpload.push({
              name: regenFile.name,
              buffer: buf,
              mime: guessMime(ext),
              type: "file",
              originalUrl: att.url || `regen:${regenFile.name}`,
            });
            console.log(`[Migration] File regenerated via Python (no URL): ${regenFile.name} (${regenFile.size} bytes)`);
          } else {
            console.warn(`[Migration] No download URL for "${att.name}" — skipping`);
          }
        } else {
          console.warn(`[Migration] No download URL for attachment "${att.name}" — skipping`);
        }
      }
    }

    const codeFiles = extractCodeFiles(item);
    for (const cf of codeFiles) {
      if (seen.has(cf.name)) continue;
      seen.add(cf.name);
      filesToUpload.push({
        name: cf.name,
        buffer: Buffer.from(cf.content, "utf-8"),
        mime: cf.mime,
        type: "code",
        originalUrl: `code:${cf.name}`,
      });
    }
  }

  // Cleanup Python regen temp dir (best-effort)
  if (sessionRegen) cleanupRegen(sessionRegen);

  return { downloadedImages, filesToUpload };
}

// ── Main migration function ──────────────────────────────────────────

export async function migrateUserPair({
  sourceUserId,
  sourceDisplayName,
  destUserEmail,
  userDelegatedToken,
}, opts = {}, onProgress = null) {
  const result = {
    sourceUserId,
    sourceDisplayName: sourceDisplayName || sourceUserId,
    destUserEmail,
    conversationsCount: 0,
    filesUploaded: 0,
    errors: [],
    files: [],
  };

  try {
    const client = await createSourceGraphClient();
    const accessToken = client.accessToken;

    console.log(`[Migration] Fetching Copilot data for userId="${sourceUserId}", displayName="${sourceDisplayName}"`);

    let interactions;
    // DB-first: try to load previously-fetched conversations from conversationStore.
    // For C2G this is used on RETRY — first run writes to DB, retry reads from DB.
    let dbConversations = null;
    if (opts?.batchId && opts?.appUserId && opts?.sourceEmail) {
      try {
        const { loadConversationsFromStore } = await import('../../_shared/conversationStore.js');
        const fromStore = await loadConversationsFromStore({
          appUserId: opts.appUserId,
          sourceEmail: opts.sourceEmail,
          batchId: opts.batchId,
          fromDate: opts.fromDate,
          toDate: opts.toDate,
          includeMigrated: !opts?.isResume,
        });
        if (fromStore && fromStore.length > 0) {
          dbConversations = fromStore;
          console.log(`[Migration] Loaded ${fromStore.length} conversations from conversationStore for ${sourceDisplayName}`);
          // Flatten back to interactions[] format that the rest of the code expects
          // (each conv.payload contains { interactions: [...] })
          interactions = [];
          for (const conv of fromStore) {
            if (conv.interactions && Array.isArray(conv.interactions)) {
              interactions.push(...conv.interactions);
            }
          }
        }
      } catch (_) { /* fall through to Graph fetch */ }
    }
    if (!interactions) {
      try {
        interactions = await getCopilotInteractionsForUser(accessToken, sourceUserId, {});
      } catch (fetchErr) {
        const msg = fetchErr.message || String(fetchErr);
        console.error(`[Migration] Failed to fetch for ${sourceDisplayName}: ${msg}`);
        if (msg.includes("Copilot license")) {
          result.errors.push(`User does not have a valid Microsoft 365 Copilot license. Please assign a Copilot license and wait 15-30 minutes for it to propagate.`);
        } else if (msg.includes("403")) {
          result.errors.push(`Access denied (403): ${msg}`);
        } else {
          result.errors.push(`Failed to fetch Copilot data: ${msg}`);
        }
        return result;
      }
    }

    console.log(`[Migration] Got ${interactions.length} interactions for ${sourceDisplayName}`);

    // Date filtering
    if (opts.fromDate || opts.toDate) {
      const from = opts.fromDate ? new Date(opts.fromDate) : null;
      const to = opts.toDate ? new Date(opts.toDate + 'T23:59:59Z') : null;
      const before = interactions.length;
      interactions = interactions.filter(i => {
        const d = new Date(i.createdDateTime);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
      if (interactions.length !== before) console.log(`[Migration] Date filter: ${before} → ${interactions.length} interactions`);
    }

    if (interactions.length > 0) {
      const appClasses = [...new Set(interactions.map((i) => i.appClass))];
      console.log(`[Migration] App classes found: ${appClasses.join(", ")}`);
    }

    const folderName = opts.folderName || "CopilotChats";

    const sessions = groupBySession(interactions);
    result.conversationsCount = sessions.size;

    if (sessions.size === 0) {
      result.errors.push("No Copilot conversations found for this user.");
      return result;
    }

    // Persist Copilot interactions to conversationStore (additive).
    // Each session becomes one row keyed by (batchId, sessionId).
    if (opts?.batchId && opts?.appUserId) {
      try {
        const { persistSourceConversations, SOURCE_TYPE } = await import('../../_shared/conversationStore.js');
        const conversationDocs = Array.from(sessions.entries()).map(([sid, items]) => ({
          sessionId: sid,
          title: items[0]?.responseEnvelope?.title || items[0]?.body?.content?.slice(0, 80) || 'Untitled Copilot conversation',
          createdDateTime: items[0]?.createdDateTime,
          payload: { interactions: items },
        }));
        await persistSourceConversations(
          {
            batchId: opts.batchId,
            appUserId: opts.appUserId,
            migDir: 'copilot-gemini',
            sourceType: SOURCE_TYPE.GRAPH,
            sourceTenantId: opts.sourceTenantId || null,
            sourceUserId,
            sourceEmail: opts.sourceEmail || null,
            sourceDisplayName,
            destEmail: destUserEmail,
          },
          conversationDocs
        );
      } catch (persistErr) {
        console.warn(`[C2G] conversationStore persist (non-fatal): ${persistErr.message}`);
      }
    }

    const auth = getServiceAccountAuth(destUserEmail);
    const mainFolder = await createDriveFolder(auth, folderName);
    // Two subfolders: chats as Google Docs go to "Copilot Conversations",
    // every attached/generated file goes to "Migrated from Copilot". The
    // DOCX hyperlinks cross-link the two via Google Drive webViewLinks.
    const convoFolder = await createDriveFolder(auth, "Copilot Conversations", mainFolder.id);
    const filesFolder = await createDriveFolder(auth, "Migrated from Copilot", mainFolder.id);
    console.log(`[C2G] Folder layout: ${folderName}/ → Copilot Conversations/, Migrated from Copilot/`);

    // ── Split conversations into batches (100 per file) for memory efficiency ──
    const BATCH_SIZE = 100;
    const sessionArray = Array.from(sessions.entries());
    const batches = [];
    for (let i = 0; i < sessionArray.length; i += BATCH_SIZE) {
      batches.push(sessionArray.slice(i, i + BATCH_SIZE));
    }

    console.log(`[C2G] Processing ${sessions.size} conversation(s) in ${batches.length} batch(es) for ${sourceDisplayName}...`);

    // Cross-session dedup: a single source URL referenced in N conversations
    // should download + upload ONCE. The map's webViewLink is reused for the
    // hyperlink in every conversation's DOCX. Lives for the whole user-pair
    // migration, not just one batch.
    const uploadedFileLinks = new Map();
    // Content-hash dedup: the same file is often referenced through several
    // different URL forms (direct path, _layouts/15/Doc.aspx?sourcedoc=...
    // viewer, Graph /shares/u!... shares endpoint). URL dedup doesn't catch
    // these. Hashing the downloaded bytes does.
    const uploadedByContentHash = new Map(); // sha256 hex → { webViewLink }
    const { createHash } = await import("node:crypto");

    let totalConvIdx = 0;
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const startConvNum = batchIdx * BATCH_SIZE + 1;
      const endConvNum = Math.min((batchIdx + 1) * BATCH_SIZE, sessions.size);

      try {
        // Download assets + build DOCX for all conversations in this batch
        let batchDocxChildren = [];
        const batchTitle = `Copilot Conversations Batch ${batchIdx + 1}`;

        for (let i = 0; i < batch.length; i++) {
          totalConvIdx++;
          const [, items] = batch[i];
          const convIdx = totalConvIdx;
          const title = conversationTitle(items);
          const dateStr = items[0]?.createdDateTime
            ? new Date(items[0].createdDateTime).toISOString().slice(0, 10)
            : "unknown";

          console.log(`[C2G] Batch ${batchIdx + 1}/${batches.length}, Conv ${i + 1}/${batch.length} (overall ${convIdx}/${sessions.size}): downloading assets...`);
          const { downloadedImages, filesToUpload } = await downloadConversationAssets(items, accessToken, sourceUserId, userDelegatedToken, uploadedFileLinks);

          // Upload attachments → Migrated from Copilot folder
          for (const asset of filesToUpload) {
            try {
              // Content-hash dedup: skip if identical bytes already uploaded
              // under a different URL earlier in this run.
              const hash = createHash("sha256").update(asset.buffer).digest("hex");
              const existing = uploadedByContentHash.get(hash);
              if (existing) {
                if (asset.originalUrl) uploadedFileLinks.set(asset.originalUrl, existing.webViewLink);
                console.log(`[C2G] Dedup by content: "${asset.name}" matches earlier upload, link reused`);
                continue;
              }
              const uploaded = await uploadFileToDrive(auth, asset.name, asset.mime, asset.buffer, filesFolder.id);
              uploadedByContentHash.set(hash, { webViewLink: uploaded.webViewLink });
              result.filesUploaded++;
              result.files.push({
                name: asset.name,
                title: `${asset.type === "image" ? "Image" : "File"}: ${asset.name}`,
                driveFileId: uploaded.id,
                webViewLink: uploaded.webViewLink,
              });
              if (asset.originalUrl) {
                uploadedFileLinks.set(asset.originalUrl, uploaded.webViewLink);
              }
            } catch (uploadErr) {
              result.errors.push(`Asset ${asset.name}: ${uploadErr.message}`);
            }
          }
          // Emit progress AFTER each conversation so the UI ring updates
          // smoothly instead of jumping only between batch boundaries.
          if (onProgress) onProgress({ filesUploaded: result.filesUploaded, convIdx: totalConvIdx, totalConvs: sessions.size });
        }

        // Build merged DOCX for entire batch
        const docxBuffer = await buildMergedBatchDocx(batch, sourceDisplayName || sourceUserId, uploadedFileLinks, startConvNum);
        const partLabel = batches.length > 1 ? `_Part${batchIdx + 1}` : '';
        const docxName = `${sourceDisplayName}_Copilot_Conversations${partLabel}.docx`;

        // Conversation DOCX → Copilot Conversations folder
        const docxFile = await uploadFileToDrive(
          auth, docxName,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          docxBuffer,
          convoFolder.id
        );

        result.filesUploaded++;
        result.files.push({
          name: docxName,
          title: batchTitle,
          driveFileId: docxFile.id,
          webViewLink: docxFile.webViewLink,
          batchInfo: { part: batchIdx + 1, totalParts: batches.length, conversationRange: [startConvNum, endConvNum, sessions.size] }
        });

        console.log(`[C2G] Batch ${batchIdx + 1}/${batches.length}: uploaded merged DOCX (conversations ${startConvNum}-${endConvNum})`);
        if (onProgress) onProgress({ filesUploaded: result.filesUploaded, convIdx: totalConvIdx, totalConvs: sessions.size });
      } catch (err) {
        console.error(`[C2G] Batch ${batchIdx + 1} error: ${err.message}`);
        result.errors.push(`Batch ${batchIdx + 1}: ${err.message || String(err)}`);
      }
    }

    console.log(`[C2G] Done for ${sourceDisplayName}: ${result.filesUploaded} files uploaded, ${result.errors.length} errors`);
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}

export async function runMigration(pairs, opts = {}) {
  const results = [];
  for (const pair of pairs) {
    const r = await migrateUserPair(pair, opts);
    results.push(r);
  }
  return results;
}
