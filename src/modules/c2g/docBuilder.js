import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
  TabStopType,
  TabStopPosition,
} from "docx";

// ── Text extraction helpers ──────────────────────────────────────────

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
        if (el.type === "TextBlock" && el.text) {
          parts.push(el.text);
        }
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

// ── Grouping helpers ─────────────────────────────────────────────────

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
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function sessionLabel(items) {
  const first = items[0]?.createdDateTime;
  const last = items[items.length - 1]?.createdDateTime;
  const startDate = first ? formatTimestamp(first) : "Unknown date";
  const msgCount = items.length;
  return `${startDate}  ·  ${msgCount} message${msgCount === 1 ? "" : "s"}`;
}

// ── Line-splitting helper for multi-line text ────────────────────────

function textRunsFromMultiline(text, style = {}) {
  const lines = text.split("\n");
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) runs.push(new TextRun({ break: 1, ...style }));
    runs.push(new TextRun({ text: lines[i], ...style }));
  }
  return runs;
}

// ── Build the Word document ──────────────────────────────────────────

export async function buildDocx(userId, displayName, interactions) {
  const sessions = groupBySession(interactions);

  const children = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "Copilot Chat History", bold: true, size: 48 }),
      ],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: displayName || userId,
          size: 28,
          color: "444444",
        }),
      ],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `Generated ${formatTimestamp(new Date().toISOString())}  ·  ${interactions.length} interactions across ${sessions.size} conversation${sessions.size === 1 ? "" : "s"}`,
          size: 20,
          italics: true,
          color: "888888",
        }),
      ],
    })
  );

  let conversationIdx = 0;
  for (const [, items] of sessions) {
    conversationIdx++;

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 100 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: "0078D4" },
        },
        children: [
          new TextRun({
            text: `Conversation ${conversationIdx}`,
            bold: true,
            size: 28,
            color: "0078D4",
          }),
        ],
      })
    );

    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: sessionLabel(items),
            size: 18,
            italics: true,
            color: "999999",
          }),
        ],
      })
    );

    for (const item of items) {
      const isUser = item.interactionType === "userPrompt";
      const senderLabel = isUser ? "You" : "Copilot";
      const text = extractText(item);
      if (!text) continue;

      const timestamp = formatTimestamp(item.createdDateTime);

      children.push(
        new Paragraph({
          spacing: { before: 200, after: 40 },
          children: [
            new TextRun({
              text: senderLabel,
              bold: true,
              size: 22,
              color: isUser ? "0B5394" : "38761D",
            }),
            new TextRun({
              text: `    ${timestamp}`,
              size: 16,
              color: "AAAAAA",
            }),
          ],
        })
      );

      children.push(
        new Paragraph({
          spacing: { after: 160 },
          indent: { left: 360 },
          border: {
            left: {
              style: BorderStyle.SINGLE,
              size: 4,
              color: isUser ? "0B5394" : "38761D",
              space: 8,
            },
          },
          children: textRunsFromMultiline(text, {
            size: 21,
            font: "Calibri",
            color: "333333",
          }),
        })
      );
    }
  }

  if (interactions.length === 0) {
    children.push(
      new Paragraph({
        spacing: { before: 400 },
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: "No Copilot interactions found for this user.",
            italics: true,
            color: "999999",
            size: 24,
          }),
        ],
      })
    );
  }

  const doc = new Document({
    creator: "Copilot Export Tool",
    title: `Copilot Chat History — ${displayName || userId}`,
    description: `Copilot interactions for ${userId}`,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
        },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
