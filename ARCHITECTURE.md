# GEM_CO — Architecture Document

## Project Overview

**GEM_CO** (Gemini → Copilot Migration Tool) is a multi-tenant enterprise web application that migrates Google Gemini conversation history into Microsoft 365. It is built by CloudFuze and runs as a self-hosted Node.js server.

**What it does end-to-end:**
1. Admin authenticates with Google (OAuth2) and Microsoft (MSAL delegated)
2. Exports Gemini conversations from Google Vault as XML
3. Correlates conversations with accessed Google Drive files via audit logs
4. Optionally generates Microsoft Copilot responses using Azure OpenAI
5. Creates rich OneNote pages in target M365 users' notebooks
6. Uploads correlated Drive files to OneDrive
7. Deploys a Teams Declarative Copilot Agent for conversation discovery

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | ≥ 18.0.0 |
| Backend | Express.js | 5.2.1 |
| Frontend | React 18 + Babel (CDN) | 18.2.0 |
| Database | MongoDB | 7.1.1 |
| MS Auth | @azure/msal-node | 2.9.2 |
| Google Auth | googleapis | 140.0.0 |
| Password | bcryptjs | 3.0.3 |
| Sessions | express-session | 1.19.0 |
| File Upload | multer + adm-zip | 2.1.1 / 0.5.16 |
| XML Parsing | xml2js | 0.6.2 |
| AI | openai (Azure) | 4.52.0 |

---

## System Architecture Diagram

> Please generate a visual architecture diagram from the following description using a clean, modern style with color-coded layers.

### Layers (top to bottom):

**Layer 1 — Browser (React SPA)**
- Single-page app served from `ui/index.html`
- 8-step wizard: Login → Connect Clouds → Select Users → Map Emails → Vault Export → Upload → Configure → Migrate → Reports
- Communicates with server via REST + SSE (Server-Sent Events for live migration logs)

**Layer 2 — Express Server (`server.js`)**
- App login/logout (bcrypt session auth)
- OAuth relay for Google + Microsoft popup flows
- Migration orchestrator (runs pipeline, streams SSE logs)
- REST APIs: /api/upload, /api/migrate, /api/reports, /api/user-mappings, /api/google/*, /api/ms/*
- Workspace isolation middleware: every request scoped by `{ appUserId, googleEmail, msEmail }`

**Layer 3 — Migration Pipeline (src/modules/)**

```
VaultReader → AssetScanner → FileCorrelator → ResponseGenerator → DriveFileMatcher → PagesCreator → ReportWriter
```

| Module | Input | Output |
|---|---|---|
| VaultReader | ZIP extract path | Conversations[] per user |
| AssetScanner | Conversations[] | Flagged conversations (visual assets) |
| FileCorrelator | Conversations[] + Google OAuth | Conversations enriched with driveFiles[] via audit log |
| ResponseGenerator | Conversations[] | Conversations with copilotResponse per turn (Azure OpenAI) |
| DriveFileMatcher | driveFiles[] metadata | Files downloaded from Drive → uploaded to OneDrive |
| PagesCreator | Enriched conversations | OneNote pages created in M365 |
| ReportWriter | Migration results | JSON + CSV report |

**Layer 4 — Auth Modules (src/auth/)**

- `googleOAuth.js` — per-user in-memory session Map + MongoDB persistence, auto token refresh
- `microsoft.js` — MSAL per-user session Map + MongoDB persistence, silent token refresh
- `google.js` — Service Account JWT (domain-wide delegation for Vault + Admin APIs)

**Layer 5 — Database (MongoDB — 11 collections)**

| Collection | Purpose |
|---|---|
| appUsers | Login credentials (bcrypt) |
| authSessions | OAuth tokens per user+provider (persisted across restarts) |
| cloudMembers | Google + M365 user directory cache |
| uploads | Vault ZIP metadata |
| userMappings | Google → M365 email mappings per batch |
| reportsWorkspace | Migration batch results + live progress |
| checkpoints | Resumable migration state (completed users per batch) |
| migrationLogs | Immutable audit trail per batch |
| vaultExports | Google Vault export job tracking |
| agentDeployments | Teams agent catalog records |
| userWorkspace | Cross-device UI state per admin |

**Multi-tenant isolation:** Every collection scoped by compound key `{ appUserId, googleEmail, msEmail }`

**Layer 6 — External APIs**

Google side:
- Google Vault API — submit + download Gemini export jobs
- Google Admin Directory API — list org users
- Google Admin Reports API — Drive audit log (file access events ±60s matching)
- Google Drive API — download files for OneDrive upload

Microsoft side:
- Microsoft Graph — OneNote (notebook/section/page creation), OneDrive (file upload), Teams App Catalog (agent publish)
- Azure OpenAI (GPT-4o) — generate Copilot responses as fallback

---

## Migration Pipeline — Detailed Flow

```
[Admin Browser]
     │
     ▼
POST /api/migrate
     │
     ├─ DRY RUN? → log plan only, return
     │
     ▼
Generate batchId = Date.now()
Store reportsWorkspace { status: "running" }
     │
     ▼
FOR EACH selected Google user (max 5 concurrent):
     │
     ├─ 1. VaultReader.loadUserConversations(googleEmail)
     │      Parses XML → Conversation[]
     │      Each conversation: { id, title, turns: [{ timestamp, prompt, response }] }
     │
     ├─ 2. AssetScanner.scan(conversations)
     │      Detects image refs + chart code → flags conversations
     │
     ├─ 3. FileCorrelator.enrichConversations(conversations)
     │      FOR EACH turn:
     │        Query Admin Reports API for "view"/"access_item_content" events
     │        Match events within ±60s of turn timestamp
     │        Attach { docId, docTitle, mimeType } to turn.driveFiles[]
     │
     ├─ 4. ResponseGenerator.generate(conversations)
     │      FOR EACH turn:
     │        POST to Azure OpenAI GPT-4o with original Gemini prompt
     │        Attach copilotResponse to turn (memory only)
     │
     ├─ 5. FOR EACH conversation:
     │      DriveFileMatcher.uploadToOneDrive(turn.driveFiles)
     │        Download from Google Drive (export Google Docs → Office format)
     │        PUT to /users/{m365Email}/drive/root:/GeminiMigration/{file}:/content
     │        Dedup cache per conversation
     │
     ├─ 6. PagesCreator.createPage(m365Email, conversation)
     │        Ensure notebook + section exist in m365Email's OneNote
     │        Build rich HTML (prompts, responses, file links, warnings)
     │        POST to /users/{m365Email}/onenote/sections/{id}/pages
     │
     └─ 7. CheckpointManager.markComplete(googleEmail)
           Stored to MongoDB checkpoints collection
     │
     ▼
AgentDeployer.deployAgent()
  Check /appCatalogs/teamsApps for "Gemini Conversation Agent"
  If missing: build manifest.zip + POST to catalog
  If exists: reuse (no duplicate)
  Return manual install instructions
     │
     ▼
ReportWriter.write() → migration_report.json
reportsWorkspace.update({ status: "completed", report: {...} })
emit("done") → SSE stream to browser
```

---

## Authentication Flow

### App Login
```
Browser POST /api/login { email, password }
  → bcrypt.compare with appUsers collection
  → session.appUser = { _id, email, name, role }
  → restore googleEmail + msEmail from authSessions
```

### Google OAuth (popup)
```
/auth/google/login
  → getGoogleAuthUrl(appUserId) with state=base64({appUserId})
  → User consents in popup
/auth/google/callback
  → decode state → appUserId
  → exchange code → refresh_token + access_token
  → persist to authSessions collection
  → session.googleEmail = profile.email
```

### Microsoft MSAL (popup)
```
/auth/login?tenant_id=xxx
  → getAuthUrl(tenantId, appUserId) with state=base64({appUserId, tenantId})
  → Admin consents delegated scopes in popup
/auth/callback
  → decode state → appUserId, tenantId
  → MSAL acquireTokenByCode → delegated access_token
  → persist to authSessions collection
  → session.msEmail = account.username
```

### Token Persistence (Server Restart Survival)
```
Server boot:
  → connectMongo()
  → restoreGoogleSessions() — rebuild OAuth2 clients from authSessions
  → restoreMsSessions()     — rebuild MSAL clients from authSessions
  → Sessions active until manual "Disconnect" click
```

---

## Multi-Tenant Workspace Isolation

Every admin login creates an isolated workspace scoped by:
```
{ appUserId, googleEmail, msEmail }
```

- Admin A + Google=zara + MS=erik → sees only their data
- Admin A + Google=alex + MS=dan → separate workspace, previous data preserved
- Admin B + same Google + same MS → separate workspace (different appUserId)

All MongoDB reads/writes include this composite filter. SSE migration logs streamed only to the requesting admin.

---

## Key Data Structures

### Conversation (in-memory, never persisted)
```javascript
{
  id: "c_xxxxxxxxx",
  title: "ADK Resources for Multi-Agent Systems",
  created_at: Date,
  turns: [
    {
      timestamp: Date,
      prompt: "User's original Gemini prompt",
      response: "Original Gemini response",
      copilotResponse: "Azure OpenAI generated response",
      hasFileRef: true,
      driveFiles: [
        {
          fileName: "report.pdf",
          driveFileId: "1abc...",
          mimeType: "application/pdf",
          oneDriveUrl: "https://...",
          uploadError: null
        }
      ]
    }
  ]
}
```

### Workspace State (MongoDB userWorkspace)
```javascript
{
  userId: ObjectId,
  googleEmail: "zara@storefuze.com",
  msEmail: "erik@filefuze.co",
  step: 7,
  uploadData: { id, users, totalConversations },
  config: { customerName, tenantId, dryRun, skipAI },
  mappings: { "zara@storefuze.com": "alex@filefuze.co" },
  selectedUsers: ["zara@storefuze.com"],
  currentBatchId: "1775827551041",
  updatedAt: Date
}
```

---

## Folder Structure

```
GEM_CO/
├── server.js                      # Express app + all routes (1374 lines)
├── migrate.js                     # CLI entry point (batch migration)
├── package.json
├── .env                           # Secrets (not in git)
├── .gitignore
│
├── src/
│   ├── auth/
│   │   ├── google.js              # Service account JWT (Vault + Admin APIs)
│   │   ├── googleOAuth.js         # OAuth2 per-user sessions
│   │   └── microsoft.js           # MSAL per-user sessions
│   │
│   ├── db/
│   │   └── mongo.js               # Connection + 11 collection schemas + seed
│   │
│   ├── modules/
│   │   ├── vaultReader.js         # XML parser (Vault exports)
│   │   ├── vaultExporter.js       # Vault API (submit + download jobs)
│   │   ├── assetScanner.js        # Visual asset detection
│   │   ├── auditLogClient.js      # Google Admin Reports API
│   │   ├── fileCorrelator.js      # Audit log → drive file correlation
│   │   ├── driveFileMatcher.js    # Drive download + OneDrive upload
│   │   ├── responseGenerator.js   # Azure OpenAI Copilot responses
│   │   ├── pagesCreator.js        # OneNote page creation
│   │   ├── permissionsChecker.js  # OAuth scope validation
│   │   └── reportWriter.js        # JSON/CSV report generation
│   │
│   ├── agent/
│   │   └── agentDeployer.js       # Teams Declarative Copilot Agent publisher
│   │
│   └── utils/
│       ├── logger.js              # Structured logger (no PII)
│       └── checkpoint.js          # Resumable migration state
│
├── ui/
│   ├── index.html                 # React SPA (Babel runtime, 8-step wizard)
│   └── assets/
│       └── CloudFuze blue.png     # Brand logo
│
└── uploads/                       # Vault ZIPs + extracted XML (gitignored)
```

---

## Environment Variables

```bash
PORT=3000
BASE_URL=http://localhost:3000
SESSION_SECRET=<random>
MONGO_URI=mongodb+srv://...
MONGO_DATABASE=gemco

GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_SERVICE_ACCOUNT_PATH=./service_account.json

AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...

AZURE_OPENAI_ENDPOINT=https://<instance>.openai.azure.com/
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

---

## Error Recovery

- **Dry Run**: Full pipeline simulation with no API calls — validates mappings before live run
- **Checkpoints**: Per-batch completed users stored in MongoDB — server restart resumes from last checkpoint
- **Retry API**: `/api/migrate/retry` re-runs only failed conversations from a completed batch
- **Upload dedup**: Per-conversation cache prevents duplicate OneDrive uploads (avoids 409 conflicts)
- **Silent token refresh**: Both Google and Microsoft tokens auto-refresh 5 minutes before expiry

---

## Security Notes

- Passwords hashed with bcrypt (10 rounds)
- Sessions: 24-hour max age, HttpOnly
- OAuth tokens persisted to MongoDB, never exposed to frontend
- All data isolated per workspace (multi-tenant composite indexes)
- Conversation content never written to database or disk — memory only
- Logs contain no PII, credentials, or conversation content
- `.env` excluded from git via `.gitignore`
