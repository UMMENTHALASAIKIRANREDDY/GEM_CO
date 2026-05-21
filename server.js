import 'dotenv/config';
import express from 'express';
import net from 'net';

// Prevent unhandled rejections from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message, err.stack);
});
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import bcrypt from 'bcryptjs';

import { getAuthUrl, acquireTokenByCode, isAuthenticated, getValidToken, clearMsToken, clearMsAccount, getMsAccounts, restoreMsSessions, verifyAppOnlyAccess } from './src/core/auth/microsoft.js';
import { fetchTenantInfo, buildAdminConsentUrl } from './src/modules/c2c/tenantConsent.js';
import { clearTenantToken } from './src/modules/c2c/multiTenantAuth.js';
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, getGoogleOAuth2Client, clearGoogleToken, clearGoogleAccount, getGoogleAccounts, restoreGoogleSessions } from './src/core/auth/googleOAuth.js';
import { connectMongo, getDb } from './src/db/mongo.js';
import { getLogger } from './src/utils/logger.js';
import { createG2CRouter } from './src/modules/g2c/routes.js';
import { createC2GRouter } from './src/modules/c2g/routes.js';
import { createCL2GRouter } from './src/modules/cl2g/routes.js';
import { createCL2CRouter } from './src/modules/cl2c/routes.js';
import { createG2GRouter } from './src/modules/g2g/routes.js';
import { createCopilotRouter, handleCopilotCallback } from './src/modules/copilot/routes.js';
import { createC2CRouter, createTenantConsentCallback } from './src/modules/c2c/routes.js';
import { runAgentLoop } from './src/agent/agentLoop.js';
import { auditEmitter } from './src/agent/auditLogger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

const dbLog = getLogger('db:ops');
function db() { return getDb(); }

// Store tenant ID for auth flow (shared between MS auth + C2G)
let currentTenantId = null;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'gemco-session-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ─── Auth helpers (shared) ────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.appUser) return next();
  res.status(401).json({ error: 'Not logged in' });
}

function getWorkspaceContext(req) {
  const appUserId = req.session.appUser?._id?.toString() || null;
  const googleEmail = req.session.googleEmail || null;
  const msEmail = req.session.msEmail || null;
  return { appUserId, googleEmail, msEmail };
}

function getWorkspaceFilter(req) {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  if (!appUserId || !googleEmail || !msEmail) return null;
  return { appUserId, googleEmail, msEmail };
}

function requireGoogleAuth(req, res, next) {
  const { appUserId, googleEmail } = getWorkspaceContext(req);
  if (!appUserId || !isGoogleAuthenticated(appUserId) || !googleEmail) {
    return res.status(401).json({ error: 'Google account not connected. Please sign in with Google first.' });
  }
  next();
}

function requireMsAuth(req, res, next) {
  const { appUserId, msEmail } = getWorkspaceContext(req);
  if (!appUserId || !isAuthenticated(appUserId) || !msEmail) {
    return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
  }
  next();
}

function requireWorkspace(req, res, next) {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  if (!appUserId || !isGoogleAuthenticated(appUserId) || !googleEmail) {
    return res.status(401).json({ error: 'Google account not connected. Please sign in with Google first.' });
  }
  if (!isAuthenticated(appUserId) || !msEmail) {
    return res.status(401).json({ error: 'Microsoft account not connected. Please sign in with Microsoft first.' });
  }
  next();
}

// ─── Static + root ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session?.appUser) res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  else res.sendFile(path.join(__dirname, 'ui', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'ui')));

// Serve noVNC static files for Copilot self-service VNC sessions
const NOVNC_STATIC = process.env.NOVNC_PATH || '/usr/share/novnc';
app.use('/novnc', express.static(NOVNC_STATIC));

// ─── Public API ───────────────────────────────────────────────────────────────

app.get('/api/app-config', (req, res) => {
  res.json({ showReset: process.env.SHOW_RESET_BUTTON === 'true' });
});

app.get('/api/tab-config', (req, res) => {
  res.json({
    clientId: process.env.AZURE_CLIENT_ID,
    redirectUri: (process.env.BASE_URL || 'http://localhost:4000') + '/tab-callback.html',
  });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await db().collection('appUsers').findOne({ email: email.toLowerCase().trim() });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const appUserId = user._id.toString();
  req.session.appUser = { _id: appUserId, email: user.email, name: user.name, role: user.role };
  try {
    const googleSession = await db().collection('authSessions').findOne({ appUserId, provider: 'google' });
    const msSession = await db().collection('authSessions').findOne({ appUserId, provider: 'microsoft' });
    if (googleSession?.email) req.session.googleEmail = googleSession.email;
    if (msSession?.email) req.session.msEmail = msSession.email;
  } catch {}
  res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
});

app.get('/api/me', (req, res) => {
  if (req.session?.appUser) return res.json(req.session.appUser);
  res.status(401).json({ error: 'Not logged in' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Auth gates ───────────────────────────────────────────────────────────────

const PUBLIC_PATHS = ['/api/login', '/api/me', '/api/logout'];
app.use('/api', (req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
  next();
});
app.use('/auth', (req, res, next) => {
  // OAuth callbacks must be public — they arrive before any session exists
  if (req.path === '/callback' || req.path === '/google/callback') return next();
  if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
  next();
});

// ─── OAuth: Microsoft ─────────────────────────────────────────────────────────

app.get('/auth/login', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    if (!tenantId) return res.status(400).send('tenant_id query parameter required');
    currentTenantId = tenantId;
    const appUserId = req.session.appUser?._id?.toString();
    const authUrl = await getAuthUrl(tenantId, appUserId);
    res.redirect(authUrl);
  } catch (err) { res.status(500).send(`Auth error: ${err.message}`); }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error, error_description, state, admin_consent, tenant } = req.query;

    // Branch 1: This is the RETURN from an admin-consent redirect (no `code`, has `admin_consent`+`tenant`).
    // Reuses the same redirect URI as OAuth so Azure only needs one URI registered.
    if (!code && admin_consent !== undefined) {
      const stateMap = req.session?._c2cConsentState || {};
      const stateEntry = state ? stateMap[state] : null;
      if (!stateEntry) {
        return res.status(400).send(`<html><body><h2>Consent state invalid or expired</h2><script>setTimeout(()=>window.close(),2000);</script></body></html>`);
      }
      delete req.session._c2cConsentState[state];

      if (error || admin_consent !== 'True') {
        return res.status(400).send(`<html><body><h2>Consent not granted</h2><p>${error_description || error || ''}</p><script>setTimeout(()=>window.close(),2000);</script></body></html>`);
      }
      if (!tenant) {
        return res.status(400).send(`<html><body><h2>Tenant id missing</h2><script>setTimeout(()=>window.close(),2000);</script></body></html>`);
      }

      // CRITICAL: clear the cached app-only token BEFORE fetching tenant info.
      // Before consent, the cache may hold a token with no roles (still 200 OK
      // from /token endpoint, just empty roles). Without clearing, every
      // subsequent call would reuse that powerless token for 60s.
      clearTenantToken(tenant);

      const info = await fetchTenantInfo(tenant);
      try {
        await db().collection('connectedTenants').updateOne(
          { appUserId: stateEntry.appUserId, tenantId: tenant },
          { $set: {
            appUserId: stateEntry.appUserId, tenantId: tenant,
            displayName: info.displayName, defaultDomain: info.defaultDomain,
            consentedAt: new Date(), consentState: 'active',
          } },
          { upsert: true }
        );
        dbLog.info(`connectedTenants.upsert — ${tenant} (${info.displayName || ''}) granted via /auth/callback`);
      } catch (e) { dbLog.warn(`connectedTenants upsert failed: ${e.message}`); }

      return res.send(`<html><body style="font-family:Segoe UI,sans-serif;text-align:center;padding:32px">
        <h2 style="color:#107c10">✓ Tenant connected</h2>
        <p style="color:#605e5c">${info.displayName || tenant}</p>
        <script>
          try { window.opener && window.opener.postMessage({ type: 'auth-success', alreadyConnected: false }, '*'); } catch (e) {}
          try { window.opener && window.opener.postMessage({ type: 'c2c-tenant-consent-success', tenantId: ${JSON.stringify(tenant)}, displayName: ${JSON.stringify(info.displayName)}, defaultDomain: ${JSON.stringify(info.defaultDomain)} }, '*'); } catch (e) {}
          setTimeout(() => window.close(), 1200);
        </script>
      </body></html>`);
    }

    // Branch 2: Normal OAuth code exchange.
    if (error) return res.send(`<html><body><h2>Auth failed</h2><p>${error_description || error}</p><script>window.close();</script></body></html>`);
    if (!code) return res.status(400).send('No authorization code received');

    // Copilot migration flow — handle separately
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
      if (decoded.flow === 'copilot') return handleCopilotCallback(req, res, code, decoded);
    } catch {}

    const msResult = await acquireTokenByCode(code, state);
    const msEmail = msResult.email || msResult?.account?.username || null;
    const msAlready = !!msResult.alreadyConnected;
    const realTenantId = msResult.realTenantId || null;
    if (msEmail) {
      req.session.msEmail = msEmail;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }
    dbLog.info(`authSessions.upsert — ${msEmail} (microsoft)`);

    // Auto-register the tenant for C2C if admin-consent is already in place.
    // If not, redirect the same popup to the admin-consent URL so the admin
    // completes both ceremonies (delegated + application) in a single visit.
    let consentNeeded = false;
    const ctx = getWorkspaceContext(req);
    const appUserId = ctx.appUserId;
    dbLog.info(`[/auth/callback] post-OAuth — email=${msEmail} realTenantId=${realTenantId} appUserId=${appUserId}`);

    if (realTenantId && appUserId) {
      const hasAppOnly = await verifyAppOnlyAccess(realTenantId);
      dbLog.info(`[/auth/callback] verifyAppOnlyAccess(${realTenantId}) → ${hasAppOnly}`);
      if (hasAppOnly) {
        const info = await fetchTenantInfo(realTenantId);
        try {
          await db().collection('connectedTenants').updateOne(
            { appUserId, tenantId: realTenantId },
            { $set: {
              appUserId, tenantId: realTenantId,
              displayName: info.displayName, defaultDomain: info.defaultDomain,
              consentedAt: new Date(), consentState: 'active',
            } },
            { upsert: true }
          );
          dbLog.info(`connectedTenants.upsert — ${realTenantId} (${info.displayName || msEmail}) auto-registered after OAuth`);
        } catch (e) { dbLog.warn(`connectedTenants auto-upsert failed: ${e.message}`); }
      } else {
        consentNeeded = true;
      }
    } else {
      dbLog.warn(`[/auth/callback] skipping verify+upsert — realTenantId=${realTenantId} appUserId=${appUserId}`);
    }

    // If admin consent is still needed, chain into the consent flow in the
    // SAME popup. We use a full-bleed loading page with explicit "Step 2 of 2"
    // messaging so the user understands Microsoft's consent screen is a
    // continuation, not a restart.
    if (consentNeeded && realTenantId && appUserId) {
      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
      const { randomUUID } = await import('crypto');
      const stateToken = randomUUID();
      req.session._c2cConsentState = req.session._c2cConsentState || {};
      req.session._c2cConsentState[stateToken] = { appUserId, createdAt: Date.now() };
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      const consentUrl = buildAdminConsentUrl({
        redirectUri: `${baseUrl}/auth/callback`,
        state: stateToken,
        tenantId: realTenantId,
        loginHint: msEmail,
      });
      return res.send(`<html><head><meta charset="utf-8"><title>Granting permissions…</title>
<style>
  body{font-family:Segoe UI,system-ui,sans-serif;background:#F6F6F6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:white;padding:40px 36px;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:440px;text-align:center}
  .step{display:inline-block;background:#deecf9;color:#0078d4;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;margin-bottom:12px}
  h2{margin:6px 0 12px;color:#107c10;font-size:18px}
  p{margin:8px 0;color:#605e5c;font-size:14px;line-height:1.5}
  .spinner{margin:18px auto 0;width:28px;height:28px;border:3px solid #e1dfdd;border-top-color:#0078d4;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
  <div class="step">Step 2 of 2</div>
  <h2>✓ Signed in as ${String(msEmail || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</h2>
  <p>Now Microsoft will ask you to <b>grant organization permissions</b> for CloudFuze Migration.</p>
  <p style="font-size:12px;color:#888">This happens once per tenant. After you click <b>Accept</b>, this window will close.</p>
  <div class="spinner"></div>
</div>
<script>setTimeout(() => window.location.replace(${JSON.stringify(consentUrl)}), 1800);</script>
</body></html>`);
    }

    // Already consented (or appUserId missing) — close popup cleanly.
    res.send(`<html><body>
      <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">${msAlready ? '⚠ Account already connected' : '✓ Signed in successfully!'}</h2>
      <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({
            type: 'auth-success',
            alreadyConnected: ${msAlready},
            consentNeeded: ${consentNeeded},
            tenantId: ${JSON.stringify(realTenantId)},
            email: ${JSON.stringify(msEmail)},
          }, '*');
        }
        setTimeout(() => window.close(), 1000);
      </script>
    </body></html>`);
  } catch (err) { res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`); }
});

app.get('/auth/status', (req, res) => {
  const { appUserId, googleEmail, msEmail } = getWorkspaceContext(req);
  res.json({
    authenticated: isAuthenticated(appUserId),
    googleConnected: isGoogleAuthenticated(appUserId),
    msConnected: isAuthenticated(appUserId),
    googleEmail: googleEmail || null,
    msEmail: msEmail || null,
    workspaceReady: !!(googleEmail && msEmail),
  });
});

// ─── OAuth: Google ────────────────────────────────────────────────────────────

app.get('/auth/google/login', (req, res) => {
  try {
    const appUserId = req.session.appUser?._id?.toString();
    const { url } = getGoogleAuthUrl(appUserId);
    res.redirect(url);
  } catch (err) { res.status(500).send(`Google auth error: ${err.message}`); }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.send(`<html><body><h2>Auth failed</h2><p>${error}</p><script>window.close();</script></body></html>`);
    if (!code) return res.status(400).send('No authorization code received');
    const { email, alreadyConnected: gAlready } = await acquireGoogleTokenByCode(code, state);
    if (email) {
      req.session.googleEmail = email;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }
    dbLog.info(`authSessions.upsert — ${email} (google)`);
    res.send(`<html><body>
      <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">${gAlready ? '⚠ Account already connected' : '✓ Google signed in!'}</h2>
      <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
      <script>if (window.opener) { window.opener.postMessage({ type: 'google-auth-success', alreadyConnected: ${!!gAlready} }, '*'); } setTimeout(() => window.close(), 1500);</script>
    </body></html>`);
  } catch (err) { res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`); }
});

app.get('/auth/google/status', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  res.json({ authenticated: isGoogleAuthenticated(appUserId) });
});

app.post('/auth/google/logout', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const accountId = req.query.accountId || req.body?.accountId || null;
  if (accountId) {
    clearGoogleAccount(appUserId, accountId);
    const remaining = getGoogleAccounts(appUserId);
    if (!remaining.length) delete req.session.googleEmail;
    else req.session.googleEmail = remaining[0].email || req.session.googleEmail;
  } else {
    clearGoogleToken(appUserId);
    delete req.session.googleEmail;
  }
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearMsToken(appUserId);
  delete req.session.msEmail;
  res.json({ ok: true });
});

// ─── Auth disconnect ──────────────────────────────────────────────────────────

app.get('/api/auth/google/accounts', requireAuth, (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  res.json({ accounts: getGoogleAccounts(appUserId) });
});

app.post('/api/auth/google/disconnect', requireAuth, (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const { accountId } = req.body || {};
  if (accountId) {
    clearGoogleAccount(appUserId, accountId);
    const remaining = getGoogleAccounts(appUserId);
    if (!remaining.length) delete req.session.googleEmail;
    else req.session.googleEmail = remaining[0].email || req.session.googleEmail;
  } else {
    clearGoogleToken(appUserId);
    delete req.session.googleEmail;
  }
  res.json({ success: true });
});

app.get('/api/auth/ms/accounts', requireAuth, (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  res.json({ accounts: getMsAccounts(appUserId) });
});

// GET /api/auth/ms/users?accountId=... — list directory users for a specific MS account (delegated token).
// Used by Manage Clouds dropdown to show per-tenant users.
app.get('/api/auth/ms/users', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    const accountId = req.query.accountId || null;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const token = await getValidToken(appUserId, accountId);
    const users = [];
    let url = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999';
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Graph API error' });
      users.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
    res.json({ total: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/ms/disconnect', requireAuth, (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  const { accountId } = req.body || {};
  if (accountId) {
    clearMsAccount(appUserId, accountId);
    const remaining = getMsAccounts(appUserId);
    if (!remaining.length) delete req.session.msEmail;
    else req.session.msEmail = remaining[0].email || req.session.msEmail;
  } else {
    clearMsToken(appUserId);
    delete req.session.msEmail;
  }
  res.json({ success: true });
});

// ─── Shared API routes ────────────────────────────────────────────────────────

// User config — tenantId, customerName (permanent per user, updatable)
app.get('/api/config', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    const cfg = await db().collection('userConfig').findOne({ appUserId });
    res.json(cfg || { tenantId: null, customerName: 'Gemini' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    const { tenantId, customerName } = req.body;
    if (tenantId !== undefined && typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId must be a string' });
    }
    if (customerName !== undefined && typeof customerName !== 'string') {
      return res.status(400).json({ error: 'customerName must be a string' });
    }
    await db().collection('userConfig').updateOne(
      { appUserId },
      { $set: { tenantId, customerName, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Migration workspace + job endpoints ─────────────────────────────────────

// One-call state load on login — returns config, mappings, recent workspaces, recent uploads
app.get('/api/init', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.status(401).json({ error: 'Session missing user id' });
    const [config, mappings, recentWorkspaces, recentUploads, chatDoc] = await Promise.all([
      db().collection('userConfig').findOne({ appUserId }),
      db().collection('userMappings').find({ appUserId }).toArray(),
      db().collection('migrationWorkspaces').find({ appUserId }).sort({ startTime: -1 }).limit(10).toArray(),
      db().collection('uploads').find({ appUserId }).sort({ uploadTime: -1 }).limit(5).toArray(),
      db().collection('chatHistory').findOne({ appUserId }),
    ]);
    res.json({ config, mappings, recentWorkspaces, recentUploads, chatMessages: chatDoc?.messages || [], uiState: chatDoc?.uiState || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save chat messages + UI position for cross-device persistence
app.post('/api/chat-history', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.status(401).json({ error: 'Not authenticated' });
    const { messages, uiState } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be array' });
    const update = { messages: messages.slice(-30), updatedAt: new Date() };
    // uiState carries step, migDir, options — enough to restore left-panel position on any device
    if (uiState && typeof uiState === 'object') update.uiState = uiState;
    await db().collection('chatHistory').updateOne({ appUserId }, { $set: update }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Agent SSE chat endpoint ──────────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { message, migrationState, migrationLogs, isSystemTrigger } = req.body;
    await runAgentLoop(req, res, { message, migrationState, migrationLogs, isSystemTrigger, db: db() });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// All migration runs for current user (all directions)
app.get('/api/workspaces', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.status(401).json({ error: 'Session missing user id' });
    const workspaces = await db().collection('migrationWorkspaces')
      .find({ appUserId })
      .sort({ startTime: -1 })
      .limit(50)
      .toArray();
    res.json(workspaces);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Jobs for a specific workspace
app.get('/api/jobs/:workspaceId', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.status(401).json({ error: 'Session missing user id' });
    const jobs = await db().collection('migrationJobs')
      .find({ workspaceId: req.params.workspaceId, appUserId })
      .sort({ startTime: 1 })
      .toArray();
    res.json(jobs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Retry a single failed job (marks it retried; actual re-run done by agent)
app.post('/api/jobs/:jobId/retry', requireAuth, async (req, res) => {
  try {
    const { appUserId } = getWorkspaceContext(req);
    if (!appUserId) return res.status(401).json({ error: 'Session missing user id' });
    const job = await db().collection('migrationJobs')
      .findOne({ jobId: req.params.jobId, appUserId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'failed') return res.status(400).json({ error: 'Job is not failed' });
    await db().collection('migrationJobs').updateOne(
      { jobId: job.jobId },
      { $set: { status: 'retried', retriedAt: new Date() } }
    );
    res.json({ ok: true, jobId: job.jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: manage app users
app.get('/api/users', requireAuth, async (req, res) => {
  if (req.session.appUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const users = await db().collection('appUsers').find({}, { projection: { password: 0 } }).toArray();
  res.json(users);
});

app.post('/api/users', requireAuth, async (req, res) => {
  if (req.session.appUser.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { email, name, password, role = 'user' } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, name, password required' });
  const hashed = await bcrypt.hash(password, 10);
  try {
    await db().collection('appUsers').insertOne({ email: email.toLowerCase().trim(), password: hashed, name, role, createdAt: new Date() });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ─── Agent audit routes ───────────────────────────────────────────────────────

// List recent agent sessions (distinct sessionIds, most recent first)
app.get('/audit/sessions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const sessions = await db().collection('agentAuditLog').aggregate([
      { $sort: { ts: -1 } },
      { $group: { _id: '$sessionId', lastTs: { $first: '$ts' }, firstTs: { $last: '$ts' }, eventCount: { $sum: 1 }, appUserId: { $first: '$appUserId' } } },
      { $sort: { lastTs: -1 } },
      { $limit: limit },
      { $project: { sessionId: '$_id', lastTs: 1, firstTs: 1, eventCount: 1, appUserId: 1, _id: 0 } }
    ]).toArray();
    res.json(sessions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all events for a specific session
app.get('/audit/session/:id', async (req, res) => {
  try {
    const events = await db().collection('agentAuditLog')
      .find({ sessionId: req.params.id })
      .sort({ ts: 1 })
      .toArray();
    res.json(events);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SSE stream of live audit events
app.get('/audit/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onEvent = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  auditEmitter.on('event', onEvent);
  req.on('close', () => auditEmitter.off('event', onEvent));
});

// ─── Mount module routers ─────────────────────────────────────────────────────

// G2C router — all paths are relative to /api (kept identical to original server.js paths)
const g2cRouter = createG2CRouter({
  db,
  getGoogleOAuth2Client,
  isAuthenticated,
  getValidToken,
  isGoogleAuthenticated,
});
app.use('/api', g2cRouter);

// C2G router — mounted at /api/c2g (paths inside router are relative to that)
const c2gRouter = createC2GRouter({
  db,
  isAuthenticated,
  getValidToken,
  getCurrentTenantId: () => currentTenantId,
});
app.use('/api/c2g', c2gRouter);

// CL2G router — mounted at /api/cl2g (Claude → Gemini; self-contained)
const cl2gRouter = createCL2GRouter({ db });
app.use('/api/cl2g', cl2gRouter);

// CL2C router — mounted at /api/cl2c (Claude → Copilot/OneNote)
const cl2cRouter = createCL2CRouter({ db, isAuthenticated, getValidToken, getCurrentTenantId: () => currentTenantId });
app.use('/api/cl2c', cl2cRouter);

// G2G router — mounted at /api/g2g (Gemini → Gemini)
const g2gRouter = createG2GRouter({ db, getGoogleOAuth2Client });
app.use('/api/g2g', g2gRouter);

app.use('/copilot', createCopilotRouter());

// C2C router — mounted at /api/c2c (Copilot → Copilot, cross-tenant)
const c2cRouter = createC2CRouter({ db });
app.use('/api/c2c', c2cRouter);

// Tenant consent callback for C2C — outside /api prefix so MS can redirect to it
app.get('/auth/ms/tenant-consent-callback', createTenantConsentCallback({ db }));

// ─── Index bootstrap ──────────────────────────────────────────────────────────

async function ensureIndexes(database) {
  const idx = (col, spec, opts = {}) =>
    database.collection(col).createIndex(spec, { ...opts, background: true });

  await Promise.all([
    idx('migrationWorkspaces', { appUserId: 1, startTime: -1 }),
    idx('migrationJobs',       { workspaceId: 1, appUserId: 1 }),
    idx('migrationJobs',       { jobId: 1 }, { unique: true }),
    idx('userMappings',        { appUserId: 1, migDir: 1 }, { unique: true }),
    idx('uploads',             { appUserId: 1, uploadTime: -1 }),
    idx('userConfig',          { appUserId: 1 }, { unique: true }),
    idx('cachedUsers',         { appUserId: 1, role: 1, migDir: 1 }),
  ]);
}

// ─── Startup ──────────────────────────────────────────────────────────────────

connectMongo().then(async () => {
  // Connect Mongoose to cogem DB (C2G migration state)
  try {
    const { connectDB } = await import('./src/db/cogemConnection.js');
    await connectDB();
  } catch (e) {
    console.warn('[cogem] Copilot DB connect failed (non-fatal):', e.message);
  }

  try {
    await ensureIndexes(db());
  } catch (e) {
    console.warn('[startup] Index creation failed:', e.message);
  }

  await restoreGoogleSessions();
  await restoreMsSessions();
  const httpServer = app.listen(PORT, () => {
    console.log(`\nCloudFuze Migration`);
    console.log(`Open: http://localhost:${PORT}\n`);
  });

  // Proxy /novnc/websockify WebSocket upgrades → websockify on port 6080
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/novnc/websockify')) return;
    const upstream = net.createConnection(6080, '127.0.0.1');
    upstream.on('connect', () => {
      const upstreamPath = req.url.replace('/novnc', '');
      let raw = `${req.method} ${upstreamPath} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${v}\r\n`;
      raw += '\r\n';
      upstream.write(raw);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
