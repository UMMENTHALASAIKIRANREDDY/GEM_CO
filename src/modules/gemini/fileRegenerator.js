/**
 * Gemini — Recover files that Gemini generated INSIDE the chat response.
 *
 * The Gemini Vault export exposes conversation text only — no file
 * attachments. But when Gemini generates a file for the user, the response
 * text contains one of two recoverable patterns:
 *
 *   1) INLINE DATA — Gemini writes the file content directly in a fenced
 *      code block: ```csv ... ```, ```json ... ```, ```html ... ```,
 *      ```yaml ... ```. We extract the fence body and write it as a file.
 *
 *   2) GENERATED VIA PYTHON — Gemini writes Python source in a fence tagged
 *      ```python?code_reference&code_event_index=N``` and immediately
 *      after the response includes [file-tag: code-generated-file-K-<id>]
 *      markers proving Gemini executed the code in its sandbox. We
 *      re-execute the same Python locally and capture whatever files it
 *      writes (PDF, XLSX, etc.).
 *
 * What we CANNOT recover from Vault:
 *   - Files the user uploaded into chat (only mentioned, never bytes)
 *   - Generated images / videos (Vault stores opaque googleusercontent URLs)
 *   - Canvas Docs / Sheets / Slides (URL-only; if saved to Drive, the
 *     existing FileCorrelator handles them via Drive audit logs)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { runPythonAndCaptureOutputs, classifyPythonError } from '../c2c/codeRegenerator.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('gemini:fileRegen');

// Map fenced-block language → file extension + MIME for inline-data path.
const INLINE_LANG_MAP = {
  csv:        { ext: '.csv',  mime: 'text/csv' },
  json:       { ext: '.json', mime: 'application/json' },
  yaml:       { ext: '.yaml', mime: 'application/x-yaml' },
  yml:        { ext: '.yml',  mime: 'application/x-yaml' },
  html:       { ext: '.html', mime: 'text/html' },
  xml:        { ext: '.xml',  mime: 'application/xml' },
  sql:        { ext: '.sql',  mime: 'application/sql' },
  markdown:   { ext: '.md',   mime: 'text/markdown' },
  md:         { ext: '.md',   mime: 'text/markdown' },
};

/**
 * Phase 1 — pull inline data fences out of one response text and turn each
 * into a file. The fences must contain enough content to be useful (a few
 * non-empty lines) — we drop tiny snippets that are just examples.
 *
 * Returns [{ name, mime, buffer, sourceTag }]
 */
export function extractInlineFiles(responseText, { convTitle = 'gemini' } = {}) {
  const out = [];
  if (typeof responseText !== 'string' || !responseText) return out;

  // Match ```<lang> ... ``` fences. Gemini's Vault exports often DON'T close
  // the fence — they trail off with [cite_start] markers or
  // http://googleusercontent.com/... citation URLs. So treat any of these
  // as a fence terminator: another ```, a [cite_start] marker, a
  // googleusercontent URL on its own line, or end-of-text.
  const fenceRe = /```([a-zA-Z]{2,12})[^\n]*\n([\s\S]*?)(?=\n[ \t]*```|\n[ \t]*\[cite_start\]|\n[ \t]*http:\/\/googleusercontent\.com|$)/g;
  let m;
  let idx = 0;
  while ((m = fenceRe.exec(responseText)) !== null) {
    const lang = m[1].toLowerCase();
    const mapping = INLINE_LANG_MAP[lang];
    if (!mapping) continue;
    // Vault XML pretty-prints content with leading indent — strip a common
    // leading whitespace prefix from every line so the file looks normal.
    const raw = m[2];
    const lines = raw.split('\n');
    const indent = _commonLeadingWhitespace(lines);
    const dedented = (indent
      ? lines.map(l => l.startsWith(indent) ? l.slice(indent.length) : l).join('\n')
      : raw).trim();
    if (!dedented) continue;
    const nonEmptyLines = dedented.split('\n').filter(l => l.trim()).length;
    if (nonEmptyLines < 2 && dedented.length < 40) continue;
    idx++;
    const safeBase = (convTitle || 'gemini').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const name = `${safeBase}_${idx}${mapping.ext}`;
    out.push({
      name,
      mime: mapping.mime,
      buffer: Buffer.from(dedented, 'utf8'),
      sourceTag: `inline-${lang}-${idx}`,
    });
  }
  return out;
}

/**
 * Defensive preprocessor — turns "code as Gemini wrote it into a Vault XML"
 * into "code that Python will actually run". Catches every known failure
 * mode we have empirical evidence for. Runs once per block; cheap.
 *
 * Failure modes addressed:
 *   1) Leading whitespace from Vault XML pretty-print  → IndentationError
 *   2) Smart/curly quotes (’ ‘ “ ”)                    → SyntaxError invalid char
 *   3) Em/en dashes (— –)                              → SyntaxError invalid char
 *   4) Non-breaking spaces (U+00A0) in code            → IndentationError
 *   5) Byte Order Mark (BOM) at start                  → SyntaxError
 *   6) Windows CRLF line endings                       → benign but normalize anyway
 *   7) Zero-width characters scattered through         → invisible breakage
 */
function _sanitizeForPython(rawCode) {
  let code = rawCode;
  // Strip BOM
  if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1);
  // Normalize line endings
  code = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Normalize smart quotes (curly) → straight quotes
  code = code.replace(/[‘’‚‛]/g, "'")  // ‘ ’ ‚ ‛
             .replace(/[“”„‟]/g, '"'); // “ ” „ ‟
  // Normalize em/en dashes — usually appear in comments not code, but Python
  // chokes on them as identifier chars if they leak into a literal. Replace
  // with ASCII hyphen.
  code = code.replace(/[—–]/g, '-'); // — –
  // Replace non-breaking spaces with regular spaces (Python's lexer treats
  // U+00A0 as a normal char but indentation engine doesn't recognize it,
  // → "unexpected indent")
  code = code.replace(/ /g, ' ');
  // Strip zero-width chars
  code = code.replace(/[​‌‍⁠﻿]/g, '');
  // Strip the leading whitespace prefix the Vault XML adds
  const lines = code.split('\n');
  const indent = _commonLeadingWhitespace(lines);
  if (indent) {
    code = lines.map(l => l.startsWith(indent) ? l.slice(indent.length) : l).join('\n');
  }
  return code;
}

// Find the longest common leading-whitespace prefix across non-empty lines.
function _commonLeadingWhitespace(lines) {
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length === 0) return '';
  let prefix = nonEmpty[0].match(/^[ \t]*/)[0];
  for (let i = 1; i < nonEmpty.length && prefix; i++) {
    const cur = nonEmpty[i].match(/^[ \t]*/)[0];
    while (prefix && !cur.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * Phase 2 — re-execute Python that Gemini ran in its sandbox.
 *
 * Detection: ```python?code_reference&code_event_index=N``` fence (Gemini's
 * unique tag) OR a regular ```python``` fence whose body contains a
 * file-writing call (.to_csv / write_pdf / with open(...) etc.).
 *
 * The conversation-level [file-tag: code-generated-file-K-<id>] markers are
 * additional confirmation but not required — if the Python block writes a
 * file, we run it regardless.
 *
 * Returns [{ name, mime, buffer, sourceTag, exitCode, stderr }] for each
 * file produced. One Python block can produce multiple files.
 */
const PYTHON_FENCE_RE = /```python(?:\?[^\n]*)?\n([\s\S]*?)(?=\n[ \t]*```|\n[ \t]*\[cite_start\]|\n[ \t]*http:\/\/googleusercontent\.com|$)/g;
const FILE_WRITE_HINTS = /\.to_csv\(|\.to_excel\(|\.to_json\(|ExcelWriter|with\s+open\(|\.write_pdf\(|\.write_text\(|json\.dump|yaml\.dump|savefig\(|\.save\(|HTML\([^)]*\)\.write|Document\(|zipfile\.ZipFile|tarfile\.open|shutil\.make_archive|Workbook\(\)|Presentation\(\)|FPDF\(|canvas\.Canvas|csv\.writer|csv\.DictWriter|Image\.open|Image\.new|cv2\.imwrite|imageio\.imwrite|wb\.save|doc\.save/i;

export async function regeneratePythonFiles(responseText) {
  const out = [];
  if (typeof responseText !== 'string' || !responseText) return out;

  const blocks = [];
  let m;
  while ((m = PYTHON_FENCE_RE.exec(responseText)) !== null) {
    // Sanitization happens inside runPythonAndCaptureOutputs now (shared
    // with Copilot regen). We still pre-check for file-writing intent so
    // we don't spawn Python for tutorial-only code.
    const rawCode = m[1];
    if (!FILE_WRITE_HINTS.test(rawCode)) continue;
    blocks.push(rawCode);
  }
  if (blocks.length === 0) return out;

  // Share ONE work directory across all blocks in this conversation so a
  // later block (e.g. zipfile) can find files written by earlier blocks
  // (e.g. openpyxl, docx). Gemini commonly chains: "create xlsx → create
  // docx → zip them both" — these only succeed if they share a workDir.
  let sharedWorkDir = null;
  const seenFiles = new Set(); // dedup files that appear in multiple block runs
  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i];
    try {
      const ran = await runPythonAndCaptureOutputs(code, sharedWorkDir);
      if (!sharedWorkDir) sharedWorkDir = ran.workDir;
      if (ran.files && ran.files.length > 0) {
        for (const f of ran.files) {
          // Skip the script and any directories
          if (f.name === '_copilot_code.py') continue;
          // Dedupe: shared workDir means files from earlier blocks re-appear
          // in later runs' file lists. Only push each unique fullPath once.
          if (seenFiles.has(f.fullPath)) continue;
          seenFiles.add(f.fullPath);
          out.push({
            name: f.name,
            mime: _guessMime(f.name),
            fullPath: f.fullPath,
            size: f.size,
            sourceTag: `python-block-${i}`,
            workDir: ran.workDir,
            exitCode: ran.exitCode,
          });
        }
      } else if (ran.exitCode !== 0) {
        // Surface failed regen as a structured error AND log so the
        // migration report shows it (instead of silently dropping).
        const reason = classifyPythonError(ran.stderr || '');
        logger.warn(`Python block ${i} exited with ${ran.exitCode} (${reason}): ${(ran.stderr || '').slice(0, 200)}`);
        out.push({
          _failed: true,
          sourceTag: `python-block-${i}-failed`,
          reason,
          stderr: (ran.stderr || '').slice(0, 500),
        });
      } else {
        // Exit 0 but no files produced — Python ran fine but didn't write
        // anything we caught. Surface so report shows it.
        logger.warn(`Python block ${i} ran successfully but produced 0 files (script may have only printed output)`);
        out.push({
          _failed: true,
          sourceTag: `python-block-${i}-emptyresult`,
          reason: 'ran but produced no files',
          stderr: (ran.stdout || '').slice(0, 200),
        });
      }
    } catch (e) {
      logger.warn(`Python block ${i} execution error: ${e.message}`);
      out.push({
        _failed: true,
        sourceTag: `python-block-${i}-error`,
        reason: 'execution error',
        stderr: e.message,
      });
    }
  }
  return out;
}

// classifyPythonError is now shared from c2c/codeRegenerator.js

function _guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.pdf':  'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.csv':  'text/csv',
    '.json': 'application/json',
    '.yaml': 'application/x-yaml',
    '.yml':  'application/x-yaml',
    '.html': 'text/html',
    '.xml':  'application/xml',
    '.txt':  'text/plain',
    '.md':   'text/markdown',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.zip':  'application/zip',
  })[ext] || 'application/octet-stream';
}

/**
 * High-level: process every turn in a conversation, collect every
 * recoverable file. Returns a flat list ready to upload.
 *
 *   { name, mime, buffer | fullPath, sourceTag, turnIndex, convTitle }
 *
 * Caller is responsible for uploading + then calling cleanupWorkDirs to
 * remove temp files from Python runs.
 */
export async function recoverFilesFromConversation(conv) {
  const recovered = [];
  const turns = conv?.turns || [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const response = turn?.response;
    if (!response) continue;

    // Phase 1 — inline data fences
    const inline = extractInlineFiles(response, { convTitle: conv.title });
    for (const f of inline) {
      recovered.push({ ...f, turnIndex: i, convTitle: conv.title });
    }

    // Phase 2 — Python regen
    const py = await regeneratePythonFiles(response);
    for (const f of py) {
      recovered.push({ ...f, turnIndex: i, convTitle: conv.title });
    }
  }
  return recovered;
}

/**
 * Best-effort cleanup of Python sandbox temp dirs from a recovered-files
 * list. Safe to call multiple times.
 */
export function cleanupWorkDirs(recovered) {
  const seen = new Set();
  for (const f of (recovered || [])) {
    if (!f.workDir || seen.has(f.workDir)) continue;
    seen.add(f.workDir);
    try { fs.rmSync(f.workDir, { recursive: true, force: true }); }
    catch (e) { logger.warn(`Cleanup ${f.workDir}: ${e.message}`); }
  }
}
