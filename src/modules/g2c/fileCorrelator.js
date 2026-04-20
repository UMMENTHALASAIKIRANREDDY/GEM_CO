import { google } from 'googleapis';
import { AuditLogClient } from './auditLogClient.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:fileCorrelator');
// Gemini-triggered audit event name
// Gemini file reads appear as either 'view' or 'access_item_content' events in audit logs
const GEMINI_EVENT = 'view'; // primary; also match 'access_item_content' as fallback

/**
 * Correlates Gemini conversations to Drive files using a hybrid approach:
 *  1. Primary:  audit log 'view' events (actor=Gemini service account) matched per-turn ±60s
 *  2. Fallback: Drive fullText search using labels extracted from Gemini response text
 *
 * This class ONLY resolves Drive file metadata — it does NOT upload to OneDrive.
 * Upload is handled by the caller (server.js) so the MS token is always fresh.
 */
export class FileCorrelator {
  constructor(googleAuthClient, ownerEmail) {
    this.auth = googleAuthClient;
    this.ownerEmail = ownerEmail;
    this.drive = google.drive({ version: 'v3', auth: googleAuthClient });
    this.auditClient = new AuditLogClient(googleAuthClient);
    this._metadataCache = new Map();
    this._searchCache = new Map();
  }

  /**
   * Enrich an array of conversations with Drive file metadata.
   */
  async enrichConversations(conversations) {
    if (!conversations || conversations.length === 0) return conversations;

    logger.info(`FileCorrelator: enriching ${conversations.length} conversations for ${this.ownerEmail}`);

    const enriched = [];
    for (const conv of conversations) {
      try {
        enriched.push(await this._enrichConversation(conv));
      } catch (err) {
        logger.warn(`FileCorrelator: failed to enrich "${conv.title}": ${err.message}`);
        enriched.push(conv);
      }
    }
    return enriched;
  }

  /**
   * Enrich a single conversation.
   *
   * Primary:  audit log item_content_accessed events (actor=Gemini) matched per-turn ±60s
   * Fallback: Drive fullText search using labels extracted from Gemini response text
   */
  async _enrichConversation(conv) {
    const turns = conv.turns || [];
    if (!turns.some(t => t.hasFileRef)) return conv;

    // Fetch all item_content_accessed events for the conversation window once
    // (actor=Gemini so we must use userKey='all', then filter by file owner)
    const auditEvents = await this._fetchGeminiAuditEvents(turns, conv.title);

    const enrichedTurns = await Promise.all(turns.map(async (turn, turnIdx) => {
      if (!turn.hasFileRef) return turn;

      const turnTs = turn.timestamp ? new Date(turn.timestamp) : null;
      const turnLabel = `[${this.ownerEmail}] conv="${conv.title}" turn#${turnIdx} ts=${turn.timestamp || 'none'}`;

      // --- Primary: audit log match within ±60s of this turn ---
      let matched = [];
      if (turnTs && !isNaN(turnTs) && auditEvents.length > 0) {
        matched = auditEvents.filter(e => {
          const diff = Math.abs(e.accessTime - turnTs);
          return diff <= 60_000; // 60 seconds
        });
        if (matched.length > 0) {
          logger.info(`FileCorrelator: ${turnLabel} → audit matched ${matched.length} file(s): ${matched.map(e => e.docTitle).join(', ')}`);
        }
      }

      // --- Fallback: fullText Drive search using Gemini labels (PAUSED) ---
      // Disabled for now — fullText search finds too many false positives
      // if (matched.length === 0) {
      //   const geminiLabels = _extractGeminiLabels(turn.response);
      //   if (geminiLabels.length > 0) {
      //     logger.info(`FileCorrelator: ${turnLabel} → no audit match, fullText search for: ${geminiLabels.join(', ')}`);
      //     const searchResults = await this._searchDriveByLabels(geminiLabels);
      //     if (searchResults.length > 0) {
      //       // Convert search results to same shape as audit events for uniform processing
      //       matched = searchResults.map(r => ({
      //         docId:      r.driveFileId,
      //         docTitle:   r.fileName,
      //         mimeType:   r.mimeType,
      //         accessTime: turnTs,
      //         source:     'drive_fulltext',
      //         confidence: r.confidence,
      //         _meta:      r._meta,
      //       }));
      //     }
      //   }
      // }

      if (matched.length === 0) {
        logger.info(`FileCorrelator: ${turnLabel} → no files resolved`);
        return turn;
      }

      // Deduplicate by docId, keep highest confidence / most recent
      const deduped = new Map();
      for (const e of matched) {
        const existing = deduped.get(e.docId);
        if (!existing || (e.confidence || 0) > (existing.confidence || 0)) {
          deduped.set(e.docId, e);
        }
      }

      // Resolve full Drive metadata for audit-matched files (they only have docId)
      const files = await Promise.all([...deduped.values()].map(async (e) => {
        const meta = e._meta || await this._getFileMetadata(e.docId);
        if (!meta) return null;
        return {
          fileName:    meta.name || e.docTitle || e.docId,
          driveFileId: e.docId,
          mimeType:    meta.mimeType || e.mimeType,
          webViewLink: meta.webViewLink || null,
          confidence:  e.source === 'drive_fulltext' ? (e.confidence || 0.7) : 1.0,
          source:      e.source || 'audit',
          _meta:       meta,
        };
      }));

      const validFiles = files.filter(Boolean).sort((a, b) => b.confidence - a.confidence);
      if (validFiles.length === 0) return turn;

      // Return resolved files with _meta intact — caller handles upload
      logger.info(`FileCorrelator: ${turnLabel} → resolved ${validFiles.length} file(s): ${validFiles.map(f => f.fileName).join(', ')}`);
      return { ...turn, driveFiles: validFiles };
    }));

    return { ...conv, turns: enrichedTurns };
  }

  /**
   * Fetch all item_content_accessed events for the conversation window.
   * Must use userKey='all' because actor=Gemini service account, not the user.
   * Filters results to files owned by ownerEmail.
   */
  async _fetchGeminiAuditEvents(turns, convTitle) {
    const timestamps = turns
      .map(t => t.timestamp).filter(Boolean)
      .map(ts => new Date(ts)).filter(d => !isNaN(d));

    if (timestamps.length === 0) return [];

    const startTime = new Date(Math.min(...timestamps));
    const endTime   = new Date(Math.max(...timestamps));

    try {
      // Use drive app — Gemini file reads appear as 'view' events under the drive application
      // userKey=ownerEmail works because actor=zara (not a service account)
      const events = await this.auditClient.getDriveEventsForWindow(
        this.ownerEmail, startTime, endTime, 2, null, 'drive'
      );

      // Keep only Gemini-triggered reads owned by our vault user
      // Match both 'view' (current) and 'access_item_content' (legacy) event names
      const filtered = events.filter(
        e => (e.eventName === GEMINI_EVENT || e.eventName === 'access_item_content') && e.ownerEmail === this.ownerEmail
      );
      logger.info(`FileCorrelator: [${this.ownerEmail}] conv="${convTitle}" → ${filtered.length} view event(s) in window (${events.length} total fetched, window: ${startTime.toISOString()}→${endTime.toISOString()})`);
      return filtered;
    } catch (err) {
      logger.warn(`FileCorrelator: audit fetch failed for "${convTitle}": ${err.message}`);
      return [];
    }
  }

  /**
   * For each Gemini label, search Drive by full-text content + MIME filter.
   * Gemini labels are derived from file content, so fullText search finds the right
   * file even when the filename is completely different (e.g. "agentpdf.pdf" vs "Google Cloud ADK").
   *
   * Returns array of { fileName, driveFileId, mimeType, webViewLink, confidence, matchedLabel, _meta }
   */
  async _searchDriveByLabels(geminiLabels) {
    const results = [];
    const seenIds = new Set();

    for (const label of geminiLabels) {
      const keywords = _labelToKeywords(label);
      if (keywords.length === 0) continue;

      const mimeFilter = _labelToMimeFilter(label);

      // Try progressively broader searches until we get results
      let files = [];

      // Pass 1: all keywords as fullText search + MIME filter
      files = await this._searchDriveFullText(keywords.join(' '), mimeFilter);

      // Pass 2: if no results, drop MIME filter
      if (files.length === 0 && mimeFilter) {
        files = await this._searchDriveFullText(keywords.join(' '), null);
      }

      // Pass 3: if still no results, try longest keyword only
      if (files.length === 0 && keywords.length > 1) {
        const longest = keywords.slice().sort((a, b) => b.length - a.length)[0];
        files = await this._searchDriveFullText(longest, mimeFilter);
      }

      // When multiple files match, only take the best one (highest MIME score)
      // to avoid flooding a conversation with unrelated files
      const scored = files
        .filter(f => !seenIds.has(f.id))
        .map(f => ({ file: f, mimeScore: this._scoreMimeMatch([label], f.mimeType) }))
        .sort((a, b) => b.mimeScore - a.mimeScore);

      // Only take top 1 if multiple results — be conservative
      const take = files.length === 1 ? scored : scored.slice(0, 1);

      for (const { file, mimeScore } of take) {
        if (seenIds.has(file.id)) continue;
        seenIds.add(file.id);

        const confidence = files.length === 1
          ? Math.round(((mimeScore * 0.5) + 0.5) * 100) / 100  // single = high confidence
          : Math.round(((mimeScore * 0.4) + 0.3) * 100) / 100; // multiple = lower confidence

        results.push({
          fileName:     file.name,
          driveFileId:  file.id,
          mimeType:     file.mimeType,
          webViewLink:  file.webViewLink || null,
          confidence,
          matchedLabel: label,
          source:       'drive_fulltext',
          _meta:        file,
        });
      }

      if (files.length === 0) {
        logger.warn(`FileCorrelator: no Drive file found for label "${label}" (keywords: ${keywords.join(', ')})`);
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Search Drive using fullText contains query with optional MIME type filter.
   * fullText searches file content AND title — so "Google Cloud ADK" in a PDF body will match.
   * Results cached within the migration run.
   */
  async _searchDriveFullText(searchTerm, mimeFilter = null) {
    const cacheKey = `ft:${this.ownerEmail}:${searchTerm.toLowerCase()}:${mimeFilter||''}`;
    if (this._searchCache.has(cacheKey)) return this._searchCache.get(cacheKey);

    try {
      const escaped = searchTerm.replace(/'/g, "\\'");
      let q = `fullText contains '${escaped}' and '${this.ownerEmail}' in owners and trashed = false`;
      if (mimeFilter) q += ` and mimeType = '${mimeFilter}'`;

      const res = await this.drive.files.list({
        q,
        fields: 'files(id,name,mimeType,size,webViewLink,createdTime,modifiedTime)',
        pageSize: 5,
        supportsAllDrives: true,
        orderBy: 'modifiedTime desc',
      });
      const files = res.data.files || [];
      logger.info(`FileCorrelator: fullText search "${searchTerm}"${mimeFilter ? ` (${mimeFilter})` : ''} → ${files.length} result(s): ${files.map(f=>f.name).join(', ')}`);
      this._searchCache.set(cacheKey, files);
      return files;
    } catch (err) {
      logger.warn(`FileCorrelator: Drive fullText search failed for "${searchTerm}": ${err.message}`);
      this._searchCache.set(cacheKey, []);
      return [];
    }
  }

  /**
   * Get Drive file metadata by ID, cached.
   */
  async _getFileMetadata(docId) {
    if (this._metadataCache.has(docId)) return this._metadataCache.get(docId);
    try {
      const res = await this.drive.files.get({
        fileId: docId,
        fields: 'id,name,mimeType,size,webViewLink,thumbnailLink,createdTime,modifiedTime,trashed',
        supportsAllDrives: true,
      });
      this._metadataCache.set(docId, res.data);
      return res.data;
    } catch (err) {
      if (err.code === 404 || err.status === 404) {
        logger.info(`FileCorrelator: file ${docId} not found (may be deleted)`);
      } else {
        logger.warn(`FileCorrelator: Drive metadata failed for ${docId}: ${err.message}`);
      }
      this._metadataCache.set(docId, null);
      return null;
    }
  }

  /**
   * Score MIME type match between Gemini label hints and actual Drive MIME type.
   */
  _scoreMimeMatch(geminiLabels, mimeType) {
    if (!mimeType || !geminiLabels || geminiLabels.length === 0) return 0.5;

    const mime = mimeType.toLowerCase();
    const labelStr = geminiLabels.join(' ').toLowerCase();

    if (/\bpdf\b/.test(labelStr) && mime === 'application/pdf') return 1.0;
    if (/\bgoogle\s*doc\b|\bdoc\b/.test(labelStr) && mime.includes('google-apps.document')) return 1.0;
    if (/\bgoogle\s*sheet\b|\bsheet\b|\bspreadsheet\b/.test(labelStr) && mime.includes('google-apps.spreadsheet')) return 1.0;
    if (/\bgoogle\s*slide\b|\bslide\b|\bpresentation\b/.test(labelStr) && mime.includes('google-apps.presentation')) return 1.0;
    if (/\bcsv\b/.test(labelStr) && (mime === 'text/csv' || mime.includes('spreadsheet'))) return 1.0;
    if (/\bxlsx?\b|\bexcel\b/.test(labelStr) && mime.includes('spreadsheet')) return 1.0;
    if (/\bdocx?\b|\bword\b/.test(labelStr) && mime.includes('wordprocessingml')) return 1.0;
    if (/\bpptx?\b|\bpowerpoint\b/.test(labelStr) && mime.includes('presentationml')) return 1.0;
    if (/\bimage\b|\bjpeg?\b|\bpng\b/.test(labelStr) && mime.startsWith('image/')) return 1.0;

    if (/\bpdf\b/.test(labelStr) || mime === 'application/pdf') return 0.7;
    if (/\bdoc\b/.test(labelStr) && mime.includes('google-apps')) return 0.7;

    return 0.5;
  }

  /**
   * Score how well Gemini response labels match a Drive file name.
   */
  _scoreLabelMatch(geminiLabels, fileName, docTitle) {
    if (!geminiLabels || geminiLabels.length === 0) return 0.5;

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const fileNorm = normalize(fileName);
    const docNorm  = normalize(docTitle);

    let best = 0;
    for (const label of geminiLabels) {
      const labelNorm = normalize(label);

      if (labelNorm === fileNorm || labelNorm === docNorm) { best = 1.0; break; }
      if (fileNorm.includes(labelNorm) || labelNorm.includes(fileNorm)) { best = Math.max(best, 0.9); continue; }
      if (docNorm.includes(labelNorm)  || labelNorm.includes(docNorm))  { best = Math.max(best, 0.85); continue; }

      const labelWords = labelNorm.split(' ').filter(w => w.length > 2);
      const fileWords  = new Set(fileNorm.split(' ').filter(w => w.length > 2));
      const docWords   = new Set(docNorm.split(' ').filter(w => w.length > 2));

      if (labelWords.length === 0) { best = Math.max(best, 0.3); continue; }

      const fileMatches = labelWords.filter(w => fileWords.has(w)).length;
      const docMatches  = labelWords.filter(w => docWords.has(w)).length;
      const ratio = Math.max(fileMatches, docMatches) / labelWords.length;
      best = Math.max(best, ratio * 0.8);
    }

    return Math.round(best * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Extract Gemini-style descriptive file labels from response text.
 * E.g. "**Google Cloud ADK (PDF)**" → ["Google Cloud ADK (PDF)"]
 */
function _extractGeminiLabels(text) {
  if (!text) return [];
  const labels = new Set();

  // Bold headings with type hint: **Some File Name (PDF)**
  const boldPattern = /\*\*([^*\n]{2,80})\*\*/g;
  let m;
  while ((m = boldPattern.exec(text)) !== null) {
    const raw = m[1].trim().replace(/^\d+\.\s+/, '');
    if (/\bPDF\b|\bDoc\b|\bCSV\b|\bXLSX?\b|\bPPTX?\b|\bSheet\b|\bSlide\b|\bImage\b/i.test(raw)) {
      labels.add(raw);
    }
  }

  // Inline references: "uploaded document 'Foo Bar'"
  const inlinePattern = /(?:uploaded|attached|provided)\s+(?:file|document)\s+['"]([^'"]{2,80})['"]/gi;
  while ((m = inlinePattern.exec(text)) !== null) {
    labels.add(m[1].trim());
  }

  return [...labels];
}

/**
 * Extract meaningful keywords from a Gemini label for fullText search.
 * "Google Cloud ADK (PDF)" → ["Google", "Cloud", "ADK"]
 * Strips type hints and short stop words, returns longest meaningful terms.
 */
function _labelToKeywords(label) {
  const STOP = new Set(['the','and','for','with','from','this','that','are','was','has','its','our','your','their','create','download','file','document','pdf','csv','doc','data']);
  const TYPE_HINTS = /\b(PDF|Google Doc|Google Sheet|Google Slide|CSV|XLSX?|PPTX?|Doc|Sheet|Slide|Image|Drawing|Form)\b/gi;

  // Reject labels that look like UI instructions, not filenames
  // e.g. "File > Download > Comma Separated Values (.csv)", "`.csv`", "Instructions to Create..."
  if (/[`>]/.test(label)) return []; // UI path notation — not a filename
  if (/^instructions?\s+to\s+/i.test(label)) return []; // instructional text
  if (label.length < 5) return [];

  const clean = label
    .replace(TYPE_HINTS, '')
    .replace(/[()[\].,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w.toLowerCase()));

  // Need at least 2 meaningful words to avoid overly broad searches
  if (words.length < 2) return [];

  return words.slice(0, 3); // max 3 keywords — tighter than before
}

/**
 * Extract Drive MIME type filter from Gemini label type hint.
 * "Google Cloud ADK (PDF)" → "application/pdf"
 * "Hyperlinks Showcase (Google Doc)" → "application/vnd.google-apps.document"
 */
function _labelToMimeFilter(label) {
  const l = label.toLowerCase();
  if (/\bpdf\b/.test(l))                         return 'application/pdf';
  if (/\bgoogle\s*doc\b|\(doc\)/.test(l))        return 'application/vnd.google-apps.document';
  if (/\bgoogle\s*sheet\b|\(sheet\)/.test(l))    return 'application/vnd.google-apps.spreadsheet';
  if (/\bgoogle\s*slide\b|\(slide\)/.test(l))    return 'application/vnd.google-apps.presentation';
  if (/\bcsv\b/.test(l))                          return 'text/csv';
  if (/\bxlsx?\b|\bexcel\b/.test(l))             return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\bdocx?\b|\bword\b/.test(l))              return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\bpptx?\b|\bpowerpoint\b/.test(l))        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return null;
}
