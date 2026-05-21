import express from 'express';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { parseStringPromise } from 'xml2js';
import { connectMongo, getDb } from '../../db/mongo.js';

const SESSION_DIR = process.env.SESSION_DIR || '.';
fs.mkdirSync(SESSION_DIR, { recursive: true });

function sessionFileFor(email) {
  const name = (!email || email === 'unknown')
    ? 'playwright-session.json'
    : `playwright-session-${email.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`;
  return path.join(SESSION_DIR, name);
}
const RS = '\x1e';

// WS session cache per user — avoid re-opening Copilot if token still fresh
const wsSessionCache = new Map(); // email → { session, capturedAt }
const WS_TTL_MS = 50 * 60 * 1000; // 50 min (WS JWT expires ~1hr)

function getCachedSession(email) {
  const entry = wsSessionCache.get(email);
  if (!entry) return null;
  if (Date.now() - entry.capturedAt > WS_TTL_MS) { wsSessionCache.delete(email); return null; }
  return entry.session;
}
function setCachedSession(email, session) {
  wsSessionCache.set(email, { session, capturedAt: Date.now() });
}

// ── VNC session manager ───────────────────────────────────────────────────────
// Single websockify on port 6080 with token-file routing.
// Each session gets its own Xvfb display + x11vnc on localhost only.
// Only ONE external port (6080) is ever needed regardless of user count.

const VNC_PORT        = parseInt(process.env.VNC_PORT || '6080', 10);
const VNC_TOKEN_FILE  = process.env.VNC_TOKEN_FILE || '/tmp/novnc-tokens.cfg';
const NOVNC_PATH      = process.env.NOVNC_PATH || '/usr/share/novnc';
const VNC_SLOTS       = 20; // max concurrent VNC sessions
const vncSessions     = new Map(); // jobToken → { displayNum, vncPort, xvfb, x11vnc }
let   vncNextSlot     = 0;
let   sharedWsify     = null; // single shared websockify process

function allocateVncSlot() {
  const slot      = vncNextSlot++ % VNC_SLOTS;
  const displayNum = 99 + slot;
  const vncPort    = 5900 + slot;
  return { displayNum, vncPort };
}

function writeTokenFile() {
  // Format: token: host:port
  const lines = [...vncSessions.entries()]
    .map(([tok, s]) => `${tok}: localhost:${s.vncPort}`)
    .join('\n');
  fs.writeFileSync(VNC_TOKEN_FILE, lines + '\n');
}

function ensureSharedWsify() {
  if (sharedWsify && !sharedWsify.killed) return;
  sharedWsify = spawn('websockify', [
    '--web', NOVNC_PATH,
    '--token-plugin', 'TokenFile',
    '--token-source', VNC_TOKEN_FILE,
    String(VNC_PORT),
  ], { stdio: 'ignore' });
  sharedWsify.on('exit', () => { sharedWsify = null; });
}

async function startVncProcesses(token, displayNum, vncPort) {
  const xvfb = spawn('Xvfb', [`:${displayNum}`, '-screen', '0', '1280x800x24', '-ac'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));

  const x11vnc = spawn('x11vnc', [
    '-display', `:${displayNum}`, '-rfbport', String(vncPort),
    '-nopw', '-localhost', '-quiet', '-forever',
  ], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));

  vncSessions.set(token, { displayNum, vncPort, xvfb, x11vnc });
  writeTokenFile();
  ensureSharedWsify();
  await new Promise(r => setTimeout(r, 600));
  log(token, `VNC started — display :${displayNum}, internal port ${vncPort}, ws token ${token.slice(0,8)}`);
}

function stopVncProcesses(token) {
  const s = vncSessions.get(token);
  if (!s) return;
  try { s.x11vnc.kill('SIGTERM'); } catch {}
  try { s.xvfb.kill('SIGTERM'); } catch {}
  vncSessions.delete(token);
  writeTokenFile(); // remove token from routing table
  // Stop shared websockify only when no sessions remain
  if (vncSessions.size === 0 && sharedWsify) {
    try { sharedWsify.kill('SIGTERM'); } catch {}
    sharedWsify = null;
  }
  log(token, 'VNC session stopped');
}

// ── In-memory job store: token → job ─────────────────────────────────────────
const jobs = new Map();

// Ring buffer of recent log lines (last 200)
const logBuffer = [];
function log(token, msg) {
  const line = `[${new Date().toISOString()}] [${token?.slice(0,8) || '??'}] ${msg}`;
  console.log('[copilot]', line);
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  if (token && jobs.has(token)) jobs.get(token).logs = [...(jobs.get(token).logs || []), msg];
}

// ── MSAL app for copilot auth ─────────────────────────────────────────────────

// jobToken → Playwright-format cookies[] captured from MSAL back-channel
const ssoStore = new Map();

function parseMsalCookies(setCookieArr) {
  if (!setCookieArr?.length) return [];
  return setCookieArr.map(h => {
    const parts = h.split(';').map(p => p.trim());
    const eq = parts[0].indexOf('=');
    if (eq < 0) return null;
    const name = parts[0].slice(0, eq);
    const value = parts[0].slice(eq + 1);
    const domain = parts.find(p => p.toLowerCase().startsWith('domain='))?.slice(7) || '.login.microsoftonline.com';
    const cookiePath = parts.find(p => p.toLowerCase().startsWith('path='))?.slice(5) || '/';
    const expStr = parts.find(p => p.toLowerCase().startsWith('expires='))?.slice(8);
    const expires = expStr ? Math.floor(new Date(expStr).getTime() / 1000) : -1;
    return {
      name, value, domain, path: cookiePath,
      secure: parts.some(p => p.toLowerCase() === 'secure'),
      httpOnly: parts.some(p => p.toLowerCase() === 'httponly'),
      sameSite: 'None',
      expires: isNaN(expires) ? -1 : expires,
    };
  }).filter(Boolean).filter(c => c.name);
}

function msalDoRequest(method, url, body, reqHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(body) : null;
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: { ...(reqHeaders || {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const flatHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flatHeaders[k] = Array.isArray(v) ? v[0] : (v || '');
        }
        resolve({ body: parsed, headers: flatHeaders, status: res.statusCode, _setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeMsalApp(captureKey = null) {
  const config = {
    auth: {
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      authority: 'https://login.microsoftonline.com/common',
    },
  };
  if (captureKey) {
    config.system = {
      networkClient: {
        sendGetRequestAsync: (url, opts) => msalDoRequest('GET', url, null, opts?.headers),
        sendPostRequestAsync: async (url, opts) => {
          const result = await msalDoRequest('POST', url, opts?.body, opts?.headers);
          if (url.includes('login.microsoftonline.com') && result._setCookie.length) {
            const existing = ssoStore.get(captureKey) || [];
            ssoStore.set(captureKey, [...existing, ...parseMsalCookies(result._setCookie)]);
          }
          return result;
        },
      },
    };
  }
  return new ConfidentialClientApplication(config);
}

export function buildCopilotAuthUrl(token, method = 'extension') {
  const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
  const state = Buffer.from(JSON.stringify({ flow: 'copilot', token, method })).toString('base64');
  return makeMsalApp().getAuthCodeUrl({
    scopes: ['openid', 'profile', 'email'],
    redirectUri: `${baseUrl}/auth/callback`,
    state,
    prompt: 'select_account',
  });
}

// ── Page builders — shared helpers ───────────────────────────────────────────
const sharedCss = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Segoe UI,sans-serif;background:#f3f2f1}
  .bar{background:#0078d4;color:#fff;padding:12px 20px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:10px}
  .bar small{font-weight:400;opacity:.8;font-size:12px}
  .wrap{max-width:560px;margin:0 auto;padding:40px 20px}
  .spinner{width:32px;height:32px;border:3px solid #e0e0e0;border-top:3px solid #0078d4;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-msg{font-size:14px;color:#444;text-align:center}
  .conv{padding:8px 0;font-size:13px;border-bottom:1px solid #eee}
  .conv .title{font-weight:600}
  .ok{color:#107c10;font-size:12px}
  .warn{color:#8a6914;font-size:12px}
  .fail{color:#d83b01;font-size:12px}
  #convs{margin-top:16px}
`;

function pollScript(token) {
  return `
const _pollInterval = setInterval(async () => {
  try {
    const r = await fetch('/copilot/status/${token}');
    const d = await r.json();
    const msg = d.message || d.status;
    document.querySelectorAll('.status-msg').forEach(el => el.textContent = msg);
    if (d.results?.length) {
      const html = d.results.map(r => {
        const cls = r.ok ? (r.reason ? 'warn' : 'ok') : 'fail';
        const label = r.ok ? (r.reason ? '✓ (Basic license)' : '✓ Migrated') : '✗ ' + (r.reason || 'failed');
        return '<div class="conv"><div class="title">' + r.geminiTitle + '</div>'
             + '<div class="' + cls + '">' + label + (r.title ? ' → ' + r.title : '') + '</div></div>';
      }).join('');
      const convEl = document.getElementById('convs');
      if (convEl) convEl.innerHTML = html;
    }
    if (d.status === 'done') {
      clearInterval(_pollInterval);
      document.querySelectorAll('.status-msg').forEach(el => el.textContent = '✅ Done! Redirecting to Copilot...');
      setTimeout(() => window.location.href = 'https://m365.cloud.microsoft/chat', 2500);
    }
    if (d.status === 'failed') {
      clearInterval(_pollInterval);
      document.querySelectorAll('.status-msg').forEach(el => el.textContent = '❌ ' + msg);
    }
    if ((d.status === 'vnc_ready' || d.status === 'starting_vnc') && document.getElementById('vnc-wrap')) {
      document.getElementById('loading') && (document.getElementById('loading').style.display = 'none');
      document.getElementById('vnc-wrap').style.display = 'block';
    }
    if ((d.status === 'session_captured' || d.status === 'migrating') && document.getElementById('vnc-wrap')) {
      document.getElementById('vnc-wrap').style.display = 'none';
    }
  } catch {}
}, 2000);`;
}

// ── noVNC page builder ────────────────────────────────────────────────────────
function buildVncPage(token, userEmail, vncWsPort, _reqHost) {
  const vncUrl = vncWsPort
    ? `/novnc/vnc.html?autoconnect=true&resize=scale&quality=6&path=novnc%2Fwebsockify%3Ftoken%3D${token}`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
<title>CloudFuze — Browser Window</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  ${sharedCss}
  #loading{text-align:center;padding:60px 20px}
  #vnc-wrap{display:none;width:100%;height:calc(100vh - 46px)}
  #vnc-frame{width:100%;height:100%;border:none}
</style>
</head>
<body>
<div class="bar">CloudFuze Copilot Migration<small>Signed in as ${userEmail}</small></div>
<div id="loading">
  <div class="spinner" style="margin-top:60px"></div>
  <p class="status-msg" style="margin-top:12px">Starting browser window...</p>
  <p style="font-size:12px;color:#999;margin-top:8px">Sign in to Microsoft Copilot in the window below.</p>
</div>
<div id="vnc-wrap">
  <iframe id="vnc-frame" src="${vncUrl}"></iframe>
</div>
<div id="convs" style="max-width:520px;margin:24px auto;padding:0 20px"></div>
<script>${pollScript(token)}</script>
</body>
</html>`;
}

// Auto-opens Copilot tab immediately after OAuth — extension method
function buildAutoOpenPage(token, userEmail, copilotUrl) {
  return `<!DOCTYPE html>
<html>
<head>
<title>CloudFuze — Migrating</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${sharedCss}</style>
</head>
<body>
<div class="bar">CloudFuze Copilot Migration<small>Signed in as ${userEmail}</small></div>
<div class="wrap" style="text-align:center;padding-top:60px">
  <div class="spinner"></div>
  <p class="status-msg">Opening Copilot...</p>
  <p style="font-size:12px;color:#999;margin-top:12px">
    A Copilot tab will open automatically. You can close it once it loads.
  </p>
  <p style="margin-top:20px;font-size:13px;color:#555">
    Copilot didn't open?
    <a href="${copilotUrl}" target="_blank" style="color:#0078d4">Click here</a>
  </p>
  <div id="convs" style="text-align:left;margin-top:24px"></div>
</div>
<script>
// Auto-open Copilot in new tab immediately
window.open(${JSON.stringify(copilotUrl)}, '_blank');
${pollScript(token)}
</script>
</body>
</html>`;
}

// Simple progress page — no VNC iframe, no open button (returning user / local dev)
function buildProgressPage(token, userEmail) {
  return `<!DOCTYPE html>
<html>
<head>
<title>CloudFuze — Migrating</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${sharedCss}</style>
</head>
<body>
<div class="bar">CloudFuze Copilot Migration<small>Signed in as ${userEmail}</small></div>
<div class="wrap" style="text-align:center;padding-top:60px">
  <div class="spinner"></div>
  <p class="status-msg">Starting migration...</p>
  <div id="convs" style="text-align:left;margin-top:24px"></div>
</div>
<script>${pollScript(token)}</script>
</body>
</html>`;
}

// VNC page — embeds noVNC iframe, polls for VNC ready
function buildExtensionPage(token, userEmail, copilotUrl, _reqHost) {
  return `<!DOCTYPE html>
<html>
<head>
<title>CloudFuze — Open Copilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Segoe UI, sans-serif; background: #f3f2f1; }
  .bar { background: #0078d4; color: white; padding: 12px 20px; font-size: 14px; font-weight: 600;
         display: flex; align-items: center; gap: 10px; }
  .bar small { font-weight: 400; opacity: .8; font-size: 12px; }
  .wrap { max-width: 560px; margin: 60px auto; padding: 20px; }
  h2 { font-size: 20px; margin-bottom: 10px; color: #242424; }
  p { font-size: 14px; color: #555; margin-bottom: 20px; line-height: 1.5; }
  .btn { display: inline-block; background: #0078d4; color: white; padding: 12px 24px;
         border-radius: 4px; text-decoration: none; font-size: 14px; font-weight: 600; cursor: pointer; border: none; }
  .btn:hover { background: #106ebe; }
  .spinner { width: 28px; height: 28px; border: 3px solid #e0e0e0; border-top: 3px solid #0078d4;
             border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; vertical-align: middle; margin-right: 10px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #status-row { display: none; margin-top: 24px; font-size: 14px; color: #444; }
  .conv { padding: 8px 0; font-size: 13px; border-bottom: 1px solid #eee; }
  .conv .title { font-weight: 600; }
  .ok { color: #107c10; font-size: 12px; }
  .warn { color: #8a6914; font-size: 12px; }
  .fail { color: #d83b01; font-size: 12px; }
  #convs { margin-top: 12px; }
  .step { background: #f0f6ff; border-radius: 6px; padding: 12px 16px; margin-bottom: 10px; font-size: 13px; color: #333; }
  .step b { color: #0078d4; }
</style>
</head>
<body>
<div class="bar">
  CloudFuze Copilot Migration
  <small>Signed in as ${userEmail}</small>
</div>
<div class="wrap">
  <h2>One more step</h2>
  <p>Click the button below to open Copilot. The <b>CloudFuze extension</b> will automatically
     capture your session and start migrating conversations.</p>
  <div class="step"><b>Step 1:</b> Make sure the <b>CloudFuze Migration Viewer</b> extension is installed in your browser.</div>
  <div class="step"><b>Step 2:</b> Click the button — it opens Copilot in a new tab.</div>
  <div class="step"><b>Step 3:</b> Come back here and watch progress. ✅</div>
  <br>
  <a class="btn" href="${copilotUrl}" target="_blank" id="open-btn">Open Copilot →</a>

  <div id="status-row">
    <span class="spinner"></span>
    <span id="status-msg">Waiting for Copilot session...</span>
    <div id="convs"></div>
  </div>

  <p style="margin-top:24px; font-size:12px; color:#888; text-align:center">
    Don't have the extension?
    <a href="/copilot/start-vnc/${token}" style="color:#0078d4">Use browser window instead →</a>
  </p>
</div>
<script>
document.getElementById('open-btn').addEventListener('click', () => {
  document.getElementById('status-row').style.display = 'block';
});
const poll = setInterval(async () => {
  try {
    const r = await fetch('/copilot/status/${token}');
    const d = await r.json();
    const msg = d.message || d.status;
    document.getElementById('status-msg').textContent = msg;
    document.getElementById('status-row').style.display = 'block';
    if (d.results?.length) {
      const html = d.results.map(r => {
        const cls = r.ok ? (r.reason ? 'warn' : 'ok') : 'fail';
        const label = r.ok ? (r.reason ? '✓ Migrated (Basic license)' : '✓ Migrated') : '✗ ' + (r.reason || 'failed');
        return '<div class="conv"><div class="title">' + r.geminiTitle + '</div><div class="' + cls + '">' + label + (r.title ? ' → ' + r.title : '') + '</div></div>';
      }).join('');
      document.getElementById('convs').innerHTML = html;
    }
    if (d.status === 'done') {
      clearInterval(poll);
      document.getElementById('status-msg').textContent = '✅ All done! You can now check your Copilot sidebar.';
    }
    if (d.status === 'failed') {
      clearInterval(poll);
      document.getElementById('status-msg').textContent = '❌ ' + msg;
    }
    if (d.status === 'starting_vnc' || d.status === 'vnc_ready') {
      clearInterval(poll);
      window.location.href = '/copilot/start-vnc/${token}?redirect=1';
    }
  } catch {}
}, 2000);
</script>
</body>
</html>`;
}

// Called from server.js /auth/callback when flow === 'copilot'
export async function handleCopilotCallback(req, res, code, stateData) {
  const { token } = stateData;
  const job = jobs.get(token);
  if (!job) return res.status(404).send('<h2>Migration link expired or not found.</h2>');

  // Guard against duplicate callback (browser retry / double redirect)
  if (job.status !== 'pending') {
    log(token, `Duplicate callback ignored (status: ${job.status})`);
    return res.send(buildVncPage(token, job.userEmail || 'unknown', null, req.hostname));
  }
  job.status = 'processing_auth';

  const baseUrl = process.env.BASE_URL || 'http://localhost:4000';

  let userEmail = 'unknown';
  try {
    const msalApp = makeMsalApp(token);
    const result = await msalApp.acquireTokenByCode({
      code,
      redirectUri: `${baseUrl}/auth/callback`,
      scopes: ['openid', 'profile', 'email'],
    });
    userEmail = result.account?.username || result.account?.name || 'unknown';
  } catch (e) {
    console.error('[copilot] Token exchange failed:', e.message);
  }

  job.msalCookies = ssoStore.get(token) || [];
  ssoStore.delete(token);
  job.userEmail = userEmail;
  log(token, `OAuth callback — user: ${userEmail}, SSO cookies: ${job.msalCookies.length}`);

  const sessionFile = sessionFileFor(userEmail);
  const hasSession  = fs.existsSync(sessionFile);

  if (hasSession) {
    // Returning user — session file exists, go headless immediately (no method needed)
    job.status  = 'authorized';
    job.message = 'Session found. Starting migration...';
    log(token, 'Returning user — headless via session file');
    res.send(buildProgressPage(token, userEmail));
    runMigrationJob(job).catch(e => { job.status = 'failed'; job.message = e.message; });
    return;
  }

  const method = job.method || 'extension';
  log(token, `First-time user — method: ${method}`);

  if (method === 'vnc') {
    // User chose browser window — start VNC immediately
    if (process.platform === 'linux') {
      job.status  = 'starting_vnc';
      job.message = 'Starting browser window...';
      res.send(buildVncPage(token, userEmail, VNC_PORT, req.hostname));
      const sessionFile = sessionFileFor(userEmail);
      const { displayNum, vncPort } = allocateVncSlot();
      startVncAndCapture(token, job, sessionFile, displayNum, vncPort)
        .catch(e => { job.status = 'failed'; job.message = e.message; stopVncProcesses(token); });
    } else {
      // Local dev — visible Playwright window
      job.status  = 'authorized';
      job.message = 'A browser window opened — sign in to Copilot there.';
      res.send(buildProgressPage(token, userEmail));
      runMigrationJob(job).catch(e => { job.status = 'failed'; job.message = e.message; });
    }
    return;
  }

  // Extension method — auto-open Copilot in new tab after sign-in
  job.status  = 'waiting_for_ws';
  job.message = 'Opening Copilot...';
  log(token, 'Extension method — auto-opening Copilot tab');

  // Timeout: if no WS captured within 10 min, fail the job
  setTimeout(() => {
    if (job.status === 'waiting_for_ws') {
      job.status  = 'failed';
      job.message = 'Timed out. Please try again or use the browser window option.';
      log(token, 'waiting_for_ws timeout after 10 min');
    }
  }, 10 * 60 * 1000);

  const copilotUrl = `https://m365.cloud.microsoft/chat?cfz_token=${token}`;
  res.send(buildAutoOpenPage(token, userEmail, copilotUrl));
}

async function startVncAndCapture(token, job, sessionFile, displayNum, vncPort) {
  await startVncProcesses(token, displayNum, vncPort);

  job.status  = 'vnc_ready';
  job.message = 'Sign in to Microsoft in the window below';
  log(token, `VNC ready on port ${VNC_PORT} — waiting for user to sign in`);

  // Launch visible Playwright on the Xvfb display
  const session = await getSubstrateSession(job.userEmail, sessionFile, job.msalCookies || [], displayNum);
  setCachedSession(job.userEmail, session);
  log(token, `Session captured via VNC — OID: ${session.oid}`);

  job.status  = 'session_captured';
  job.message = 'Signed in! Starting migration...';
  stopVncProcesses(token);

  await runMigrationJob(job);
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function createCopilotRouter() {
  const router = express.Router();

  // Step 1: method selection page
  router.get('/start', (req, res) => {
    const uploadId = req.query.uploadId || 'a5b50ed1da10e3a3b58aeb518c51115b';
    const limit    = parseInt(req.query.limit || '3', 10);
    res.send(`<!DOCTYPE html>
<html>
<head>
<title>CloudFuze — Copilot Migration</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Segoe UI,sans-serif;background:#f3f2f1;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .wrap{width:100%;max-width:560px;padding:32px 20px}
  h2{font-size:22px;color:#242424;margin-bottom:6px}
  .sub{font-size:14px;color:#666;margin-bottom:28px}
  .cards{display:flex;gap:14px;flex-wrap:wrap}
  .card{flex:1;min-width:220px;background:#fff;border:2px solid #e0e0e0;border-radius:8px;padding:20px;cursor:pointer;transition:border-color .15s,box-shadow .15s;text-decoration:none;color:inherit;display:block}
  .card:hover{border-color:#0078d4;box-shadow:0 2px 8px rgba(0,120,212,.15)}
  .card.selected{border-color:#0078d4;background:#f0f6ff}
  .card-icon{font-size:28px;margin-bottom:10px}
  .card-title{font-size:15px;font-weight:600;color:#242424;margin-bottom:4px}
  .card-desc{font-size:12px;color:#666;line-height:1.5}
  .card-badge{display:inline-block;background:#dff6dd;color:#107c10;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;margin-top:8px}
  .card-badge.warn{background:#fff4ce;color:#8a6914}
  .signin-wrap{margin-top:24px}
  .btn-ms{display:inline-flex;align-items:center;gap:10px;background:#0078d4;color:#fff;padding:12px 22px;border-radius:4px;font-size:14px;font-weight:600;text-decoration:none;border:none;cursor:pointer;width:100%;justify-content:center}
  .btn-ms:hover{background:#106ebe}
  .btn-ms:disabled{background:#a0c4e8;cursor:not-allowed}
  .ms-logo{width:18px;height:18px;flex-shrink:0}
  .hint{font-size:12px;color:#888;margin-top:10px;text-align:center}
  #method-hint{font-size:13px;color:#444;background:#f0f6ff;border-radius:6px;padding:10px 14px;margin-top:16px;display:none}
</style>
</head>
<body>
<div class="wrap">
  <h2>Migrate Gemini to Copilot</h2>
  <p class="sub">Choose how you want to connect your Copilot account — then sign in with Microsoft.</p>

  <div class="cards">
    <a class="card" id="card-ext" href="/copilot/begin?method=extension&uploadId=${uploadId}&limit=${limit}">
      <div class="card-icon">🧩</div>
      <div class="card-title">CloudFuze Extension</div>
      <div class="card-desc">Install the Chrome extension once. After sign-in, Copilot opens automatically — no extra steps.</div>
      <span class="card-badge">Recommended</span>
    </a>
    <a class="card" id="card-vnc" href="/copilot/begin?method=vnc&uploadId=${uploadId}&limit=${limit}">
      <div class="card-icon">🖥</div>
      <div class="card-title">Browser Window</div>
      <div class="card-desc">No extension needed. A browser window opens on our server — sign in to Copilot there.</div>
      <span class="card-badge warn">Requires display</span>
    </a>
  </div>
</div>
</body>
</html>`);
  });

  // Step 2: create job for chosen method and redirect to Microsoft OAuth
  router.get('/begin', async (req, res) => {
    const method   = req.query.method === 'vnc' ? 'vnc' : 'extension';
    const uploadId = req.query.uploadId || 'a5b50ed1da10e3a3b58aeb518c51115b';
    const limit    = parseInt(req.query.limit || '3', 10);
    const token    = randomUUID();

    jobs.set(token, { token, uploadId, limit, method, status: 'pending', message: 'Waiting for auth...' });
    log(token, `Job created — method: ${method}, upload: ${uploadId}, limit: ${limit}`);

    const authUrl = await buildCopilotAuthUrl(token, method);
    res.redirect(authUrl);
  });

  // Status poll
  router.get('/status/:token', (req, res) => {
    const job = jobs.get(req.params.token);
    if (!job) return res.status(404).json({ status: 'not_found' });
    res.json({ status: job.status, message: job.message, results: job.results || [], logs: job.logs || [] });
  });

  // Extension posts the captured Substrate WS URL here
  router.post('/ws-capture', express.json(), async (req, res) => {
    const { token, wsUrl } = req.body || {};
    if (!token || !wsUrl) return res.status(400).json({ error: 'token and wsUrl required' });

    const job = jobs.get(token);
    if (!job) return res.status(404).json({ error: 'job not found or expired', done: true });
    if (!wsUrl.includes('substrate.office.com')) return res.status(400).json({ error: 'invalid wsUrl' });

    // Job finished — tell extension to clear its stored token
    if (job.status === 'done' || job.status === 'failed') {
      return res.json({ ok: true, done: true, note: 'job already finished' });
    }

    log(token, `WS URL received from extension: ${wsUrl.slice(0, 100)}`);

    // Parse WS URL into a session object (same shape as getSubstrateSession returns)
    const urlObj    = new URL(wsUrl);
    const wsToken   = urlObj.searchParams.get('access_token');
    const sessionId = urlObj.searchParams.get('chatsessionid') || randomUUID().replace(/-/g, '');
    const xSession  = urlObj.searchParams.get('X-SessionId') || randomUUID();
    const pathMatch = wsUrl.match(/Chathub\/([^@]+)@([^?]+)/);
    const oid = pathMatch?.[1] || '';
    const tid = pathMatch?.[2] || '';

    if (!wsToken) return res.status(400).json({ error: 'no access_token in wsUrl' });

    const session = { token: wsToken, oid, tid, sessionId, xSessionId: xSession };
    // Always update cached session — this is the token refresh mechanism.
    // Every time user opens a new chat in Copilot, extension sends a fresh WS URL here.
    setCachedSession(job.userEmail || token, session);
    log(token, `Session refreshed — OID: ${oid}`);

    res.json({ ok: true });

    // Kick off migration on first WS capture; subsequent POSTs just refresh the token
    if (job.status === 'waiting_for_ws') {
      runMigrationJob(job).catch(e => { job.status = 'failed'; job.message = e.message; });
    }
  });

  // VNC fallback route — launches VNC for users without the extension
  router.get('/start-vnc/:token', async (req, res) => {
    const token = req.params.token;

    // If redirect=1 the extension page is polling and redirected here after status flipped —
    // just serve the VNC page immediately showing current status
    if (req.query.redirect === '1') {
      const job = jobs.get(token);
      if (!job) return res.status(404).send('<h2>Migration link expired or not found.</h2>');
      const vncs = vncSessions.get(token);
      return res.send(buildVncPage(token, job.userEmail || 'unknown', vncs ? VNC_PORT : null, req.hostname));
    }

    const job = jobs.get(token);
    if (!job) return res.status(404).send('<h2>Migration link expired or not found.</h2>');

    if (job.status !== 'waiting_for_ws') {
      return res.status(400).send(`<h2>Cannot start VNC — job status is "${job.status}" (expected waiting_for_ws).</h2>`);
    }

    log(token, 'VNC fallback requested by user');
    job.status  = 'starting_vnc';
    job.message = 'Starting browser window...';

    // Respond with VNC page immediately (spinner) — background process starts VNC
    res.send(buildVncPage(token, job.userEmail || 'unknown', VNC_PORT, req.hostname));

    // Launch VNC in background
    const sessionFile = sessionFileFor(job.userEmail);
    const { displayNum, vncPort } = allocateVncSlot();
    startVncAndCapture(token, job, sessionFile, displayNum, vncPort)
      .catch(e => { job.status = 'failed'; job.message = e.message; log(token, `VNC capture error: ${e.message}`); });
  });

  // Debug: all recent log lines
  router.get('/logs', (req, res) => {
    res.type('text/plain').send(logBuffer.join('\n'));
  });

  // Debug: all jobs summary
  router.get('/jobs', (req, res) => {
    const summary = [...jobs.values()].map(j => ({
      token: j.token?.slice(0, 8),
      user: j.userEmail,
      status: j.status,
      message: j.message,
      results: j.results?.length,
      logs: j.logs,
    }));
    res.json(summary);
  });

  return router;
}

// ── Migration job ─────────────────────────────────────────────────────────────

async function runMigrationJob(job) {
  const t = job.token;
  log(t, `Job started — user: ${job.userEmail}, upload: ${job.uploadId}, limit: ${job.limit}`);

  await connectMongo();
  const db = getDb();

  job.status = 'capturing_session';
  const sessionFile = sessionFileFor(job.userEmail);

  let session = getCachedSession(job.userEmail);
  if (session) {
    log(t, `WS session reused from cache — OID: ${session.oid}`);
    job.message = 'Session ready (cached). Loading conversations...';
  } else {
    const hasSession = fs.existsSync(sessionFile);
    const willBeHeadless = process.env.PLAYWRIGHT_HEADLESS !== 'false' || hasSession || (job.msalCookies || []).length > 0;
    job.message = willBeHeadless
      ? 'Connecting to Copilot silently...'
      : '⚠ A browser window just opened — sign in to Microsoft Copilot there, then return here.';
    log(t, `Playwright session capture starting — file: ${sessionFile}, headless: ${willBeHeadless}`);
    try {
      session = await getSubstrateSession(job.userEmail, sessionFile, job.msalCookies || []);
      setCachedSession(job.userEmail, session);
      log(t, `Session captured — OID: ${session.oid}, TID: ${session.tid}`);
    } catch (e) {
      log(t, `Session capture FAILED: ${e.message}`);
      throw e;
    }
  }

  job.message = 'Session captured. Loading Gemini conversations...';

  let upload = await db.collection('uploads').findOne({ _id: job.uploadId });
  if (!upload) {
    const fallbackPath = path.join('uploads', `extracted_${job.uploadId}`);
    if (fs.existsSync(fallbackPath)) {
      upload = { _id: job.uploadId, extractPath: fallbackPath };
      log(t, `Upload not in DB — using filesystem path: ${fallbackPath}`);
    } else {
      throw new Error(`Upload not found: ${job.uploadId}`);
    }
  }

  // Normalize extractPath — DB may store an absolute Windows path from local dev
  let extractPath = upload.extractPath;
  if (!fs.existsSync(extractPath)) {
    const dockerPath = path.join('uploads', `extracted_${job.uploadId}`);
    if (fs.existsSync(dockerPath)) {
      extractPath = dockerPath;
      log(t, `Path normalized to: ${dockerPath}`);
    } else {
      throw new Error(`Upload files not found: ${job.uploadId}`);
    }
  }

  log(t, `Upload ready: ${job.uploadId}, path: ${extractPath}`);

  const xmlFiles = fs.readdirSync(extractPath)
    .filter(f => f.endsWith('.xml'))
    .map(f => ({ file: path.join(extractPath, f), email: f.split('-')[0] }));
  log(t, `XML files: ${xmlFiles.map(x => x.email).join(', ')}`);

  let conversations = [];
  for (const { file, email } of xmlFiles) {
    const convs = await parseGeminiXml(file);
    conversations.push(...convs.map(c => ({ ...c, sourceUser: email })));
  }
  conversations = conversations.slice(0, job.limit);
  log(t, `Conversations to send: ${conversations.length}`);

  job.status = 'migrating';
  job.message = `Sending ${conversations.length} conversations...`;
  job.results = [];

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    job.message = `[${i + 1}/${conversations.length}] Sending "${conv.title.slice(0, 40)}"...`;
    log(t, `Sending [${i + 1}/${conversations.length}]: "${conv.title.slice(0, 50)}"`);
    const text = buildCopilotMessage(conv, conv.sourceUser);
    let result = await sendConversation(session, text);
    log(t, `  → ${result.ok ? 'OK' : 'FAIL'} ${result.ok ? result.title : result.reason}`);

    // 401 token expiry: wait for fresh extension capture then resume
    if (!result.ok && (result.statusCode === 401 || result.reason?.includes('401') || result.reason?.includes('HTTP 401 Unauthorized'))) {
      log(t, 'Token expired (401) — switching job back to waiting_for_ws for session refresh');
      job.status  = 'waiting_for_ws';
      job.message = 'Session expired. Open Copilot again to resume.';
      wsSessionCache.delete(job.userEmail);

      // Poll for fresh session (up to 5 min, every 2s)
      const resumeDeadline = Date.now() + 5 * 60 * 1000;
      let freshSession = null;
      while (Date.now() < resumeDeadline) {
        await new Promise(r => setTimeout(r, 2000));
        freshSession = getCachedSession(job.userEmail);
        if (freshSession) break;
      }

      if (!freshSession) {
        job.status  = 'failed';
        job.message = 'Session expired and no refresh received within 5 minutes. Please restart.';
        log(t, 'Session refresh timed out — aborting');
        return;
      }

      log(t, `Session refreshed by extension — resuming from conversation ${i + 1}`);
      session = freshSession;
      job.status  = 'migrating';
      job.message = `Session refreshed. Resuming from [${i + 1}/${conversations.length}]...`;

      // Retry the same conversation with the new session
      result = await sendConversation(session, text);
      log(t, `  → (retry) ${result.ok ? 'OK' : 'FAIL'} ${result.ok ? result.title : result.reason}`);

      // If still 401 after refresh, abort
      if (!result.ok && (result.statusCode === 401 || result.reason?.includes('401') || result.reason?.includes('HTTP 401 Unauthorized'))) {
        job.status  = 'failed';
        job.message = 'Session still invalid after refresh. Please restart.';
        log(t, 'Retry after refresh still 401 — aborting');
        return;
      }
    }

    job.results.push({ geminiTitle: conv.title, ok: result.ok, title: result.title, reason: result.reason });
    await new Promise(r => setTimeout(r, 1000));
  }

  job.status = 'done';
  const ok = job.results.filter(r => r.ok).length;
  job.message = `Done: ${ok}/${conversations.length} migrated.`;
  log(t, `Job done: ${ok}/${conversations.length} succeeded`);
}

// ── Playwright session capture ────────────────────────────────────────────────

async function getSubstrateSession(userEmail = null, sessionFile = null, ssoCookies = [], displayNum = null) {
  if (!sessionFile) sessionFile = sessionFileFor(userEmail);
  const hasSession = fs.existsSync(sessionFile);
  const forceHeadless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const headless = forceHeadless || hasSession || ssoCookies.length > 0;

  const launchOpts = {
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu', '--use-gl=swiftshader',
    ],
  };
  // Point Chromium at the Xvfb virtual display when running VNC session
  if (!headless && displayNum !== null) {
    launchOpts.env = { ...process.env, DISPLAY: `:${displayNum}` };
  }

  const browser = await chromium.launch(launchOpts);
  const ctxOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    ...(hasSession ? { storageState: sessionFile } : {}),
  };
  const context = await browser.newContext(ctxOptions);

  // Inject MSAL back-channel cookies so headless Playwright can SSO into Copilot
  if (ssoCookies.length > 0 && !hasSession) {
    try {
      await context.addCookies(ssoCookies);
      const names = ssoCookies.map(c => `${c.name}@${c.domain}`).join(', ');
      log(null, `Injected ${ssoCookies.length} SSO cookies: ${names}`);
    } catch (e) {
      log(null, `SSO cookie injection warning: ${e.message}`);
    }
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const capturedWsUrls = [];
  page.on('websocket', ws => {
    if (ws.url().includes('substrate.office.com')) capturedWsUrls.push(ws.url());
  });

  await page.goto('https://m365.cloud.microsoft/chat', { waitUntil: 'domcontentloaded' });

  // No saved session — browser window is visible, wait up to 5 min for user to sign in
  // The email hint pre-fills the login field so user only needs to enter password
  if (!hasSession && page.url().includes('login.microsoftonline.com')) {
    if (userEmail && userEmail !== 'unknown') {
      try {
        await page.waitForSelector('input[name="loginfmt"]', { timeout: 5000 });
        await page.fill('input[name="loginfmt"]', userEmail);
        await page.press('input[name="loginfmt"]', 'Enter');
      } catch { /* field may have already advanced */ }
    }
    // Now wait for user to complete sign-in manually (up to 5 min)
  }

  // Wait for chat to load: 90s if headless, 5min if non-headless (manual sign-in)
  const deadline = Date.now() + (headless ? 90000 : 300000);
  let lastLoggedUrl = '';
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastLoggedUrl) {
      log(null, `[auth-nav] ${url.slice(0, 180)}`);
      lastLoggedUrl = url;
    }

    // Reached Copilot chat — done
    if (url.includes('m365.cloud.microsoft') && !url.includes('login')) break;

    // "Stay signed in?" or "Next" button
    const actionBtn = page.locator('button#idSIButton9, input#idSIButton9').first();
    if (await actionBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      log(null, '[auth-nav] Clicking idSIButton9 (Stay signed in / Next)');
      await actionBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    if (url.includes('login.microsoftonline.com') || url.includes('login.microsoft.com')) {
      // Account picker — click matching account tile
      if (userEmail && userEmail !== 'unknown') {
        const tile = page.locator([
          `[data-test-id="${userEmail}"]`,
          `div[title="${userEmail}"]`,
          `div[data-email="${userEmail}"]`,
          `[aria-label*="${userEmail}"]`,
        ].join(', ')).first();
        if (await tile.isVisible({ timeout: 500 }).catch(() => false)) {
          log(null, `[auth-nav] Clicking account tile for ${userEmail}`);
          await tile.click();
          await page.waitForTimeout(1500);
          continue;
        }
      }

      // Email input — fill if empty
      const emailInput = page.locator('input[name="loginfmt"]').first();
      if (await emailInput.isVisible({ timeout: 500 }).catch(() => false)) {
        const cur = await emailInput.inputValue().catch(() => '');
        if (!cur && userEmail && userEmail !== 'unknown') {
          log(null, `[auth-nav] Filling email: ${userEmail}`);
          await emailInput.fill(userEmail);
          await emailInput.press('Enter');
          await page.waitForTimeout(2000);
          continue;
        }
      }
    }

    await page.waitForTimeout(2000);
  }

  const finalUrl = page.url();
  log(null, `[auth-nav] Final URL: ${finalUrl.slice(0, 180)}`);
  if (!finalUrl.includes('m365.cloud.microsoft') || finalUrl.includes('login')) {
    await browser.close();
    throw new Error(`Headless auth did not reach Copilot. Stuck at: ${finalUrl.slice(0, 120)}`);
  }

  await page.waitForSelector('[role="textbox"]', { timeout: 30000 });

  // Wait up to 15s for WS to appear naturally on page load before probing
  const naturalDeadline = Date.now() + 15000;
  while (Date.now() < naturalDeadline && capturedWsUrls.length === 0) {
    await page.waitForTimeout(500);
  }

  // If still no WS, open a new chat and send a probe message to trigger one
  if (capturedWsUrls.length === 0) {
    try {
      const newChat = page.getByRole('button', { name: /new chat/i }).first();
      if (await newChat.isVisible({ timeout: 3000 }).catch(() => false)) await newChat.click();
      await page.waitForTimeout(1000);
    } catch {}

    try {
      const input = page.getByRole('textbox', { name: /message copilot/i });
      await input.click();
      await input.fill('Hi');
      await input.press('Enter');
    } catch {}

    const probeDeadline = Date.now() + 20000;
    while (Date.now() < probeDeadline && capturedWsUrls.length === 0) {
      await page.waitForTimeout(500);
    }
  }

  if (capturedWsUrls.length === 0) {
    await browser.close();
    throw new Error('No substrate WebSocket URL captured. Your Microsoft 365 account may not have Copilot access.');
  }

  await context.storageState({ path: sessionFile });
  await browser.close();

  const wsUrl = capturedWsUrls[0];
  const urlObj = new URL(wsUrl);
  const token     = urlObj.searchParams.get('access_token');
  const sessionId = urlObj.searchParams.get('chatsessionid') || randomUUID().replace(/-/g, '');
  const xSession  = urlObj.searchParams.get('X-SessionId')   || randomUUID();
  const pathMatch = wsUrl.match(/Chathub\/([^@]+)@([^?]+)/);
  const oid = pathMatch?.[1] || '';
  const tid = pathMatch?.[2] || '';

  if (!token) throw new Error('No access_token in captured WS URL.');
  return { token, oid, tid, sessionId, xSessionId: xSession };
}

// ── WebSocket sender ──────────────────────────────────────────────────────────

function sendConversation({ token, oid, tid, sessionId, xSessionId }, messageText) {
  return new Promise((resolve) => {
    const clientReqId    = randomUUID().replace(/-/g, '');
    const conversationId = randomUUID();

    const wsUrl = `wss://substrate.office.com/m365Copilot/Chathub/${oid}@${tid}`
      + `?chatsessionid=${sessionId}&XRoutingParameterSessionKey=${sessionId}`
      + `&clientrequestid=${clientReqId}&X-SessionId=${xSessionId}`
      + `&ConversationId=${conversationId}&access_token=${token}`
      + `&variants=EnableRequestPlugins,feature.EnableSensitivityLabels`
      + `,feature.bizchatfluxv3,feature.IsStreamingModeInChatRequestEnabled`
      + `,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage`
      + `&source=%22officeweb%22&product=Office&agentHost=Bizchat.FullScreen`
      + `&licenseType=Premium&agent=work&scenario=officeweb`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: 'https://m365.cloud.microsoft',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Pragma: 'no-cache', 'Cache-Control': 'no-cache',
      },
    });

    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { ws.terminate(); finish({ ok: false, reason: 'timeout 45s' }); }, 45000);

    ws.on('open', () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS));

    ws.on('message', data => {
      for (const frame of data.toString().split(RS).filter(f => f.trim())) {
        let msg; try { msg = JSON.parse(frame); } catch { continue; }
        if (Object.keys(msg).length === 0) {
          ws.send(JSON.stringify({ type: 6 }) + RS);
          ws.send(JSON.stringify({
            arguments: [{
              source: 'officeweb', clientCorrelationId: randomUUID(),
              sessionId: xSessionId, optionsSets: ['enterprise_flux_handoff_outlook_compose'],
              options: {}, allowedMessageTypes: ['Chat','Suggestion','InternalSearchQuery',
                'InternalSearchResult','Disengaged','InternalLoaderMessage','RenderCardRequest',
                'SemanticSerp','GenerateContentQuery','SearchQuery','ConfirmationCard','DeveloperLogs'],
              sliceIds: [], threadLevelGptId: {}, conversationId, traceId: randomUUID(),
              isStartOfSession: true, productThreadType: 'Office', clientInfo: { clientPlatform: 'web' },
              message: { author: 'user', inputMethod: 'Keyboard', text: messageText,
                entityAnnotationTypes: ['People','File','Event'], requestId: randomUUID(),
                locationInfo: { timeZoneOffset: -5, timeZone: 'America/New_York' },
                locale: 'en-US', messageType: 'Chat', experienceType: 'Default' },
              plugins: [],
            }],
            invocationId: '0', target: 'chat', type: 4,
          }) + RS);
          continue;
        }
        if (msg.type === 1) continue;
        if (msg.type === 6) { ws.send(JSON.stringify({ type: 6 }) + RS); continue; }
        if (msg.type === 2) {
          clearTimeout(timer);
          const r = msg.item?.result;
          // Conversation migrated if defaultChatName exists — ForbiddenRequest means Basic license
          // (Copilot can't AI-respond) but the conversation IS in the sidebar
          const migrated = !!msg.item?.defaultChatName;
          const isLicense = r?.value === 'ForbiddenRequest';
          const ok = migrated || isLicense; // ForbiddenRequest = Basic license, conversation IS in sidebar
          finish({
            ok,
            title: msg.item?.defaultChatName,
            conversationId,
            result: r?.value,
            reason: ok ? (isLicense ? 'Basic license — conversation migrated, Copilot response blocked' : undefined)
                       : (r?.value || JSON.stringify(msg.item?.result) || 'type2-no-result'),
          });
          ws.close();
        }
        if (msg.type === 3) ws.close();
      }
    });

    ws.on('unexpected-response', (req, httpRes) => {
      clearTimeout(timer);
      let body = '';
      httpRes.on('data', d => body += d.toString());
      httpRes.on('end', () => {
        const reason = `HTTP ${httpRes.statusCode} ${httpRes.statusCode === 401 ? 'Unauthorized' : ''}: ${body.slice(0, 200)}`.trim();
        finish({ ok: false, reason, statusCode: httpRes.statusCode });
      });
    });
    ws.on('error', err => { clearTimeout(timer); finish({ ok: false, reason: err.message }); });
    ws.on('close', code => { clearTimeout(timer); if (!done) finish({ ok: false, reason: `closed:${code}` }); });
  });
}

// ── Gemini XML parser ─────────────────────────────────────────────────────────

async function parseGeminiXml(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
  const raw = parsed?.GeminiUserConversationHistory?.Conversations?.Conversation;
  if (!raw) return [];
  const convs = Array.isArray(raw) ? raw : [raw];
  return convs.map(c => {
    const turns = c.ConversationTurns?.ConversationTurn;
    const turnList = turns ? (Array.isArray(turns) ? turns : [turns]) : [];
    const messages = turnList
      .filter(t => t.Prompt?.Text || t.PrimaryResponse?.Text)
      .map(t => ({ user: t.Prompt?.Text?.trim() || '', gemini: t.PrimaryResponse?.Text?.trim() || '' }))
      .filter(m => m.user || m.gemini);
    return { id: c.ConversationId, title: c.ConversationTopic || 'Migrated Gemini Conversation', messages };
  }).filter(c => c.messages.length > 0);
}

function buildCopilotMessage(conv, sourceUser) {
  const lines = [
    conv.title,
    ``,
    `--- Migrated from Gemini (${sourceUser}) ---`,
  ];
  for (const m of conv.messages.slice(0, 20)) {
    if (m.user)   lines.push(`User: ${m.user.slice(0, 500)}`);
    if (m.gemini) lines.push(`Gemini: ${m.gemini.slice(0, 800)}`);
    lines.push('');
  }
  lines.push(`Please acknowledge that this migrated Gemini conversation has been received.`);
  return lines.join('\n');
}
