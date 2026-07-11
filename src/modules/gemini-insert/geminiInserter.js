/**
 * geminiInserter.js
 * Inserts conversations directly into Gemini's conversation sidebar
 * using the StreamGenerate internal API, captured via Playwright.
 *
 * Flow:
 *  1. Launch Playwright with per-user persistent profile (user signs in once)
 *  2. Navigate to gemini.google.com/app
 *  3. Auto-send probe "Hi" via UI → intercept StreamGenerate → capture at + session params
 *  4. For each conversation: POST to StreamGenerate (new conv each time)
 *  5. Return results with conversation IDs
 */

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const STREAM_ENDPOINT = 'BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const PROFILES_DIR    = path.join(os.tmpdir(), 'gemini-cfz-profiles');

fs.mkdirSync(PROFILES_DIR, { recursive: true });

/**
 * Get the persistent profile path for a given appUserId.
 */
export function getProfileDir(appUserId) {
  // 'demo' (unauthenticated) gets a shared but uniquely-named profile to avoid lock conflicts
  if (!appUserId || appUserId === 'demo') {
    return path.join(PROFILES_DIR, 'user-demo');
  }
  return path.join(PROFILES_DIR, `user-${appUserId}`);
}

/**
 * Delete the profile for a user (forces re-auth next run).
 */
export function deleteProfile(appUserId) {
  const dir = getProfileDir(appUserId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Format a conversation object into a single message string for Gemini.
 * @param {object} conv - { title, messages: [{role, content}] }
 */
function formatConversationMessage(conv) {
  const lines = [`[Migrated Conversation: ${conv.title || 'Untitled'}]\n`];
  if (conv.date) lines.push(`Date: ${conv.date}\n`);
  lines.push('');
  for (const msg of (conv.messages || [])) {
    const speaker = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${speaker}: ${msg.content}`);
    lines.push('');
  }
  lines.push('Please acknowledge this migrated conversation.');
  return lines.join('\n');
}

/**
 * Build a new f.req body from a captured inner array, replacing message + resetting conv IDs.
 */
function buildRequestBody(inner, message, atToken) {
  const payload = JSON.parse(JSON.stringify(inner)); // deep clone

  // Replace message text
  if (Array.isArray(payload[0])) {
    payload[0][0] = message;
  } else {
    payload[0] = [message, 0, null, null, null, null, 0];
  }

  // Reset conversation IDs → new conversation
  if (Array.isArray(payload[2])) {
    payload[2] = payload[2].map((v, i) => (i < 3 ? '' : null));
  }

  const bodyParams = { 'f.req': JSON.stringify([null, JSON.stringify(payload)]) };
  if (atToken) bodyParams['at'] = atToken;
  return new URLSearchParams(bodyParams).toString();
}

/**
 * POST one conversation to Gemini StreamGenerate via page.evaluate (inherits browser cookies).
 */
async function postToGemini(page, captured, message) {
  const { url: capturedUrl, atToken, inner, headers } = captured;

  const parsedUrl = new URL(capturedUrl);
  parsedUrl.searchParams.set('_reqid', String(Math.floor(Math.random() * 9000000) + 1000000));
  const newUrl = parsedUrl.toString();

  const body = buildRequestBody(inner, message, atToken);

  const result = await page.evaluate(async ({ url, body, headers }) => {
    const safe = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!['cookie', 'content-length', 'host'].includes(k.toLowerCase())) safe[k] = v;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: safe,
        body,
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    } catch (e) {
      return { status: 0, ok: false, text: String(e) };
    }
  }, { url: newUrl, body, headers });

  // Extract conversation ID from response
  const convIdMatch = result.text.match(/"(c_[a-f0-9]+)"/);
  const convId = convIdMatch ? convIdMatch[1] : null;

  return { ...result, convId };
}

/**
 * Main inserter — launches browser, captures session, posts all conversations.
 *
 * @param {object} opts
 * @param {string}   opts.appUserId        - user ID for profile isolation
 * @param {Array}    opts.conversations    - [{ title, messages: [{role, content}], date? }]
 * @param {Function} opts.onLog            - (type, message) => void  (type: info|success|warn|error|progress|done)
 * @param {Function} opts.onProgress       - ({ done, total, convId, title }) => void
 * @param {boolean}  [opts.headless=false] - set true for VNC/server; false shows browser to user
 * @returns {Promise<{ inserted: number, failed: number, results: Array }>}
 */
export async function insertConversationsToGemini(opts) {
  const {
    appUserId,
    conversations = [],
    onLog = () => {},
    onProgress = () => {},
    headless = false,
  } = opts;

  if (!conversations.length) {
    onLog('warn', 'No conversations to insert');
    return { inserted: 0, failed: 0, results: [] };
  }

  const profileDir = getProfileDir(appUserId);
  fs.mkdirSync(profileDir, { recursive: true });

  onLog('info', `Launching Gemini browser (profile: ${path.basename(profileDir)})...`);

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: null,
      args: ['--start-maximized', '--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    // Profile may be locked by a previous crashed run — delete and retry once
    onLog('warn', `Browser launch failed (${e.message}) — clearing profile and retrying...`);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(profileDir, { recursive: true });
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: null,
        args: ['--start-maximized', '--no-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (e2) {
      onLog('error', `Failed to launch browser after retry: ${e2.message}`);
      throw e2;
    }
  }

  const page = await context.newPage();

  // ── Intercept StreamGenerate ──────────────────────────────────────────────────
  let captured = null;

  page.on('request', req => {
    if (captured) return; // only capture first (probe)
    const url = req.url();
    if (!url.includes(STREAM_ENDPOINT)) return;
    const body = req.postData() || '';
    const fReqMatch = body.match(/f\.req=([^&]*)/);
    if (!fReqMatch) return;

    const atMatch = body.match(/(?:^|&)at=([^&]+)/);
    const atToken = atMatch ? decodeURIComponent(atMatch[1]) : null;

    let inner = null;
    try {
      const outer = JSON.parse(decodeURIComponent(fReqMatch[1]));
      inner = JSON.parse(outer[1]);
    } catch { return; }

    captured = { url, atToken, inner, headers: req.headers() };
    onLog('info', `Session captured${atToken ? ' (with at token)' : ' (cookie auth)'}`);
  });

  try {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'load', timeout: 60000 });
    onLog('info', 'Gemini loaded — checking auth state...');

    // ── Wait for authenticated state (up to 3 min) ──────────────────────────────
    // Auth detection: Gemini redirects unauthenticated users to /signin or shows
    // a landing page. When authenticated, URL stays at /app and sidebar renders.
    // We check: URL is /app AND (sidebar nav exists OR StreamGenerate endpoint accessible).
    let input = null;
    let isAuthed = false;

    for (let i = 0; i < 180; i++) {
      const url = page.url().catch ? await page.url() : page.url();

      // Log every 10s
      if (i % 10 === 0) {
        const info = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          // Check for known authenticated-only elements
          hasSideNav: !!document.querySelector('bard-sidenav, mat-sidenav, [data-test-id="new-chat-button"], .conversations-container, side-navigation-v2'),
          hasRichTextarea: !!document.querySelector('rich-textarea'),
          // Unauthenticated page has "Sign in" in h1/h2 or a prominent CTA
          bodySnippet: document.body?.innerText?.slice(0, 200).replace(/\n/g,' ') || '',
        })).catch(() => ({ url, title: '', hasSideNav: false, hasRichTextarea: false, bodySnippet: '' }));
        onLog('info', `[${i}s] ${JSON.stringify(info)}`);
      }

      // If redirected away from /app → not authenticated yet
      if (!url.includes('gemini.google.com/app')) {
        if (i % 15 === 0) onLog('info', `Waiting for sign-in... url=${url} (${i}s)`);
        await page.waitForTimeout(1000).catch(() => {});
        continue;
      }

      // On /app — check for authenticated-only sidebar elements
      const authState = await page.evaluate(() => {
        const sideNav = document.querySelector('bard-sidenav, mat-sidenav, [data-test-id="new-chat-button"], .conversations-container, side-navigation-v2, nav[aria-label]');
        const richTextarea = document.querySelector('rich-textarea');
        const userMenu = document.querySelector('[aria-label*="Google Account"], [data-ogsr-up], .gb_d');
        // Unauthenticated /app shows "Sign in to use Gemini" or similar h1
        const h1 = document.querySelector('h1, h2');
        const hasSignInHeading = h1 && /sign in/i.test(h1.innerText || '');
        return { sideNav: !!sideNav, richTextarea: !!richTextarea, userMenu: !!userMenu, hasSignInHeading };
      }).catch(() => ({ sideNav: false, richTextarea: false, userMenu: false, hasSignInHeading: false }));

      if (i % 10 === 0) onLog('info', `Auth state: ${JSON.stringify(authState)}`);

      if (authState.hasSignInHeading) {
        if (i % 15 === 0) onLog('info', `Please sign in to Gemini in the browser window... (${i}s elapsed)`);
        await page.waitForTimeout(1000).catch(() => {});
        continue;
      }

      if (authState.sideNav || authState.userMenu) {
        isAuthed = true;
        onLog('info', `Authenticated! (sideNav=${authState.sideNav} userMenu=${authState.userMenu})`);
        break;
      }

      // Fallback: on /app, no sign-in heading, richTextarea present → likely authed
      if (authState.richTextarea && i > 10) {
        isAuthed = true;
        onLog('info', `Authenticated (fallback — richTextarea on /app after ${i}s)`);
        break;
      }

      await page.waitForTimeout(1000).catch(() => {});
    }

    if (!isAuthed) {
      onLog('error', 'Timed out waiting for Gemini sign-in. Please reset profile and try again.');
      await context.close();
      return { inserted: 0, failed: conversations.length, results: [] };
    }

    await page.waitForTimeout(1500).catch(() => {});

    // Find chat input
    const candidates = await page.$$('[contenteditable="true"]').catch(() => []);
    for (const el of candidates) {
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width > 100 && box.height > 20) { input = el; break; }
    }
    if (!input) input = await page.$('rich-textarea').catch(() => null);

    if (!input) {
      onLog('error', 'Authenticated but chat input not found. Gemini UI may have changed.');
      await context.close();
      return { inserted: 0, failed: conversations.length, results: [] };
    }

    onLog('info', 'Chat input found — sending probe message...');

    // Send probe to capture session params
    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.type('Hi', { delay: 30 });
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');

    // Wait for capture
    const deadline = Date.now() + 20000;
    while (!captured && Date.now() < deadline) await page.waitForTimeout(500);

    if (!captured) {
      onLog('error', 'StreamGenerate request not captured. Gemini may have changed its API.');
      await context.close();
      return { inserted: 0, failed: conversations.length, results: [] };
    }

    // Wait for probe response
    await page.waitForTimeout(4000);
    onLog('info', `Starting insertion of ${conversations.length} conversation(s)...`);

    // ── Insert each conversation ────────────────────────────────────────────────
    const results = [];
    let inserted = 0;
    let failed = 0;

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      const message = formatConversationMessage(conv);
      onLog('info', `[${i + 1}/${conversations.length}] Inserting: "${conv.title || 'Untitled'}"...`);

      try {
        const result = await postToGemini(page, captured, message);

        if (result.ok) {
          inserted++;
          onLog('success', `✅ [${i + 1}/${conversations.length}] "${conv.title}" → Gemini (convId: ${result.convId || 'ok'})`);
          results.push({ title: conv.title, status: 'success', convId: result.convId, httpStatus: result.status });
        } else {
          failed++;
          onLog('warn', `❌ [${i + 1}/${conversations.length}] "${conv.title}" failed: HTTP ${result.status}`);
          results.push({ title: conv.title, status: 'failed', error: `HTTP ${result.status}`, httpStatus: result.status });
        }
      } catch (e) {
        failed++;
        onLog('warn', `❌ [${i + 1}/${conversations.length}] "${conv.title}" error: ${e.message}`);
        results.push({ title: conv.title, status: 'failed', error: e.message });
      }

      onProgress({ done: i + 1, total: conversations.length, title: conv.title });

      // Pace requests — avoid rate limiting
      if (i < conversations.length - 1) await page.waitForTimeout(2000);
    }

    onLog(failed === 0 ? 'done' : 'warn',
      `Completed: ${inserted} inserted, ${failed} failed out of ${conversations.length} conversations`
    );

    return { inserted, failed, results };

  } finally {
    await context.close().catch(() => {});
  }
}
