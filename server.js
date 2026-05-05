import 'dotenv/config';
import express from 'express';

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

import { getAuthUrl, acquireTokenByCode, isAuthenticated, getValidToken, clearMsToken, restoreMsSessions } from './src/core/auth/microsoft.js';
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, getGoogleOAuth2Client, clearGoogleToken, restoreGoogleSessions } from './src/core/auth/googleOAuth.js';
import { connectMongo, getDb } from './src/db/mongo.js';
import { getLogger } from './src/utils/logger.js';
import { createG2CRouter } from './src/modules/g2c/routes.js';
import { createC2GRouter } from './src/modules/c2g/routes.js';
import { createCL2GRouter } from './src/modules/cl2g/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

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

// ─── Public API ───────────────────────────────────────────────────────────────

app.get('/api/app-config', (req, res) => {
  res.json({ showReset: process.env.SHOW_RESET_BUTTON === 'true' });
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

const PUBLIC_PATHS = ['/api/login', '/api/me', '/api/logout', '/audit/sessions', '/audit/stream'];
app.use('/api', (req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (!req.session?.appUser) return res.status(401).json({ error: 'Not logged in' });
  next();
});
app.use('/auth', (req, res, next) => {
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
    const { code, error, error_description, state } = req.query;
    if (error) return res.send(`<html><body><h2>Auth failed</h2><p>${error_description || error}</p><script>window.close();</script></body></html>`);
    if (!code) return res.status(400).send('No authorization code received');
    const msResult = await acquireTokenByCode(code, state);
    const msEmail = msResult.email || msResult?.account?.username || null;
    if (msEmail) {
      req.session.msEmail = msEmail;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }
    dbLog.info(`authSessions.upsert — ${msEmail} (microsoft)`);
    res.send(`<html><body>
      <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">✓ Signed in successfully!</h2>
      <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
      <script>if (window.opener) { window.opener.postMessage({ type: 'auth-success' }, '*'); } setTimeout(() => window.close(), 1500);</script>
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
    res.redirect(getGoogleAuthUrl(appUserId));
  } catch (err) { res.status(500).send(`Google auth error: ${err.message}`); }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.send(`<html><body><h2>Auth failed</h2><p>${error}</p><script>window.close();</script></body></html>`);
    if (!code) return res.status(400).send('No authorization code received');
    const { email } = await acquireGoogleTokenByCode(code, state);
    if (email) {
      req.session.googleEmail = email;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }
    dbLog.info(`authSessions.upsert — ${email} (google)`);
    res.send(`<html><body>
      <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">✓ Google signed in!</h2>
      <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
      <script>if (window.opener) { window.opener.postMessage({ type: 'google-auth-success' }, '*'); } setTimeout(() => window.close(), 1500);</script>
    </body></html>`);
  } catch (err) { res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`); }
});

app.get('/auth/google/status', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  res.json({ authenticated: isGoogleAuthenticated(appUserId) });
});

app.post('/auth/google/logout', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearGoogleToken(appUserId);
  delete req.session.googleEmail;
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearMsToken(appUserId);
  delete req.session.msEmail;
  res.json({ ok: true });
});

// ─── Auth disconnect ──────────────────────────────────────────────────────────

app.post('/api/auth/google/disconnect', requireAuth, (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearGoogleToken(appUserId);
  delete req.session.googleEmail;
  res.json({ success: true });
});

app.post('/api/auth/ms/disconnect', requireAuth, (req, res) => {
  const { appUserId } = getWorkspaceContext(req);
  clearMsToken(appUserId);
  delete req.session.msEmail;
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
  app.listen(PORT, () => {
    console.log(`\nCloudFuze Migration`);
    console.log(`Open: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
