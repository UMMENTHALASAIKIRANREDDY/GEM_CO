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
              return buf.length > 0 ? buf : null;
            }
          } catch { /* timeout or network error on retry */ }
        }
      }
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function convertToGraphDownloadUrl(url) {
  try {
    const u = new URL(url);
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
  if (contentType?.includes("word") || contentType?.includes("docx")) return ".docx";
  if (contentType?.includes("excel") || contentType?.includes("xlsx")) return ".xlsx";
  if (contentType?.includes("powerpoint") || contentType?.includes("pptx")) return ".pptx";
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

  for (const att of interaction.attachments || []) {
    const ct = att.contentType || "";

    if (ct === "application/vnd.microsoft.card.adaptive") continue;

    if (att.contentUrl && !seen.has(att.contentUrl)) {
      seen.add(att.contentUrl);
      const isImage = ct.startsWith("image/") ||
        /\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(att.contentUrl);
      attachments.push({
        type: isImage ? "image" : "file",
        url: att.contentUrl,
        name: att.name || att.id || "",
        contentType: ct,
      });
    }

    if (!att.contentUrl && att.content) {
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
  for (const link of interaction.links || []) {
    const linkUrl = link.linkUrl || link.url || "";
    if (linkUrl && !seen.has(linkUrl)) {
      const isFile = linkUrl.includes("sharepoint.com") ||
        linkUrl.includes("graph.microsoft.com") ||
        /\.(pdf|docx|xlsx|pptx|csv|txt|zip|py|json)(\?|$)/i.test(linkUrl);
      if (isFile) {
        seen.add(linkUrl);
        attachments.push({
          type: "file", url: linkUrl,
          name: link.displayName || linkUrl.split("/").pop()?.split("?")[0] || "linked-file",
          contentType: "",
        });
      }
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

// ── Build ONE merged DOCX for all conversations ───────────────────────

async function buildAllConversationsDocx(sessions, userName, downloadedImages, uploadedFileLinks) {
  const children = [];
  const sessionList = [...sessions]; // array of [sessionId, items]
  const isChatGPT = sessionList.some(([, items]) =>
    items.some((i) => i.sessionId?.startsWith("chatgpt-") || i._conversationTitle)
  );
  const aiLabel = isChatGPT ? "ChatGPT" : "Copilot";

  // ── Cover ────────────────────────────────────────────────────────────
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text: `${aiLabel} Chat History`, bold: true, size: 48 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: userName, size: 28, color: "444444", italics: true })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 500 },
    children: [new TextRun({
      text: `${sessionList.length} conversation${sessionList.length !== 1 ? "s" : ""} · Exported ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
      size: 20, color: "888888",
    })],
  }));

  // ── Table of Contents ────────────────────────────────────────────────
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 200, after: 160 },
    children: [new TextRun({ text: "CONVERSATION INDEX", bold: true, size: 26, color: "0B5394", allCaps: true })],
  }));

  for (let i = 0; i < sessionList.length; i++) {
    const [, items] = sessionList[i];
    const title = conversationTitle(items);
    const dateStr = items[0]?.createdDateTime ? formatTimestamp(items[0].createdDateTime) : "";
    children.push(new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `${i + 1}.  `, bold: true, size: 20, color: "0B5394" }),
        new TextRun({ text: title, size: 20, color: "1E3A5F", bold: true }),
        new TextRun({ text: dateStr ? `\t${dateStr}` : "", size: 18, color: "999999" }),
        new TextRun({ text: `  (${items.length} msg${items.length !== 1 ? "s" : ""})`, size: 17, color: "AAAAAA" }),
      ],
    }));
  }

  // Page break before conversations
  children.push(new Paragraph({ spacing: { before: 400 }, children: [new PageBreak()] }));

  // ── All Conversations ────────────────────────────────────────────────
  for (let convIdx = 0; convIdx < sessionList.length; convIdx++) {
    const [, items] = sessionList[convIdx];
    const title = conversationTitle(items);
    const firstDate = items[0]?.createdDateTime;

    if (convIdx > 0) {
      children.push(new Paragraph({
        spacing: { before: 400, after: 400 },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB", space: 1 } },
        children: [],
      }));
    }

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 100, after: 60 },
      children: [new TextRun({ text: `Conversation ${convIdx + 1}: ${title}`, bold: true, size: 30, color: "0B5394" })],
    }));

    if (firstDate) {
      children.push(new Paragraph({
        spacing: { after: 180 },
        children: [new TextRun({ text: `Date: ${formatTimestamp(firstDate)}`, size: 18, color: "888888", italics: true })],
      }));
    }

    for (const item of items) {
      const isUser = item.interactionType === "userPrompt";
      const senderLabel = isUser ? "You" : aiLabel;
      const text = extractText(item);
      const attachments = extractAttachments(item);

      if (!text && attachments.length === 0) continue;

      children.push(new Paragraph({
        spacing: { before: 200, after: 40 },
        children: [
          new TextRun({ text: senderLabel, bold: true, size: 22, color: isUser ? "0B5394" : "38761D" }),
          new TextRun({ text: `    ${formatTimestamp(item.createdDateTime)}`, size: 16, color: "AAAAAA" }),
        ],
      }));

      if (text) {
        children.push(new Paragraph({
          spacing: { after: 80 },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 4, color: isUser ? "0B5394" : "38761D", space: 8 } },
          children: textRuns(text, { size: 21, font: "Calibri", color: "333333" }),
        }));
      }

      for (const att of attachments) {
        const imgKey = att.url || att.originalUrl;
        if (att.type === "image" && downloadedImages.has(imgKey)) {
          const imgBuf = downloadedImages.get(imgKey);
          try {
            children.push(new Paragraph({
              spacing: { after: 80 },
              indent: { left: 360 },
              children: [new ImageRun({
                data: imgBuf,
                transformation: { width: 400, height: 300 },
                type: att.contentType?.includes("png") ? "png" : "jpg",
              })],
            }));
          } catch {
            children.push(new Paragraph({
              indent: { left: 360 },
              children: [new TextRun({ text: `[Image: ${att.name || att.url}]`, italics: true, size: 18, color: "888888" })],
            }));
          }
        } else if (att.type === "file") {
          const label = att.name || "Attached file";
          const driveEntry = uploadedFileLinks?.get(att.url);
          const driveLink = driveEntry?.webViewLink || null;
          if (driveLink) {
            children.push(new Paragraph({
              spacing: { after: 60 },
              indent: { left: 360 },
              children: [
                new TextRun({ text: "📎 ", size: 20 }),
                new ExternalHyperlink({
                  link: driveLink,
                  children: [new TextRun({ text: label, style: "Hyperlink", size: 20, color: "1155CC", underline: {} })],
                }),
                new TextRun({ text: "  (Google Drive)", size: 17, color: "16a34a", italics: true }),
              ],
            }));
          } else {
            children.push(new Paragraph({
              indent: { left: 360 },
              children: [new TextRun({ text: `📎 ${label}  (not available)`, size: 18, color: "888888", italics: true })],
            }));
          }
        }
      }
    }
  }

  const doc = new Document({
    creator: "Copilot Migration Tool",
    title: `${aiLabel} Chat History — ${userName}`,
    description: `All ${aiLabel} conversations for ${userName}`,
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

async function downloadConversationAssets(items, accessToken, sourceUserId) {
  const downloadedImages = new Map();
  const filesToUpload = [];
  const seen = new Set();

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
      seen.add(key);

      let downloadUrl = att.url;

      // Resolve driveItem references using the source user's drive
      if (!downloadUrl && att.needsDriveDownload && att.driveItemId) {
        downloadUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sourceUserId)}/drive/items/${att.driveItemId}/content`;
      }

      // For attachments with only a name, search the user's OneDrive
      if (!downloadUrl && att.name && (att.needsContextLookup || att.needsDriveDownload)) {
        downloadUrl = await searchUserDrive(att.name);
        if (downloadUrl) console.log(`[Migration] Found "${att.name}" in OneDrive → downloading`);
      }

      if (att.type === "image" && downloadUrl) {
        try {
          const buf = await downloadBinary(downloadUrl, accessToken);
          if (buf) {
            downloadedImages.set(att.url || downloadUrl, buf);
            const ext = guessExtension(att.contentType, downloadUrl);
            filesToUpload.push({
              name: att.name || `image${downloadedImages.size}${ext}`,
              buffer: buf, mime: guessMime(ext), type: "image",
              originalUrl: att.url || downloadUrl,
            });
          }
        } catch { /* skip */ }
      } else if (att.type === "file" && downloadUrl) {
        try {
          const buf = await downloadBinary(downloadUrl, accessToken);
          if (buf) {
            const ext = guessExtension(att.contentType, downloadUrl);
            const name = att.name
              ? (att.name.includes(".") ? att.name : att.name + ext)
              : `file_${filesToUpload.length + 1}${ext}`;
            filesToUpload.push({
              name, buffer: buf, mime: guessMime(ext), type: "file",
              originalUrl: att.url || downloadUrl,
            });
          } else {
            // Last resort: search OneDrive by file name
            const fallbackUrl = await searchUserDrive(att.name);
            if (fallbackUrl) {
              const buf2 = await downloadBinary(fallbackUrl, accessToken);
              if (buf2) {
                const ext = guessExtension(att.contentType, fallbackUrl);
                const name = att.name?.includes(".") ? att.name : (att.name || "file") + ext;
                filesToUpload.push({ name, buffer: buf2, mime: guessMime(ext), type: "file", originalUrl: att.url || fallbackUrl });
                console.log(`[Migration] Downloaded "${name}" via OneDrive search fallback`);
              }
            }
          }
        } catch (e) {
          console.warn(`[Migration] File download error for ${att.name}: ${e.message}`);
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

  return { downloadedImages, filesToUpload };
}

// ── Main migration function ──────────────────────────────────────────

export async function migrateUserPair({
  sourceUserId,
  sourceDisplayName,
  destUserEmail,
}, opts = {}) {
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

    const auth = getServiceAccountAuth(destUserEmail);
    const mainFolder = await createDriveFolder(auth, folderName);

    console.log(`[C2G] Processing ${sessions.size} conversation(s) for ${sourceDisplayName}...`);

    // ── Step 1: Download all assets across all conversations ──────────
    const allDownloadedImages = new Map();
    const allFilesToUpload = [];
    const seenAssetNames = new Set();
    let convCount = 0;
    for (const [, items] of sessions) {
      convCount++;
      console.log(`[C2G] Conv ${convCount}/${sessions.size}: downloading assets...`);
      try {
        const { downloadedImages, filesToUpload } = await downloadConversationAssets(items, accessToken, sourceUserId);
        for (const [url, buf] of downloadedImages) allDownloadedImages.set(url, buf);
        for (const asset of filesToUpload) {
          // Deduplicate by name across all conversations
          let assetName = asset.name;
          if (seenAssetNames.has(assetName)) {
            const ext = assetName.includes(".") ? assetName.slice(assetName.lastIndexOf(".")) : "";
            const base = assetName.slice(0, assetName.length - ext.length);
            assetName = `${base}_${allFilesToUpload.length + 1}${ext}`;
          }
          seenAssetNames.add(assetName);
          allFilesToUpload.push({ ...asset, name: assetName });
        }
      } catch (err) {
        console.warn(`[C2G] Asset download error for conv ${convCount}: ${err.message}`);
      }
    }
    console.log(`[C2G] Total: ${allFilesToUpload.length} attachment(s), ${allDownloadedImages.size} image(s)`);

    // ── Step 2: Create Attachments/ subfolder and upload files there ──
    const uploadedFileLinks = new Map(); // originalUrl → { webViewLink, fileName }
    if (allFilesToUpload.length > 0) {
      let attachmentsFolder;
      try {
        attachmentsFolder = await createDriveFolder(auth, "Attachments", mainFolder.id);
        console.log(`[C2G] Created Attachments/ subfolder (id=${attachmentsFolder.id})`);
      } catch (err) {
        result.errors.push(`Could not create Attachments folder: ${err.message}`);
      }

      if (attachmentsFolder) {
        for (const asset of allFilesToUpload) {
          try {
            const uploaded = await uploadFileToDrive(auth, asset.name, asset.mime, asset.buffer, attachmentsFolder.id);
            result.filesUploaded++;
            result.files.push({
              name: asset.name,
              title: `${asset.type === "image" ? "Image" : "File"}: ${asset.name}`,
              driveFileId: uploaded.id,
              webViewLink: uploaded.webViewLink,
            });
            if (asset.originalUrl) {
              uploadedFileLinks.set(asset.originalUrl, { webViewLink: uploaded.webViewLink, fileName: asset.name });
            }
            console.log(`[C2G] Uploaded attachment: ${asset.name} → Attachments/ (${uploaded.webViewLink})`);
          } catch (uploadErr) {
            result.errors.push(`Asset ${asset.name}: ${uploadErr.message}`);
          }
        }
      }
    }

    // ── Step 3: Build ONE merged DOCX for all conversations ───────────
    try {
      const safeName = (sourceDisplayName || sourceUserId)
        .replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80).trim() || "User";
      const docxName = `${safeName}_All_Conversations.docx`;
      const docxBuffer = await buildAllConversationsDocx(sessions, sourceDisplayName || sourceUserId, allDownloadedImages, uploadedFileLinks);
      const docxFile = await uploadFileToDrive(
        auth, docxName,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        docxBuffer, mainFolder.id
      );
      result.filesUploaded++;
      result.files.push({ name: docxName, title: "All Conversations", driveFileId: docxFile.id, webViewLink: docxFile.webViewLink });
      console.log(`[C2G] Uploaded merged DOCX: ${docxName}`);
    } catch (err) {
      console.error(`[C2G] Merged DOCX build error: ${err.message}`);
      result.errors.push(`Merged DOCX: ${err.message}`);
    }

    console.log(`[C2G] Done for ${sourceDisplayName}: ${result.filesUploaded} file(s) uploaded, ${result.errors.length} error(s)`);
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
