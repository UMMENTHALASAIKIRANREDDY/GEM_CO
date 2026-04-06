import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { EventEmitter } from 'events';

import { getAuthUrl, acquireTokenByCode, isAuthenticated, getDelegatedToken, clearMsToken } from './src/auth/microsoft.js';
import { getGoogleAuthUrl, acquireGoogleTokenByCode, isGoogleAuthenticated, getGoogleOAuth2Client, clearGoogleToken } from './src/auth/googleOAuth.js';
import { google } from 'googleapis';
import { VaultReader } from './src/modules/vaultReader.js';
import { VaultExporter } from './src/modules/vaultExporter.js';
import { AssetScanner } from './src/modules/assetScanner.js';
import { ResponseGenerator } from './src/modules/responseGenerator.js';
import { PagesCreator } from './src/modules/pagesCreator.js';
import { ReportWriter } from './src/modules/reportWriter.js';
import { CheckpointManager } from './src/utils/checkpoint.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const migrationEvents = new EventEmitter();
const logBuffer = []; // replay buffer for late SSE clients

// Store tenant ID for auth flow
let currentTenantId = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'ui')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.zip')) cb(null, true);
    else cb(new Error('Only ZIP files are accepted'));
  }
});

// ─── OAuth: Sign in with Microsoft ────────────────────────────────────────────

// Step 1: Redirect admin to Microsoft login
app.get('/auth/login', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    if (!tenantId) return res.status(400).send('tenant_id query parameter required');
    currentTenantId = tenantId;
    const authUrl = await getAuthUrl(tenantId);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// Step 2: Microsoft redirects here after admin signs in
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      return res.send(`<html><body><h2>Auth failed</h2><p>${error_description || error}</p><script>window.close();</script></body></html>`);
    }
    if (!code) return res.status(400).send('No authorization code received');

    await acquireTokenByCode(currentTenantId, code);

    // Close the popup and notify the parent window
    res.send(`
      <html><body>
        <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">✓ Signed in successfully!</h2>
        <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
        <script>
          if (window.opener) { window.opener.postMessage({ type: 'auth-success' }, '*'); }
          setTimeout(() => window.close(), 1500);
        </script>
      </body></html>
    `);
  } catch (err) {
    res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`);
  }
});

// Step 3: UI polls this to check auth status
app.get('/auth/status', (_req, res) => {
  res.json({ authenticated: isAuthenticated() });
});

// ─── OAuth: Sign in with Google ──────────────────────────────────────────────

app.get('/auth/google/login', (_req, res) => {
  try {
    const authUrl = getGoogleAuthUrl();
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Google auth error: ${err.message}`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) {
      return res.send(`<html><body><h2>Auth failed</h2><p>${error}</p><script>window.close();</script></body></html>`);
    }
    if (!code) return res.status(400).send('No authorization code received');

    await acquireGoogleTokenByCode(code);

    res.send(`
      <html><body>
        <h2 style="font-family:Segoe UI,sans-serif;color:#107c10">✓ Google signed in!</h2>
        <p style="font-family:Segoe UI,sans-serif;color:#605e5c">You can close this window.</p>
        <script>
          if (window.opener) { window.opener.postMessage({ type: 'google-auth-success' }, '*'); }
          setTimeout(() => window.close(), 1500);
        </script>
      </body></html>
    `);
  } catch (err) {
    res.send(`<html><body><h2>Auth error</h2><p>${err.message}</p><script>window.close();</script></body></html>`);
  }
});

app.get('/auth/google/status', (_req, res) => {
  res.json({ authenticated: isGoogleAuthenticated() });
});

app.post('/auth/google/logout', (_req, res) => {
  clearGoogleToken();
  res.json({ ok: true });
});

app.post('/auth/logout', (_req, res) => {
  clearMsToken();
  res.json({ ok: true });
});

// ─── Google Users (Admin SDK) ────────────────────────────────────────────────

app.get('/api/google/users', async (_req, res) => {
  try {
    const auth = getGoogleOAuth2Client();
    const admin = google.admin({ version: 'directory_v1', auth });
    const users = [];
    let pageToken = undefined;

    do {
      const resp = await admin.users.list({
        customer: 'my_customer',
        maxResults: 200,
        orderBy: 'email',
        pageToken,
      });
      if (resp.data.users) {
        users.push(...resp.data.users.map(u => ({
          email: u.primaryEmail,
          name: u.name?.fullName || u.primaryEmail,
        })));
      }
      pageToken = resp.data.nextPageToken;
    } while (pageToken);

    res.json({ total: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Vault Export ─────────────────────────────────────────────────────

// Active export tracking
let activeExport = null;

app.post('/api/google/vault-export', async (req, res) => {
  try {
    const { user_emails } = req.body;
    if (!user_emails || user_emails.length === 0) {
      return res.status(400).json({ error: 'user_emails array required' });
    }

    const auth = getGoogleOAuth2Client();
    const exporter = new VaultExporter(auth);

    const matter = await exporter.createMatter(`GEM_CO Export ${new Date().toISOString()}`);
    const exportData = await exporter.createExport(matter.matterId, user_emails);

    activeExport = {
      matterId: matter.matterId,
      exportId: exportData.id,
      status: 'IN_PROGRESS',
      userEmails: user_emails,
      exporter,
    };

    res.json({ matter_id: matter.matterId, export_id: exportData.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google/vault-export/status', async (_req, res) => {
  try {
    if (!activeExport) {
      return res.status(404).json({ error: 'No active export' });
    }

    const { exporter, matterId, exportId } = activeExport;
    
    console.log(`[${new Date().toISOString()}] UI polling export status for ${exportId}...`);
    
    const exportRes = await exporter.vault.matters.exports.get({ matterId, exportId });
    const status = exportRes.data.status;
    const stats = exportRes.data.stats || {};
    
    console.log(`[${new Date().toISOString()}] Export status: ${status}, exported=${stats.exportedArtifactCount || 0}, total=${stats.totalArtifactCount || 0}`);
    
    activeExport.status = status;

    if (status === 'COMPLETED') {
      console.log(`[${new Date().toISOString()}] Export completed! Starting download...`);
      
      // Download and extract
      const destDir = path.join(__dirname, 'uploads', `vault_export_${Date.now()}`);
      await exporter.downloadExport(matterId, exportId, destDir);
      await exporter.closeMatter(matterId);

      console.log(`[${new Date().toISOString()}] Download complete, extracting zips and parsing XML files...`);

      // Extract any zip files from the Vault export
      const zipFiles = fs.readdirSync(destDir).filter(f => f.toLowerCase().endsWith('.zip'));
      for (const zf of zipFiles) {
        const zipPath = path.join(destDir, zf);
        try {
          new AdmZip(zipPath).extractAllTo(destDir, true);
          console.log(`[${new Date().toISOString()}] Extracted: ${zf}`);
        } catch (e) {
          console.log(`[${new Date().toISOString()}] Could not extract ${zf}: ${e.message}`);
        }
      }

      // Parse with VaultReader — same as /api/upload
      const xmlFiles = fs.readdirSync(destDir).filter(f => f.toLowerCase().endsWith('.xml'));
      if (xmlFiles.length === 0) {
        console.log(`[${new Date().toISOString()}] ERROR: No XML files found in export`);
        return res.json({ status, error: 'Export completed but no XML files found.' });
      }

      const reader = new VaultReader(destDir);
      const users = await reader.discoverUsers();

      console.log(`[${new Date().toISOString()}] Parsed ${users.length} users from export`);

      activeExport = null;

      return res.json({
        status,
        upload_id: path.basename(destDir),
        extract_path: destDir,
        total_users: users.length,
        total_conversations: users.reduce((s, u) => s + u.conversationCount, 0),
        users: users.map(u => ({
          email: u.email,
          display_name: u.displayName,
          conversation_count: u.conversationCount,
        })),
      });
    }

    if (status === 'FAILED') {
      console.log(`[${new Date().toISOString()}] Export FAILED`);
      activeExport = null;
      return res.json({ status, error: 'Vault export failed' });
    }

    res.json({ status });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking export status:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── MS Users list (for CSV download) ────────────────────────────────────────
app.get('/api/ms/users', async (req, res) => {
  try {
    if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    const token = getDelegatedToken();
    let users = [];
    let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName&$top=999';
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data.error?.message || 'Graph API error' });
      users = users.concat(data.value || []);
      url = data['@odata.nextLink'] || null;
    }
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload ZIP ───────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('vault_zip'), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const extractTo = path.join(__dirname, 'uploads', `extracted_${req.file.filename}`);

    fs.mkdirSync(extractTo, { recursive: true });
    new AdmZip(zipPath).extractAllTo(extractTo, true);

    const xmlFiles = fs.readdirSync(extractTo)
      .filter(f => f.toLowerCase().endsWith('.xml'));

    if (xmlFiles.length === 0) {
      return res.status(400).json({
        error: 'No XML files found in ZIP. Vault export should contain .xml files named after user emails.',
        files_found: fs.readdirSync(extractTo).slice(0, 20)
      });
    }

    const reader = new VaultReader(extractTo);
    const users = await reader.discoverUsers();

    if (users.length === 0) {
      return res.status(400).json({ error: 'No users found in Vault export XML files.' });
    }

    res.json({
      upload_id: req.file.filename,
      extract_path: extractTo,
      total_users: users.length,
      total_conversations: users.reduce((s, u) => s + u.conversationCount, 0),
      users: users.map(u => ({
        email: u.email,
        display_name: u.displayName,
        conversation_count: u.conversationCount
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Report Downloads ─────────────────────────────────────────────────────────
app.get('/api/reports/migration', (req, res) => {
  const p = path.join(__dirname, 'uploads', 'migration_report.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No report yet' });
  res.setHeader('Content-Disposition', 'attachment; filename="migration_report.json"');
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(p).pipe(res);
});

app.get('/api/reports/visual-assets', (req, res) => {
  const p = path.join(__dirname, 'uploads', 'visual_assets_report.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No report yet' });
  res.setHeader('Content-Disposition', 'attachment; filename="visual_assets_report.json"');
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(p).pipe(res);
});

// ─── SSE — live log stream ────────────────────────────────────────────────────
app.get('/api/migration-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Replay all buffered logs to late-joining clients
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const onLog = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  migrationEvents.on('log', onLog);
  req.on('close', () => migrationEvents.off('log', onLog));
});

function emit(type, message, extra = {}) {
  const entry = { type, message, ts: new Date().toISOString(), ...extra };
  logBuffer.push(entry);
  migrationEvents.emit('log', entry);
}

// ─── Start Migration ──────────────────────────────────────────────────────────
app.post('/api/migrate', async (req, res) => {
  const {
    extract_path,
    tenant_id,
    customer_name = 'Gemini',
    user_mappings = {},
    dry_run = false,
    skip_followups = false,
    from_date = null,
    to_date = null
  } = req.body;

  if (!extract_path || !tenant_id) {
    return res.status(400).json({ error: 'extract_path and tenant_id are required' });
  }

  if (!dry_run && !isAuthenticated()) {
    return res.status(401).json({ error: 'Admin not signed in. Click "Sign in with Microsoft" first.' });
  }

  res.json({ started: true });
  runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, from_date, to_date });
});

async function withConcurrency(items, limit, fn) {
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    executing.push(p);
    const clean = () => executing.splice(executing.indexOf(p), 1);
    p.then(clean, clean);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.all(executing);
}

async function runMigration({ extract_path, tenant_id, customer_name, user_mappings, dry_run, skip_followups, from_date, to_date }) {
  logBuffer.length = 0; // clear previous run's logs
  await new Promise(r => setTimeout(r, 200));
  emit('info', '━━━ Migration started ━━━');

  try {
    const reader = new VaultReader(extract_path);
    const users = await reader.discoverUsers();

    emit('info', `Discovered ${users.length} users from Vault export`);

    if (dry_run) {
      for (const u of users) {
        const m365Email = user_mappings[u.email] || u.email;
        emit('user', `${u.email} → ${m365Email} (${u.conversationCount} conversations)`);
      }
      const total = users.reduce((s, u) => s + u.conversationCount, 0);
      emit('done', `DRY RUN complete — ${users.length} users, ${total} conversations. No API calls made.`);
      return;
    }

    // Module 2 — Asset Scanner
    const scanner = new AssetScanner();
    const visualReports = {};
    for (const u of users) {
      const convs = await reader.loadUserConversations(u.email, from_date, to_date);
      visualReports[u.email] = scanner.scan(u.email, convs);
      if (visualReports[u.email].length > 0) {
        emit('warn', `${u.email}: ${visualReports[u.email].length} conversations flagged for visual assets`);
      }
    }

    const report = new ReportWriter();
    const generator = new ResponseGenerator();
    const creator = new PagesCreator(tenant_id, customer_name);
    const checkpoint = new CheckpointManager(path.join(extract_path, '..', 'checkpoint.json'));

    await withConcurrency(users, 5, async (u) => {
      const googleEmail = u.email;
      const m365Email = user_mappings[googleEmail] || googleEmail;

      emit('info', `Processing: ${googleEmail} → ${m365Email}`);

      let conversations = null;
      const errors = [];
      let pagesCreated = 0;

      try {
        conversations = await reader.loadUserConversations(googleEmail, from_date, to_date);
        emit('info', `  Loaded ${conversations.length} conversations for ${googleEmail}`);

        for (const conv of conversations) {
          try {
            const convWithResponses = await generator.generate(conv, skip_followups);
            await creator.createPage(m365Email, convWithResponses, visualReports[googleEmail] || []);
            pagesCreated++;
            emit('success', `  Page created: ${conv.title?.slice(0, 60)}`);
          } catch (err) {
            errors.push({ conversation: conv.title, error: err.message });
            emit('error', `  Failed: ${conv.title?.slice(0, 40)} — ${err.message}`);
          }
        }

        report.addUserResult({
          email: m365Email,
          conversations: conversations.length,
          pagesCreated,
          visualAssetsFlagged: (visualReports[googleEmail] || []).length,
          errors
        });

        checkpoint.markComplete(googleEmail);
        emit('success', `  Done: ${pagesCreated}/${conversations.length} pages created for ${m365Email}`);
      } catch (err) {
        emit('error', `Fatal error for ${googleEmail}: ${err.message}`);
        report.addUserResult({ email: m365Email, conversations: 0, pagesCreated: 0, visualAssetsFlagged: 0, errors: [{ error: err.message }] });
      } finally {
        conversations = null;
      }
    });

    const reportPath = path.join(__dirname, 'uploads', 'migration_report.json');
    const visualPath = path.join(__dirname, 'uploads', 'visual_assets_report.json');
    report.write(reportPath);
    scanner.writeReport(visualPath, visualReports);

    // Auto-deploy Copilot Declarative Agent after migration
    if (!dry_run) {
      emit('info', '━━━ Deploying Copilot Agent ━━━');
      try {
        const targetEmails = users.map(u => user_mappings[u.email] || u.email);
        const deployer = new AgentDeployer(customer_name, tenant_id);
        const appInfo = await deployer.deployAgent(targetEmails);
        emit('success', `Agent "${customer_name} Conversation Agent" published & installed for ${appInfo.installed}/${appInfo.totalUsers} mapped users`);
        if (appInfo.failedEmails?.length > 0) {
          emit('warn', `Could not auto-install for: ${appInfo.failedEmails.join(', ')} — install manually from Teams Admin Center → Manage Apps`);
        }
      } catch (err) {
        emit('warn', `Agent deployment failed (can be done manually): ${err.message}`);
      }
    }

    emit('done', `━━━ Migration complete! Reports saved. ━━━`);
  } catch (err) {
    emit('error', `Migration failed: ${err.message}`);
  }
}

app.listen(PORT, () => {
  console.log(`\nGemini → Copilot Migration UI`);
  console.log(`Open: http://localhost:${PORT}\n`);
});
