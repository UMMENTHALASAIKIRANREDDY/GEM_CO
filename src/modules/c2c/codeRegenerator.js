/**
 * C2C — Regenerate Copilot Analysis-tool files by re-running the Python the
 * AI executed.
 *
 * Why this exists: Microsoft Copilot's Analysis tool generates files via a
 * Python sandbox and only exposes the resulting bytes via `asyncgw.teams.
 * microsoft.com/...` URLs that require an authenticated Teams browser session
 * to download. Server-side migration tools can't replicate that auth.
 *
 * However, the Graph API DOES return the Python source code Copilot executed,
 * embedded in the adaptive card attached to the AI response. So instead of
 * downloading the asyncgw output, we extract the code and re-execute it
 * locally — Microsoft can't lock the chat memory, but they hand us the recipe.
 *
 * The Python runs in a per-call temp directory, with `/mnt/data/` paths
 * remapped to that dir, and is killed after a timeout. No network access is
 * enforced — that's a future hardening (Docker sandbox).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('c2c:code-regen');

// Per-Python-block timeout. Kept aggressive (20s) so a single hanging block
// can't block downstream work like DOCX/OneNote conversation upload, which is
// the most important migration output. Bump via env var if needed.
const PYTHON_TIMEOUT_MS = parseInt(process.env.PYTHON_BLOCK_TIMEOUT_MS || '20000', 10);
const PYTHON_BIN = process.env.C2C_PYTHON_BIN || 'python';

/**
 * Walk one adaptive card recursively and collect Python source from TextRun/
 * TextBlock nodes. Copilot embeds executed code inside the "Coding and
 * executing" card section as plain text. We detect Python by checking for
 * common Python keywords.
 */
function _walkCardForPython(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.text === 'string') {
    const txt = node.text;
    // Primary signal: any text mentioning /mnt/data is Analysis-tool Python.
    // Fallback: classic Python keywords at line start.
    if (
      txt.includes('/mnt/data') ||
      /(^|\n)\s*(from\s+\w|import\s+\w|def\s+\w|with\s+open\(|Path\(|pd\.|json\.dump|yaml\.dump)/.test(txt)
    ) {
      out.push(txt);
    }
  }
  for (const k of ['body', 'items', 'columns', 'actions', 'inlines', 'facts', 'elements', 'card', 'attachments']) {
    const v = node[k];
    if (Array.isArray(v)) for (const child of v) _walkCardForPython(child, out);
    else if (v && typeof v === 'object') _walkCardForPython(v, out);
  }
}

/**
 * Extract all Python code blocks from one OR many interactions' adaptive card
 * attachments. Copilot often splits a single Analysis-tool turn into TWO
 * separate interactions in the same session: one carries the "Coding and
 * executing" card with the Python source, the other carries the response
 * card with the resulting asyncgw download URL. So when we need to regen,
 * we walk the WHOLE session to find the code — not just the interaction
 * that referenced the asyncgw URL.
 *
 * @param {object|object[]} interactionOrItems  single interaction OR array
 */
export function extractPythonCodeBlocks(interactionOrItems) {
  const items = Array.isArray(interactionOrItems) ? interactionOrItems : [interactionOrItems];
  const blocks = [];
  for (const interaction of items) {
    for (const att of (interaction?.attachments || [])) {
      if (att.contentType !== 'application/vnd.microsoft.card.adaptive' || !att.content) continue;
      let card;
      try { card = typeof att.content === 'string' ? JSON.parse(att.content) : att.content; }
      catch { continue; }
      _walkCardForPython(card, blocks);
    }
  }
  // De-duplicate (same code can appear multiple times in nested elements)
  const seen = new Set();
  return blocks.filter(b => {
    const key = b.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Defensive preprocessor for any Python source we re-execute.
 *
 * Used by Copilot regen (C2C, C2G) and Gemini regen (G2C, G2G). Catches
 * every export-format quirk that causes spurious first-run failures:
 *
 *   1) Leading whitespace from XML pretty-print  → IndentationError
 *   2) Smart quotes (' ' " ")                    → SyntaxError invalid char
 *   3) Em / en dashes (— –) in code              → SyntaxError invalid char
 *   4) Non-breaking spaces (U+00A0)              → spurious IndentationError
 *   5) Byte Order Mark at start                  → SyntaxError on line 1
 *   6) Windows CRLF line endings                 → normalize for consistency
 *   7) Zero-width chars (U+200B, U+FEFF, …)      → invisible breakage
 */
export function sanitizePythonCode(rawCode) {
  if (typeof rawCode !== 'string') return rawCode;
  let code = rawCode;
  if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1);
  code = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Smart quotes → straight
  code = code.replace(/[‘’‚‛]/g, "'");
  code = code.replace(/[“”„‟]/g, '"');
  // Em / en dashes → ASCII hyphen
  code = code.replace(/[—–]/g, '-');
  // NBSP → regular space
  code = code.replace(/ /g, ' ');
  // Zero-width chars
  code = code.replace(/[​‌‍⁠﻿]/g, '');
  // Common leading-whitespace prefix dedent
  const lines = code.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length) {
    let prefix = nonEmpty[0].match(/^[ \t]*/)[0];
    for (let i = 1; i < nonEmpty.length && prefix; i++) {
      const cur = nonEmpty[i].match(/^[ \t]*/)[0];
      while (prefix && !cur.startsWith(prefix)) prefix = prefix.slice(0, -1);
    }
    if (prefix) code = lines.map(l => l.startsWith(prefix) ? l.slice(prefix.length) : l).join('\n');
  }
  return code;
}

/**
 * Classify Python stderr into a short, customer-readable reason for
 * migration reports. Used by both Copilot and Gemini regen paths.
 *
 * The wording is chosen so the customer reads it and immediately knows
 * whether it's something they can do anything about (e.g. add a library,
 * fix their data) vs. a Vault / Graph export limitation (the file was
 * never recoverable to begin with).
 */
export function classifyPythonError(stderr) {
  if (typeof stderr !== 'string') return 'unknown';
  if (/IndentationError/i.test(stderr)) return 'invalid Python code (indentation)';
  if (/SyntaxError.*invalid character/i.test(stderr)) return 'invalid Python code (smart quotes in source)';
  if (/SyntaxError/i.test(stderr)) return 'invalid Python code (syntax)';
  if (/ModuleNotFoundError|No module named/i.test(stderr)) {
    const m = stderr.match(/No module named ['"]?([^'"\s]+)/i);
    return m ? `missing Python library: ${m[1]}` : 'missing Python library';
  }
  if (/PermissionError/i.test(stderr)) return 'permission denied';
  // FileNotFoundError almost always means: the conversation referenced
  // a file the user had uploaded (e.g. data.csv) — Google Vault / MS
  // Graph does NOT export user-uploaded session files, only the
  // conversation transcript. The file was never recoverable. Phrase
  // it that way so the customer doesn't think the tool is broken.
  if (/FileNotFoundError/i.test(stderr)) return 'original input file not available (Vault / Copilot export does not include user-uploaded session files)';
  if (/NameError/i.test(stderr)) return 'incomplete code in conversation (variable not defined)';
  if (/KeyError/i.test(stderr)) return 'incomplete code in conversation (missing data key)';
  if (/ConnectionError|HTTPError|URLError|timeout/i.test(stderr)) return 'code requires network credentials we cannot replay';
  if (/Killed|SIGKILL/i.test(stderr)) return 'code took too long to run (timeout)';
  return 'code execution error';
}

/**
 * Run a Python source string in a temp working directory.
 *  - /mnt/data/* paths are remapped to the temp dir
 *  - Process is killed after PYTHON_TIMEOUT_MS
 *  - Stdout/stderr captured
 *
 * Returns { workDir, exitCode, stdout, stderr, files: [{name, size, fullPath}] }
 */
export async function runPythonAndCaptureOutputs(pythonCode, existingWorkDir = null) {
  const workDir = existingWorkDir || fs.mkdtempSync(path.join(os.tmpdir(), 'c2c-regen-'));
  // Defensive preprocessing — every Python block that flows through this
  // sandbox (from Copilot, Gemini, anywhere) gets normalized so common
  // export quirks (XML indent, smart quotes, em dashes, BOM, NBSP, CRLF)
  // don't cause spurious failures on the first run.
  const sanitized = sanitizePythonCode(pythonCode);
  const patched = sanitized.replace(/\/mnt\/data/g, workDir.replace(/\\/g, '/'));
  const scriptPath = path.join(workDir, '_copilot_code.py');
  fs.writeFileSync(scriptPath, patched);

  const result = await new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [scriptPath], {
      cwd: workDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), PYTHON_TIMEOUT_MS);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\nspawn error: ' + e.message });
    });
  });

  // Walk workDir and collect every produced file (skip the script we wrote)
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '_copilot_code.py') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ name: entry.name, size: fs.statSync(full).size, fullPath: full });
    }
  })(workDir);

  return { workDir, ...result, files };
}

/**
 * High-level convenience: given one interaction OR an array of session items,
 * extract code blocks and regenerate.
 *
 * Sessions often contain MULTIPLE code blocks across separate Analysis-tool
 * turns (e.g. one turn produces a CSV, the next produces a YAML, the next
 * produces an HTML). We run EVERY distinct code block in the same temp dir
 * so all their file outputs accumulate together. Failures in any one block
 * are logged but don't stop the others — we want to capture as many files as
 * possible across the session.
 */
export async function regenerateFilesFromInteraction(interactionOrItems) {
  const blocks = extractPythonCodeBlocks(interactionOrItems);
  if (blocks.length === 0) return null;

  const idForLog = Array.isArray(interactionOrItems)
    ? `session ${interactionOrItems[0]?.sessionId?.slice(0, 20) || '?'}`
    : `interaction ${interactionOrItems?.id || '?'}`;

  // Run each code block sequentially in the SAME workDir so outputs accumulate.
  // We grab the workDir from the first run and reuse it for subsequent ones.
  let workDir = null;
  let combinedStdout = '', combinedStderr = '';
  const exitCodes = [];

  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i];
    const ran = await runPythonAndCaptureOutputs(code, workDir);
    if (!workDir) workDir = ran.workDir;
    combinedStdout += `--- block ${i} (exit=${ran.exitCode}) ---\n` + (ran.stdout || '') + '\n';
    combinedStderr += `--- block ${i} (exit=${ran.exitCode}) ---\n` + (ran.stderr || '') + '\n';
    exitCodes.push(ran.exitCode);
  }

  // Walk the (now-accumulated) workDir for everything every block produced
  const files = [];
  if (workDir) {
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '_copilot_code.py') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ name: entry.name, size: fs.statSync(full).size, fullPath: full });
      }
    })(workDir);
  }

  const overallExit = exitCodes.every(c => c === 0) ? 0 : (exitCodes.find(c => c !== 0) || -1);
  const blockSizes = blocks.map(b => b.length).join(',');
  const fileList = files.map(f => f.name).join(', ');
  logger.info(`Regenerated ${files.length} file(s) [${fileList}] from ${idForLog} across ${blocks.length} block(s) sizes=[${blockSizes}] (exits=${exitCodes.join(',')}) in ${workDir}`);
  if (combinedStderr.trim()) logger.warn(`Regen stderr from ${idForLog}: ${combinedStderr.trim().slice(0, 800)}`);
  return { codeBlocks: blocks, workDir, exitCode: overallExit, stdout: combinedStdout, stderr: combinedStderr, files };
}

/**
 * Best-effort match of a generated file to an expected name (e.g. from an
 * asyncgw URL that mentioned "sample.csv"). Returns the matched file metadata
 * or null.
 */
export function pickRegeneratedFileByName(regenResult, expectedName) {
  if (!regenResult?.files || !expectedName) return null;
  const target = expectedName.toLowerCase();
  // Exact match first
  let f = regenResult.files.find(f => f.name.toLowerCase() === target);
  if (f) return f;
  // Suffix / basename match
  f = regenResult.files.find(f => target.endsWith(f.name.toLowerCase()) || f.name.toLowerCase().endsWith(target));
  return f || null;
}

/**
 * Cleanup the temp working directory once we're done uploading files.
 */
export function cleanupRegen(regenResult) {
  if (!regenResult?.workDir) return;
  try { fs.rmSync(regenResult.workDir, { recursive: true, force: true }); }
  catch (e) { logger.warn(`Cleanup ${regenResult.workDir} failed: ${e.message}`); }
}
