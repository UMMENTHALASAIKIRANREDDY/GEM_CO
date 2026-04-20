# PROJECT_CONTEXT.md — Multi-Cloud AI Chat Migration Platform

## Project Overview

**Multi-Cloud AI Chat Migration Platform** by **CloudFuze** — a full-stack web application for migrating AI chat/conversation data between major cloud AI platforms.

### Supported Migration Modes

1. **Copilot → Gemini** — Export Microsoft 365 Copilot chat interactions as DOCX files and upload them to Google Drive.
2. **ChatGPT → Gemini** — Import ChatGPT export ZIP/JSON and migrate conversations as DOCX files to Google Drive.
3. **Gemini → Copilot** — Google Vault export of Gemini conversations migrated to OneNote/OneDrive (in progress).

### Tech Stack

- **Backend**: Node.js / Express (ESM modules)
- **Frontend**: React 18 / Vite
- **Database**: MongoDB (Mongoose) — optional, app runs with in-memory sessions if omitted
- **Microsoft Integration**: Microsoft Graph API, MSAL (Azure AD / Entra ID), OAuth 2.0 Authorization Code Flow
- **Google Integration**: Google APIs (Admin SDK, Drive, Vault), OAuth 2.0, Service Account domain-wide delegation
- **Document Generation**: `docx` library for building Word documents
- **File Handling**: `multer` for uploads, `adm-zip` for ZIP processing, `xml2js` for Vault XML parsing

### 6-Step Wizard Flow

1. **Connect** — Connect Microsoft 365 and Google Workspace admin accounts via OAuth
2. **Select Combination** — Choose migration direction (source → destination)
3. **Chats / Import** — Preview Copilot chats or upload ChatGPT/Gemini export files
4. **Map** — Auto-map or manually map source users to destination users (CSV upload/download)
5. **Migrate** — Select user pairs and execute migration
6. **Reports** — View migration results with success/failure stats and uploaded file links

### UI Features

- Split-pane layout with draggable divider
- Live Migration Log panel (right pane) showing real-time events
- Step-by-step navigation with stepper component
- Cloud connection cards with status badges
- Responsive design with CloudFuze branding (#0129AC primary color)

### Deployment

- Docker multi-stage build (Node 20 Alpine)
- Health check endpoint at `/api/health`
- Production static file serving from Vite build output

---

## File Tree

```
copilot/
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
├── client/
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── index.css
│       ├── App.jsx
│       ├── App.css
│       ├── components/
│       │   ├── AuthPanel.jsx
│       │   ├── ChatsPanel.jsx
│       │   ├── CloudSelector.jsx
│       │   ├── CombinationPanel.jsx
│       │   ├── ExportPanel.jsx
│       │   ├── MapPanel.jsx
│       │   ├── MigratePanel.jsx
│       │   ├── MigrationLog.jsx
│       │   ├── ReportsPanel.jsx
│       │   └── SplitPane.jsx
│       └── utils/
│           └── downloadJson.js
└── server/
    ├── index.mjs
    └── src/
        ├── appClass.js
        ├── auth.js
        ├── chatgptService.js
        ├── copilotService.js
        ├── docBuilder.js
        ├── googleService.js
        ├── graph.js
        ├── graphCredentials.js
        ├── users.js
        ├── auth/
        │   ├── googleOauthRoutes.mjs
        │   ├── msalConfig.js
        │   └── oauthRoutes.mjs
        ├── db/
        │   ├── connection.js
        │   └── models/
        │       ├── ChatsHistory.js
        │       ├── Cloud.js
        │       ├── Job.js
        │       ├── User.js
        │       └── UserMapping.js
        ├── gemini/
        │   ├── vaultExporter.js
        │   └── vaultReader.js
        └── migration/
            └── migrate.js
```

---

## Source Files

---

### `package.json`

```json
{
  "name": "copilot-chat-export",
  "version": "1.0.0",
  "description": "Export Microsoft 365 Copilot chat interactions as JSON and DOCX via Graph API",
  "type": "module",
  "scripts": {
    "start": "node server/index.mjs",
    "dev:api": "node server/index.mjs",
    "dev:ui": "vite --config client/vite.config.js",
    "dev": "concurrently -k \"npm run dev:api\" \"npm run dev:ui\"",
    "build:ui": "vite build --config client/vite.config.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@azure/msal-node": "^5.1.2",
    "adm-zip": "^0.5.17",
    "bcryptjs": "^3.0.3",
    "cors": "^2.8.5",
    "docx": "^9.6.1",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "express-session": "^1.19.0",
    "google-auth-library": "^10.6.2",
    "googleapis": "^171.4.0",
    "jsonwebtoken": "^9.0.3",
    "mongoose": "^9.4.1",
    "multer": "^2.1.1",
    "xml2js": "^0.6.2"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "concurrently": "^9.1.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "vite": "^6.0.7"
  }
}
```

---

### `.env.example`

```env
# =============================================================================
# Microsoft (Azure / Entra ID)
# =============================================================================
AZURE_TENANT_ID=your-azure-tenant-id
AZURE_CLIENT_ID=your-azure-client-id
AZURE_CLIENT_SECRET=your-azure-client-secret

OAUTH_CLIENT_ID=your-oauth-client-id
OAUTH_CLIENT_SECRET=your-oauth-client-secret
OAUTH_REDIRECT_BASE=http://localhost:3000
SOURCE_TENANT_ID=your-source-tenant-id

# =============================================================================
# Graph API options
# =============================================================================
USERS_ODATA_FILTER=accountEnabled eq true
USERS_PAGE_SIZE=999
GRAPH_API_VERSION=v1.0
COPILOT_CHAT_ONLY=true
GRAPH_TOP=100

# =============================================================================
# Server
# =============================================================================
PORT=3000
SESSION_SECRET=generate-a-random-secret-here

# =============================================================================
# MongoDB (optional — app runs with in-memory sessions if omitted)
# =============================================================================
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/cloud-migration?retryWrites=true&w=majority
JWT_SECRET=generate-a-random-jwt-secret-here

# =============================================================================
# Google Workspace
# =============================================================================
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service_account.json
```

---

### `Dockerfile`

```dockerfile
# ── Stage 1: Build the React frontend ──────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY client/ ./client/
COPY server/ ./server/
COPY .env.example ./.env.example

RUN npm run build:ui

# ── Stage 2: Production image ─────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY --from=builder /app/dist/ ./dist/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server/index.mjs"]
```

---

### `.dockerignore`

```
node_modules
dist
.env
service_account.json
*.log
.DS_Store
.git
.gitignore
*.plan.md
data/
copilot_interactions.txt
directory_users.txt
assets/
architecture_diagram.png
architecture_diagram.svg
gemco_architecture_diagram.svg
Architecture_Document.md
mongodb_integration_plan_*.plan.md
```

---

### `.gitignore`

```
node_modules/
.env
service_account.json
copilot_interactions.txt
directory_users.txt
dist/
data/
.DS_Store
*.log
```

---

### `client/index.html`

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/png" href="/cloudfuze-logo.png" />
    <title>Copilot to Gemini Migration — CloudFuze</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

---

### `client/vite.config.js`

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Project root (parent of /client) — same folder as `.env` */
const rootDir = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const apiPort = env.PORT || "3001";

  return {
    root: __dirname,
    plugins: [react()],
    build: {
      outDir: path.resolve(__dirname, "../dist/client"),
      emptyOutDir: true,
    },
    server: {
      port: Number(env.VITE_PORT) || 5173,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
        "/auth": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
```

---

### `client/src/main.jsx`

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

### `client/src/index.css`

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  height: 100%;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  background: #f5f7fa;
  color: #1a1a2e;
  line-height: 1.5;
}

#root {
  width: 100%;
  height: 100%;
}
```

---

### `client/src/App.jsx`

```jsx
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import AuthPanel from "./components/AuthPanel.jsx";
import CombinationPanel from "./components/CombinationPanel.jsx";
import ChatsPanel from "./components/ChatsPanel.jsx";
import MapPanel from "./components/MapPanel.jsx";
import MigratePanel from "./components/MigratePanel.jsx";
import ReportsPanel from "./components/ReportsPanel.jsx";
import MigrationLog from "./components/MigrationLog.jsx";
import SplitPane from "./components/SplitPane.jsx";

const STEP_ICONS = {
  connect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
  ),
  combo: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
  ),
  chats: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
  ),
  import: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  migrate: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  ),
  reports: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
  ),
};

function getStepsForMode(mode) {
  const dataStep = mode === "gemini-copilot" || mode === "chatgpt-gemini"
    ? { id: "import", label: "Import Data", icon: STEP_ICONS.import }
    : { id: "chats", label: "Chats", icon: STEP_ICONS.chats };

  return [
    { id: "connect", label: "Connect", icon: STEP_ICONS.connect },
    { id: "combo", label: "Select Combination", icon: STEP_ICONS.combo },
    dataStep,
    { id: "map", label: "Map", icon: STEP_ICONS.map },
    { id: "migrate", label: "Migrate", icon: STEP_ICONS.migrate },
    { id: "reports", label: "Reports", icon: STEP_ICONS.reports },
  ];
}

const MODE_LABELS = {
  "copilot-gemini": "Copilot → Gemini",
  "gemini-copilot": "Gemini → Copilot",
  "chatgpt-gemini": "ChatGPT → Gemini",
};

export default function App() {
  const [migrationMode, setMigrationMode] = useState(null);
  const [settings, setSettings] = useState(null);
  const [authStatus, setAuthStatus] = useState(null);
  const [usersPayload, setUsersPayload] = useState(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [googleUsersPayload, setGoogleUsersPayload] = useState(null);
  const [loadingGoogleUsers, setLoadingGoogleUsers] = useState(false);
  const [mapping, setMapping] = useState([]);
  const [migrationResults, setMigrationResults] = useState([]);
  const [migrating, setMigrating] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("connect");

  // Migration log state
  const [logEntries, setLogEntries] = useState([]);
  const prevAuth = useRef({ sourceLoggedIn: false, googleLoggedIn: false });

  const addLog = useCallback((message, status = "info", detail = "") => {
    setLogEntries((prev) => [
      ...prev,
      { message, status, detail, timestamp: Date.now() },
    ]);
  }, []);

  const steps = getStepsForMode(migrationMode);

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch("/api/settings");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setSettings(j);
    } catch {
      setSettings(null);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const r = await fetch("/api/users");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      setUsersPayload(j);
      const count = j.users?.length ?? 0;
      addLog(`Loaded ${count} Microsoft user${count !== 1 ? "s" : ""}`, "success");
    } catch {
      setUsersPayload(null);
    } finally {
      setLoadingUsers(false);
    }
  }, [addLog]);

  const loadGoogleUsers = useCallback(async () => {
    setLoadingGoogleUsers(true);
    try {
      const r = await fetch("/api/google/users");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      setGoogleUsersPayload(j);
      const count = j.users?.length ?? 0;
      addLog(`Loaded ${count} Google user${count !== 1 ? "s" : ""}`, "success");
    } catch {
      setGoogleUsersPayload(null);
    } finally {
      setLoadingGoogleUsers(false);
    }
  }, [addLog]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (authStatus?.sourceLoggedIn && !usersPayload && !loadingUsers) {
      loadUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.sourceLoggedIn]);

  useEffect(() => {
    if (authStatus?.googleLoggedIn && !googleUsersPayload && !loadingGoogleUsers) {
      loadGoogleUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.googleLoggedIn]);

  // Log cloud connection/disconnection events
  useEffect(() => {
    if (!authStatus) return;
    const prev = prevAuth.current;

    if (authStatus.sourceLoggedIn && !prev.sourceLoggedIn) {
      addLog(
        `Microsoft 365 connected`,
        "success",
        authStatus.sourceUser || ""
      );
    } else if (!authStatus.sourceLoggedIn && prev.sourceLoggedIn) {
      addLog("Microsoft 365 disconnected", "warning");
    }

    if (authStatus.googleLoggedIn && !prev.googleLoggedIn) {
      addLog(
        `Google Workspace connected`,
        "success",
        authStatus.googleUser || ""
      );
    } else if (!authStatus.googleLoggedIn && prev.googleLoggedIn) {
      addLog("Google Workspace disconnected", "warning");
    }

    prevAuth.current = {
      sourceLoggedIn: !!authStatus.sourceLoggedIn,
      googleLoggedIn: !!authStatus.googleLoggedIn,
    };
  }, [authStatus, addLog]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get("auth") === "success" ||
      params.get("auth") === "google_success"
    ) {
      window.history.replaceState({}, "", "/");
      setTab("connect");
    }
  }, []);

  useEffect(() => {
    setError(null);
  }, [tab]);

  const handleModeChange = (mode) => {
    setMigrationMode(mode);
    setMapping([]);
    setMigrationResults([]);
    addLog(`Migration mode selected: ${MODE_LABELS[mode]}`, "info");
  };

  const handleMappingChange = (newMapping) => {
    setMapping(newMapping);
    const mapped = newMapping.filter((p) => p.sourceEmail && p.destEmail).length;
    addLog(`User mappings ready — ${mapped} users selected`, "info");
  };

  const handleMigrationComplete = (results) => {
    setMigrationResults(results);
    const succeeded = results.filter((r) => r.filesUploaded > 0 && r.errors.length === 0).length;
    const failed = results.filter((r) => r.filesUploaded === 0).length;
    const totalFiles = results.reduce((s, r) => s + r.filesUploaded, 0);

    if (failed === 0) {
      addLog(`Migration complete! ${totalFiles} files uploaded for ${results.length} user(s)`, "success");
    } else {
      addLog(`Migration finished — ${succeeded} succeeded, ${failed} failed`, succeeded > 0 ? "warning" : "error");
    }

    results.forEach((r) => {
      const status = r.filesUploaded > 0 && r.errors.length === 0 ? "success"
        : r.filesUploaded > 0 ? "warning" : "error";
      addLog(
        `${r.sourceDisplayName || r.sourceUserId}: ${r.filesUploaded} files, ${r.conversationsCount} conversations`,
        status,
        r.destUserEmail
      );
    });
  };

  const handleMigratingChange = (isMigrating) => {
    setMigrating(isMigrating);
    if (isMigrating) {
      addLog("Migration started — processing user data…", "info");
    }
  };

  const handleError = (err) => {
    setError(err);
    if (err) {
      addLog(err, "error");
    }
  };

  const titleText = migrationMode
    ? `${MODE_LABELS[migrationMode]} Migration`
    : "Cloud Migration Platform";

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-brand">
          <img src="/cloudfuze-logo.png" alt="CloudFuze" className="app-logo" />
          <h1>{titleText}</h1>
        </div>
        <div className="app-header-status">
          {migrationMode && (
            <span className="header-badge header-badge-ok" style={{ background: "rgba(255,255,255,0.18)" }}>
              {MODE_LABELS[migrationMode]}
            </span>
          )}
          {authStatus?.sourceLoggedIn && (
            <span className="header-badge header-badge-ok">
              Microsoft: {authStatus.sourceUser || "Connected"}
            </span>
          )}
          {authStatus?.googleLoggedIn && (
            <span className="header-badge header-badge-ok">
              Google: {authStatus.googleUser || "Connected"}
            </span>
          )}
        </div>
      </header>

      <nav className="stepper" aria-label="Primary">
        {steps.map(({ id, label, icon }, idx) => {
          const activeIdx = steps.findIndex((s) => s.id === tab);
          const state =
            idx < activeIdx ? "done" : idx === activeIdx ? "active" : "upcoming";
          return (
            <div key={id} className="stepper-item-wrap">
              {idx > 0 && (
                <div
                  className={`stepper-line ${state === "upcoming" ? "" : "stepper-line-done"}`}
                />
              )}
              <button
                type="button"
                className={`stepper-item stepper-${state}`}
                onClick={() => setTab(id)}
              >
                <span className="stepper-icon">{icon}</span>
                <span className="stepper-label">{label}</span>
              </button>
            </div>
          );
        })}
      </nav>

      <SplitPane
        defaultSplit={50}
        minLeft={30}
        minRight={25}
        left={
          <div className="app-body">
            {(() => {
              const stepIds = steps.map((s) => s.id);
              const curIdx = stepIds.indexOf(tab);
              const prevId = curIdx > 0 ? stepIds[curIdx - 1] : null;
              const nextId = curIdx < stepIds.length - 1 ? stepIds[curIdx + 1] : null;
              const canGoNext = tab !== "combo" || migrationMode;
              return (
                <div className="step-nav">
                  {prevId && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setTab(prevId)}
                    >
                      &larr; Back
                    </button>
                  )}
                  {nextId && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setTab(nextId)}
                      disabled={!canGoNext}
                      title={!canGoNext ? "Select a combination first" : ""}
                    >
                      Next &rarr;
                    </button>
                  )}
                </div>
              );
            })()}

            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            {tab === "connect" && (
              <AuthPanel
                authStatus={authStatus}
                onAuthStatusChange={setAuthStatus}
              />
            )}

            {tab === "combo" && (
              <CombinationPanel
                authStatus={authStatus}
                migrationMode={migrationMode}
                onModeChange={handleModeChange}
              />
            )}

            {tab === "chats" && migrationMode === "copilot-gemini" && (
              <ChatsPanel
                usersPayload={usersPayload}
                loadingUsers={loadingUsers}
                onError={handleError}
                addLog={addLog}
              />
            )}

            {tab === "import" && migrationMode === "gemini-copilot" && (
              <ChatsPanel
                usersPayload={usersPayload}
                loadingUsers={loadingUsers}
                onError={handleError}
                migrationMode={migrationMode}
                addLog={addLog}
              />
            )}

            {tab === "import" && migrationMode === "chatgpt-gemini" && (
              <ChatsPanel
                usersPayload={usersPayload}
                loadingUsers={loadingUsers}
                onError={handleError}
                migrationMode={migrationMode}
                addLog={addLog}
              />
            )}

            {tab === "map" && (
              <MapPanel
                msUsers={usersPayload}
                googleUsers={googleUsersPayload}
                loadingMsUsers={loadingUsers}
                loadingGoogleUsers={loadingGoogleUsers}
                mapping={mapping}
                onMappingChange={handleMappingChange}
                onError={handleError}
                migrationMode={migrationMode}
                addLog={addLog}
              />
            )}

            {tab === "migrate" && (
              <MigratePanel
                mapping={mapping}
                onMigrationComplete={handleMigrationComplete}
                onSwitchTab={setTab}
                onError={handleError}
                setMigrating={handleMigratingChange}
                migrationMode={migrationMode}
                addLog={addLog}
              />
            )}

            {tab === "reports" && (
              <ReportsPanel results={migrationResults} migrating={migrating} />
            )}
          </div>
        }
        right={
          <MigrationLog entries={logEntries} migrating={migrating} />
        }
      />
    </div>
  );
}
```

---

### `client/src/App.css`

```css
/* ── App shell ─────────────────────────────────────────────────────── */

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ── Header ─────────────────────────────────────────────────────────── */

.app-header {
  background: #0129AC;
  color: #fff;
  padding: 0.75rem 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-header-brand {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.app-logo {
  height: 36px;
  width: auto;
  filter: brightness(0) invert(1);
}

.app-header h1 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.app-header-status {
  display: flex;
  gap: 1rem;
  font-size: 0.78rem;
  align-items: center;
}

.app-header-status .header-badge {
  background: rgba(255, 255, 255, 0.2);
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-weight: 600;
}

.app-header-status .header-badge-ok {
  background: rgba(255, 255, 255, 0.25);
}

/* ── Stepper ────────────────────────────────────────────────────────── */

.stepper {
  display: flex;
  align-items: center;
  background: #fff;
  padding: 1.25rem 2.5rem;
  border-bottom: 1px solid #e0e5ec;
  flex-shrink: 0;
}

.stepper-item-wrap {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.stepper-item-wrap:first-child {
  flex: 0 0 auto;
}

.stepper-line {
  flex: 1;
  height: 2px;
  background: #dde1e8;
  margin: 0 0.25rem;
  min-width: 1.5rem;
  transition: background 0.25s;
}

.stepper-line-done {
  background: #0129AC;
}

.stepper-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem 0.35rem;
  border-radius: 8px;
  font-family: inherit;
  white-space: nowrap;
  transition: background 0.15s;
}

.stepper-item:hover {
  background: #f0f4ff;
}

.stepper-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 2px solid #dde1e8;
  background: #fff;
  color: #b0b7c3;
  transition: border-color 0.25s, color 0.25s, background 0.25s;
}

.stepper-icon svg {
  width: 16px;
  height: 16px;
}

.stepper-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: #9ca3af;
  transition: color 0.25s;
}

/* Active step */
.stepper-active .stepper-icon {
  border-color: #0129AC;
  color: #0129AC;
  background: #eef2ff;
}

.stepper-active .stepper-label {
  color: #0129AC;
  font-weight: 700;
}

/* Completed step */
.stepper-done .stepper-icon {
  border-color: #0129AC;
  background: #0129AC;
  color: #fff;
}

.stepper-done .stepper-label {
  color: #1a1a2e;
  font-weight: 600;
}

/* Upcoming step */
.stepper-upcoming .stepper-icon {
  border-color: #dde1e8;
  color: #b0b7c3;
  background: #fff;
}

.stepper-upcoming .stepper-label {
  color: #b0b7c3;
}

/* ── Split Pane ────────────────────────────────────────────────────── */

.split-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.split-pane-left {
  overflow-y: auto;
  min-width: 0;
}

.split-pane-right {
  overflow-y: auto;
  min-width: 0;
}

.split-pane-divider {
  flex-shrink: 0;
  width: 8px;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f0f2f5;
  border-left: 1px solid #e0e5ec;
  border-right: 1px solid #e0e5ec;
  transition: background 0.15s;
  z-index: 5;
}

.split-pane-divider:hover {
  background: #dce3ee;
}

.split-pane-handle {
  width: 4px;
  height: 36px;
  border-radius: 2px;
  background: #b0b7c3;
  transition: background 0.15s;
}

.split-pane-divider:hover .split-pane-handle {
  background: #0129AC;
}

/* ── Main content ──────────────────────────────────────────────────── */

.app-body {
  padding: 1.5rem 2rem 3rem;
  height: 100%;
  overflow-y: auto;
}

/* ── Migration Log panel ──────────────────────────────────────────── */

.mlog-panel {
  height: 100%;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mlog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.1rem 1.25rem 0.9rem;
  border-bottom: 1px solid #e0e5ec;
  flex-shrink: 0;
}

.mlog-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0;
}

.mlog-hdr-status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  font-weight: 600;
}

.mlog-hdr-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.mlog-st-waiting .mlog-hdr-dot { background: #d1d5db; }
.mlog-st-waiting { color: #9ca3af; }

.mlog-st-ready .mlog-hdr-dot { background: #22c55e; }
.mlog-st-ready { color: #166534; }

.mlog-st-running .mlog-hdr-dot { background: #0129AC; animation: pulse-dot 1.2s infinite; }
.mlog-st-running { color: #0129AC; }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.mlog-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 0.5rem 0.75rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.mlog-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1.5rem;
  text-align: center;
  color: #9ca3af;
  gap: 0.75rem;
  flex: 1;
}

.mlog-empty-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: #6b7280;
}

.mlog-empty-sub {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 400;
  color: #9ca3af;
  line-height: 1.5;
  max-width: 18rem;
}

/* ── Log entry row ────────────────────────────────────────────────── */

.mlog-row {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
}

/* Category icon (lock/briefcase on the left) */
.mlog-cat {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #0129AC;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 5px;
}

/* ── Pill (the card for each log message) ─────────────────────────── */

.mlog-pill {
  flex: 1;
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.65rem 1rem;
  border-radius: 22px;
  font-size: 0.84rem;
  line-height: 1.45;
  min-height: 40px;
  border: 2px solid transparent;
}

/* Success — saturated blue card (matches reference) */
.mlog-pill-success {
  background: #b8d0f5;
  color: #0a2266;
  border-color: #7aa8e8;
}

/* Info — white card with prominent border */
.mlog-pill-info {
  background: #fff;
  color: #1a1a2e;
  border-color: #9aadca;
}

/* Warning — amber card */
.mlog-pill-warn {
  background: #fef3c7;
  color: #7a4f01;
  border-color: #e8c33a;
}

/* Error — red card */
.mlog-pill-error {
  background: #fee2e2;
  color: #991b1b;
  border-color: #e88080;
}

/* Completion — solid dark blue banner */
.mlog-pill-completion {
  background: #0129AC;
  color: #fff;
  font-weight: 700;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0.75rem 1.1rem;
  gap: 0.5rem;
  border-color: #0129AC;
  border-radius: 22px;
}

.mlog-pill-completion .mlog-pill-time {
  color: rgba(255,255,255,0.65);
}

.mlog-pill-dashes {
  color: rgba(255,255,255,0.3);
  font-weight: 400;
  letter-spacing: 2px;
  font-size: 0.85rem;
}

/* Icon inside pill */
.mlog-pill-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  margin-top: 1px;
}

.mlog-pill-success .mlog-pill-icon {
  color: #1a4dc9;
}

.mlog-pill-info .mlog-pill-icon {
  color: #556680;
}

.mlog-pill-warn .mlog-pill-icon {
  color: #d97706;
}

.mlog-pill-error .mlog-pill-icon {
  color: #dc2626;
}

/* Timestamp inside pill */
.mlog-pill-time {
  flex-shrink: 0;
  font-size: 0.74rem;
  font-family: ui-monospace, monospace;
  opacity: 0.6;
  white-space: nowrap;
  margin-top: 1px;
}

/* Message inside pill */
.mlog-pill-msg {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  font-weight: 700;
}

/* ── Panel ──────────────────────────────────────────────────────────── */

.panel {
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0.9; }
  to { opacity: 1; }
}

.panel-head h2 {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0 0 0.3rem;
  color: #1a1a2e;
}

.panel-desc {
  margin: 0 0 1.25rem;
  color: #6b7280;
  font-size: 0.9rem;
  line-height: 1.55;
  max-width: 52rem;
}

/* ── Buttons ────────────────────────────────────────────────────────── */

.btn {
  appearance: none;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: 0.88rem;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, box-shadow 0.15s;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-primary {
  background: #011f8a;
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: #011f8a;
}

.btn-secondary {
  background: #fff;
  color: #0129AC;
  border: 1px solid #d1d5db;
}

.btn-secondary:hover:not(:disabled) {
  background: #f0f4ff;
  border-color: #011f8a;
}

.btn-small {
  padding: 0.3rem 0.6rem;
  font-size: 0.8rem;
}

.btn-ms {
  background: #0129AC;
  color: #fff;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  font-weight: 600;
  padding: 0.55rem 1rem;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-ms:hover {
  background: #011f8a;
}

.btn-google {
  background: #0129AC;
  color: #fff;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  font-weight: 600;
  padding: 0.55rem 1rem;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-google:hover {
  background: #0129AC;
}

/* ── Toolbar ────────────────────────────────────────────────────────── */

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  align-items: center;
  margin: 0 0 1.25rem;
}

.toolbar-hint {
  font-size: 0.82rem;
  color: #6b7280;
}

/* ── Error banner ──────────────────────────────────────────────────── */

.error-banner {
  background: #fef2f2;
  color: #991b1b;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  border: 1px solid #fecaca;
  font-size: 0.88rem;
}

/* ── Callouts ──────────────────────────────────────────────────────── */

.callout {
  padding: 0.75rem 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  font-size: 0.88rem;
  line-height: 1.45;
}

.callout-warn {
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
}

.callout-danger {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

.callout-success {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  color: #166534;
}

/* ── Tables ─────────────────────────────────────────────────────────── */

.table-wrap {
  overflow-x: auto;
  border: 1px solid #e0e5ec;
  border-radius: 8px;
  background: #fff;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

th,
td {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid #f0f0f5;
}

th {
  background: #f8f9fc;
  color: #6b7280;
  font-weight: 600;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

tr:last-child td {
  border-bottom: none;
}

tr:hover td {
  background: #f8f9fc;
}

.table-compact th,
.table-compact td {
  padding: 0.45rem 0.65rem;
}

.th-check {
  width: 2.5rem;
}

/* ── Mono / Muted ──────────────────────────────────────────────────── */

.mono {
  font-family: ui-monospace, monospace;
  font-size: 0.78rem;
  word-break: break-all;
}

.muted {
  color: #9ca3af;
}

.meta-line {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: #6b7280;
}

.meta-line strong {
  color: #1a1a2e;
}

/* ── Search ─────────────────────────────────────────────────────────── */

.search-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 1rem;
}

.input-search {
  flex: 1;
  min-width: 12rem;
  max-width: 28rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #1a1a2e;
  font-size: 0.9rem;
  font-family: inherit;
}

.input-search:focus {
  outline: none;
  border-color: #0129AC;
  box-shadow: 0 0 0 2px rgba(1, 41, 172, 0.15);
}

.search-count {
  font-size: 0.8rem;
  color: #9ca3af;
}

/* ── Inputs ─────────────────────────────────────────────────────────── */

.select-dest {
  width: 100%;
  max-width: 22rem;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #1a1a2e;
  font-size: 0.8rem;
  font-family: inherit;
}

.select-dest:focus {
  outline: none;
  border-color: #0129AC;
}

.input-text {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #1a1a2e;
  font-size: 0.9rem;
  font-family: inherit;
}

.input-text:focus {
  outline: none;
  border-color: #0129AC;
}

.field-label {
  display: block;
  font-size: 0.8rem;
  color: #6b7280;
  margin-bottom: 0.35rem;
}

/* ── Auth panel / Cloud cards ──────────────────────────────────────── */

.auth-panel {
  max-width: 56rem;
}

.cloud-cards {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.cloud-card {
  width: 180px;
  padding: 1.5rem 1rem 1.25rem;
  border-radius: 12px;
  border: 2px solid #e0e5ec;
  background: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
  text-align: center;
}

.cloud-card:hover {
  border-color: #0129AC;
  box-shadow: 0 4px 16px rgba(1, 41, 172, 0.1);
  transform: translateY(-2px);
}

.cloud-card-connected {
  border-color: #86efac;
  background: #f8fdf9;
}

.cloud-card-connected:hover {
  border-color: #22c55e;
  box-shadow: 0 4px 16px rgba(34, 197, 94, 0.1);
}

.cloud-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.cloud-card-name {
  font-weight: 700;
  font-size: 0.92rem;
  color: #1a1a2e;
}

.cloud-card-hint {
  font-size: 0.75rem;
  color: #9ca3af;
}

.cloud-card-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
}

.cloud-badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.cloud-badge-ok {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}

.cloud-card-user {
  font-size: 0.72rem;
  color: #6b7280;
  font-family: ui-monospace, monospace;
  word-break: break-all;
  text-align: center;
}

/* ── Combination Selector ──────────────────────────────────────────── */

.combo-section {
  margin-bottom: 0.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #e0e5ec;
}

.combo-section-title {
  font-size: 1rem;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0 0 0.25rem;
}

.combo-grid {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.combo-card {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.75rem 1.15rem;
  border: 2px solid #e0e5ec;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.15s;
  position: relative;
  min-width: 240px;
}

.combo-card:hover {
  border-color: #0129AC;
  box-shadow: 0 2px 12px rgba(1, 41, 172, 0.08);
}

.combo-card-active {
  border-color: #0129AC;
  background: #f0f4ff;
  box-shadow: 0 2px 12px rgba(1, 41, 172, 0.12);
}

.combo-card-icons {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}

.combo-card-icons img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.combo-card-icons svg {
  width: 28px;
  height: 28px;
}

.combo-card-arrow {
  font-size: 1.1rem;
  font-weight: 700;
  color: #0129AC;
  opacity: 0.5;
}

.combo-card-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.combo-card-label {
  font-size: 0.88rem;
  font-weight: 600;
  color: #1a1a2e;
  white-space: nowrap;
}

.combo-card-desc {
  font-size: 0.75rem;
  color: #9ca3af;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.combo-card-check {
  position: absolute;
  top: 0.35rem;
  right: 0.4rem;
}

/* ── Manage Clouds ─────────────────────────────────────────────────── */

.mc-section {
  margin-top: 1.5rem;
}

.mc-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0 0 0.75rem;
}

.mc-list {
  border: 1px solid #e0e5ec;
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}

.mc-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.85rem 1.25rem;
}

.mc-row + .mc-row {
  border-top: 1px solid #f0f0f5;
}

.mc-icon {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mc-icon img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.mc-info {
  flex: 1;
  min-width: 0;
}

.mc-name {
  font-weight: 600;
  font-size: 0.88rem;
  color: #1a1a2e;
}

.mc-user {
  font-size: 0.78rem;
  color: #6b7280;
  font-family: ui-monospace, monospace;
  word-break: break-all;
}

.mc-badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
  flex-shrink: 0;
}

.mc-disconnect {
  flex-shrink: 0;
}

/* Keep badge classes for other panels */
.badge-ok {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}

.badge-pending {
  background: #fef9c3;
  color: #92400e;
  border: 1px solid #fde68a;
}

.badge-fail {
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
}

/* ── Chats panel ───────────────────────────────────────────────────── */

.chats-user-list {
  display: flex;
  flex-direction: column;
  border: 1px solid #e0e5ec;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}

.chats-user-item + .chats-user-item {
  border-top: 1px solid #f0f0f5;
}

.chats-user-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  cursor: pointer;
  transition: background 0.12s;
}

.chats-user-row:hover {
  background: #f0f4ff;
}

.chats-user-row-active {
  background: #e8edff;
  border-bottom: 1px solid #e0e5ec;
}

.chats-user-icon {
  display: inline-flex;
  flex-shrink: 0;
}

.chats-user-name {
  font-weight: 600;
  font-size: 0.88rem;
  color: #1a1a2e;
  min-width: 10rem;
}

.chats-user-email {
  flex: 1;
  font-size: 0.78rem;
  color: #9ca3af;
}

.chats-user-arrow {
  font-size: 0.8rem;
  color: #9ca3af;
  flex-shrink: 0;
}

.chats-user-convos {
  background: #f8f9fc;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.chat-card {
  padding: 0.65rem 1rem;
  border: 1px solid #e0e5ec;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.chat-card:hover {
  border-color: #0129AC;
  box-shadow: 0 1px 4px rgba(1, 41, 172, 0.08);
}

.chat-card-expanded {
  border-color: #0129AC;
}

.chat-card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.chat-card-idx {
  font-size: 0.78rem;
  font-weight: 700;
  color: #0129AC;
  min-width: 2rem;
}

.chat-card-title {
  flex: 1;
  font-size: 0.85rem;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-card-meta {
  font-size: 0.75rem;
  color: #9ca3af;
  white-space: nowrap;
}

.chat-card-date {
  font-size: 0.75rem;
  color: #9ca3af;
  white-space: nowrap;
}

.chat-card-details {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid #f0f0f5;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.chat-detail-row {
  display: flex;
  gap: 0.75rem;
  font-size: 0.8rem;
}

.chat-detail-label {
  color: #9ca3af;
  min-width: 7rem;
}

/* ── Map panel ─────────────────────────────────────────────────────── */

.map-th-icon {
  width: 2rem;
  padding-right: 0 !important;
}

.map-icon-cell {
  width: 2rem;
  padding-right: 0 !important;
  text-align: center;
}

.map-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.map-row-unmapped td {
  opacity: 0.5;
}

.map-status {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
}

.map-status-mapped {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}

.map-status-unmapped {
  background: #fef9c3;
  color: #92400e;
  border: 1px solid #fde68a;
}

/* ── Migration progress ────────────────────────────────────────────── */

.migrate-progress {
  margin: 1rem 0;
}

.migrate-progress-bar {
  height: 4px;
  background: linear-gradient(90deg, #0129AC 0%, #4285f4 50%, #0129AC 100%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 2px;
  margin-bottom: 0.5rem;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ── Stats grid ────────────────────────────────────────────────────── */

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.stat-card {
  padding: 0.75rem 1rem;
  background: #fff;
  border: 1px solid #e0e5ec;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.stat-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #9ca3af;
}

.stat-value {
  font-size: 1rem;
  font-weight: 600;
  color: #1a1a2e;
}

.stat-ok {
  font-size: 1rem;
  font-weight: 700;
  color: #166534;
}

.stat-bad {
  font-size: 1rem;
  font-weight: 700;
  color: #991b1b;
}

/* ── Reports ───────────────────────────────────────────────────────── */

.report-row:hover td {
  background: #f0f4ff;
}

.report-errors {
  margin-top: 0.5rem;
}

.report-error-line {
  margin: 0.2rem 0;
  font-size: 0.78rem;
  color: #991b1b;
}

.report-files {
  margin-top: 0.25rem;
}

.report-files a {
  color: #0129AC;
  text-decoration: none;
}

.report-files a:hover {
  text-decoration: underline;
}

/* ── Utility ───────────────────────────────────────────────────────── */

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  font-size: 0.82rem;
  color: #6b7280;
}

/* ── Step navigation (Back / Next) ─────────────────────────────────── */

.step-nav {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

/* ── Cloud Selector ───────────────────────────────────────────────── */

.cs-panel {
  max-width: 64rem;
  margin: 0 auto;
}

.cs-layout {
  display: flex;
  align-items: flex-start;
  gap: 1.5rem;
  margin-top: 1.25rem;
}

.cs-column {
  flex: 1;
}

.cs-column-header {
  text-align: center;
  font-size: 0.85rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.55rem 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  color: #fff;
}

.cs-column-header-source {
  background: #0129AC;
}

.cs-column-header-dest {
  background: #0129AC;
}

.cs-cards {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.cs-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.25rem;
  border: 2px solid #e0e5ec;
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
  position: relative;
}

.cs-card:hover:not(.cs-card-disabled) {
  border-color: #0129AC;
  box-shadow: 0 4px 16px rgba(1, 41, 172, 0.1);
  transform: translateY(-1px);
}

.cs-card-selected {
  border-color: #0129AC;
  background: #f0f4ff;
  box-shadow: 0 2px 12px rgba(1, 41, 172, 0.12);
}

.cs-card-disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

.cs-card-icon {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cs-card-icon img {
  width: 48px;
  height: 48px;
  object-fit: contain;
}

.cs-card-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: #1a1a2e;
}

.cs-card-check {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
}

.cs-arrows {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 5rem;
}

.cs-confirm-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  margin-top: 2rem;
  padding: 1rem 1.5rem;
  background: #f0f4ff;
  border: 1px solid #d1d5db;
  border-radius: 12px;
}

.cs-combo-label {
  font-size: 1rem;
  font-weight: 600;
  color: #0129AC;
}

/* ── Split-panel Map ──────────────────────────────────────────────── */

.split-map {
  display: flex;
  align-items: flex-start;
  gap: 0;
  margin-top: 1rem;
}

.split-map-col {
  flex: 1;
  min-width: 0;
}

.split-map-header {
  text-align: center;
  font-size: 0.82rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.55rem 1rem;
  border-radius: 8px 8px 0 0;
  color: #fff;
}

.split-map-header-src {
  background: #0129AC;
}

.split-map-header-dest {
  background: #0129AC;
}

.split-map-list {
  border: 1px solid #e0e5ec;
  border-top: none;
  border-radius: 0 0 8px 8px;
  background: #fff;
  max-height: 420px;
  overflow-y: auto;
}

.split-map-user {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid #f0f0f5;
  transition: background 0.1s;
}

.split-map-user:last-child {
  border-bottom: none;
}

.split-map-user:hover {
  background: #f8f9fc;
}

.split-map-user-mapped {
  background: #f0fdf4;
}

.split-map-user-mapped:hover {
  background: #e6f9ec;
}

.split-map-radio input {
  accent-color: #0129AC;
  margin: 0;
}

.split-map-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.split-map-info {
  min-width: 0;
}

.split-map-name {
  font-weight: 600;
  font-size: 0.85rem;
  color: #1a1a2e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.split-map-email {
  font-size: 0.75rem;
  color: #9ca3af;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: ui-monospace, monospace;
}

.split-map-arrows {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 3rem 0.5rem 0;
  flex-shrink: 0;
}
```

---

### `client/src/components/AuthPanel.jsx`

```jsx
import { useEffect, useState } from "react";

export default function AuthPanel({ authStatus, onAuthStatusChange }) {
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    setChecking(true);
    try {
      const r = await fetch("/auth/status");
      if (r.ok) {
        const j = await r.json();
        onAuthStatusChange(j);
      }
    } catch {
      /* ignore */
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!authStatus?.sourceLoggedIn || !authStatus?.googleLoggedIn) refresh();
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.sourceLoggedIn, authStatus?.googleLoggedIn]);

  const openMsLogin = () => { window.location.href = "/auth/source/login"; };
  const msLogout = async () => { await fetch("/auth/source/logout", { method: "POST" }); refresh(); };
  const openGoogleLogin = () => { window.location.href = "/auth/google/login"; };
  const googleLogout = async () => { await fetch("/auth/google/logout", { method: "POST" }); refresh(); };

  const msConnected = !!authStatus?.sourceLoggedIn;
  const googleConnected = !!authStatus?.googleLoggedIn;

  const connectedClouds = [];
  if (msConnected) {
    connectedClouds.push({
      id: "microsoft",
      name: "Microsoft 365",
      icon: "/copilot-icon.png",
      user: authStatus.sourceUser || "",
      onDisconnect: msLogout,
    });
  }
  if (googleConnected) {
    connectedClouds.push({
      id: "google",
      name: "Google Workspace",
      icon: "/gemini-icon.svg",
      user: authStatus.googleUser || "",
      onDisconnect: googleLogout,
    });
  }

  return (
    <section className="auth-panel panel" aria-labelledby="auth-heading">
      <div className="panel-head">
        <h2 id="auth-heading">Connect Cloud Accounts</h2>
        <p className="panel-desc">
          Connect the admin accounts for the platforms you want to migrate between.
        </p>
      </div>

      <div className="cloud-cards">
        {!msConnected && (
          <div
            className="cloud-card"
            role="button"
            tabIndex={0}
            onClick={openMsLogin}
            onKeyDown={(e) => { if (e.key === "Enter") openMsLogin(); }}
          >
            <div className="cloud-card-icon">
              <img src="/copilot-icon.png" alt="Microsoft" width="56" height="56" />
            </div>
            <div className="cloud-card-name">Microsoft 365</div>
            <div className="cloud-card-hint">Click to connect</div>
          </div>
        )}

        {!googleConnected && (
          <div
            className="cloud-card"
            role="button"
            tabIndex={0}
            onClick={openGoogleLogin}
            onKeyDown={(e) => { if (e.key === "Enter") openGoogleLogin(); }}
          >
            <div className="cloud-card-icon">
              <img src="/gemini-icon.svg" alt="Google" width="56" height="56" />
            </div>
            <div className="cloud-card-name">Google Workspace</div>
            <div className="cloud-card-hint">Click to connect</div>
          </div>
        )}

        {msConnected && googleConnected && (
          <div className="callout callout-success" style={{ margin: 0 }}>
            All available clouds are connected. Proceed to <strong>Select Combination</strong>.
          </div>
        )}
      </div>

      {checking && (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Checking sessions…
        </p>
      )}

      {connectedClouds.length > 0 && (
        <div className="mc-section">
          <h3 className="mc-title">Manage Clouds</h3>
          <div className="mc-list">
            {connectedClouds.map((cloud) => (
              <div key={cloud.id} className="mc-row">
                <div className="mc-icon">
                  <img src={cloud.icon} alt={cloud.name} width="32" height="32" />
                </div>
                <div className="mc-info">
                  <div className="mc-name">{cloud.name}</div>
                  <div className="mc-user">{cloud.user}</div>
                </div>
                <span className="mc-badge">Connected</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small mc-disconnect"
                  onClick={cloud.onDisconnect}
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
```

---

### `client/src/components/ChatsPanel.jsx`

```jsx
import { useMemo, useRef, useState } from "react";

export default function ChatsPanel({ usersPayload, loadingUsers, onError, migrationMode, addLog }) {
  const [expandedUserId, setExpandedUserId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [expandedConvIdx, setExpandedConvIdx] = useState(null);
  const [query, setQuery] = useState("");

  // ChatGPT / Gemini import state
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const users = usersPayload?.users ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const dn = (u.displayName || "").toLowerCase();
      const upn = (u.userPrincipalName || "").toLowerCase();
      return dn.includes(q) || upn.includes(q);
    });
  }, [users, query]);

  const handleUserClick = async (userId) => {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      setConversations([]);
      setExpandedConvIdx(null);
      return;
    }

    setExpandedUserId(userId);
    setConversations([]);
    setExpandedConvIdx(null);
    setLoadingPreview(true);
    onError(null);
    try {
      const r = await fetch(
        `/api/users/${encodeURIComponent(userId)}/copilot/preview`
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setConversations(j.conversations || []);
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setImportResult(null);
    onError(null);

    const endpoint = migrationMode === "chatgpt-gemini"
      ? "/api/chatgpt/upload"
      : "/api/gemini/upload";

    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(endpoint, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setImportResult(j);
      addLog?.(`Imported — ${j.userCount || 1} users, ${j.conversationCount || 0} conversations`, "success");
    } catch (err) {
      onError(err.message || String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ChatGPT import view
  if (migrationMode === "chatgpt-gemini") {
    return (
      <section className="panel" aria-labelledby="import-heading">
        <div className="panel-head">
          <h2 id="import-heading">Import ChatGPT Data</h2>
          <p className="panel-desc">
            Upload your ChatGPT export ZIP file. Go to ChatGPT Settings &rarr; Data
            Controls &rarr; Export Data, download the ZIP you receive via email, and
            upload it here. You can also upload just the <code>conversations.json</code> file directly.
          </p>
        </div>

        <div className="toolbar">
          <label className="btn btn-primary" style={{ cursor: "pointer" }}>
            {uploading ? "Uploading…" : "Upload ChatGPT Export (ZIP or JSON)"}
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.json"
              className="sr-only"
              onChange={handleFileUpload}
              disabled={uploading}
            />
          </label>
        </div>

        {importResult && (
          <div className="callout callout-success">
            Successfully imported {importResult.conversationCount || 0} conversations
            from {importResult.userCount || 1} user(s).
          </div>
        )}
      </section>
    );
  }

  // Gemini import view
  if (migrationMode === "gemini-copilot") {
    return (
      <section className="panel" aria-labelledby="import-heading">
        <div className="panel-head">
          <h2 id="import-heading">Import Gemini Data</h2>
          <p className="panel-desc">
            Upload a Google Vault export ZIP file containing Gemini
            conversation data, or use the automated Vault export feature (if
            configured) to pull conversations directly.
          </p>
        </div>

        <div className="toolbar">
          <label className="btn btn-primary" style={{ cursor: "pointer" }}>
            {uploading ? "Uploading…" : "Upload Vault Export ZIP"}
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              className="sr-only"
              onChange={handleFileUpload}
              disabled={uploading}
            />
          </label>
        </div>

        {importResult && (
          <div className="callout callout-success">
            Successfully imported {importResult.conversationCount || 0} conversations
            from {importResult.userCount || 0} user(s).
          </div>
        )}
      </section>
    );
  }

  // Default: Copilot chats preview
  return (
    <section className="panel" aria-labelledby="chats-heading">
      <div className="panel-head">
        <h2 id="chats-heading">Microsoft Copilot Chats</h2>
        <p className="panel-desc">
          Click on a user to view their Copilot chat conversations grouped by
          session.
        </p>
      </div>

      {loadingUsers && <p className="muted">Loading Microsoft users…</p>}

      {!loadingUsers && users.length === 0 && (
        <p className="muted">
          No Microsoft users found. Connect Microsoft on the Connect tab first.
        </p>
      )}

      {users.length > 0 && (
        <div className="search-row">
          <input
            type="search"
            className="input-search"
            placeholder="Search users…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <span className="muted search-count">
            {filtered.length} of {users.length} users
          </span>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="chats-user-list">
          {filtered.map((u) => {
            const isExpanded = expandedUserId === u.id;
            return (
              <div key={u.id} className="chats-user-item">
                <div
                  className={`chats-user-row ${isExpanded ? "chats-user-row-active" : ""}`}
                  onClick={() => handleUserClick(u.id)}
                >
                  <span className="chats-user-icon">
                    <svg width="16" height="16" viewBox="0 0 23 23"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>
                  </span>
                  <span className="chats-user-name">
                    {u.displayName || u.userPrincipalName}
                  </span>
                  <span className="chats-user-email mono">
                    {u.userPrincipalName}
                  </span>
                  <span className="chats-user-arrow">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                </div>

                {isExpanded && (
                  <div className="chats-user-convos">
                    {loadingPreview && (
                      <p className="muted" style={{ padding: "0.5rem 1rem" }}>
                        Loading conversations…
                      </p>
                    )}

                    {!loadingPreview && conversations.length === 0 && (
                      <p
                        className="muted"
                        style={{ padding: "0.5rem 1rem" }}
                      >
                        No Copilot conversations found.
                      </p>
                    )}

                    {conversations.map((c) => (
                      <div
                        key={c.index}
                        className={`chat-card ${expandedConvIdx === c.index ? "chat-card-expanded" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedConvIdx(
                            expandedConvIdx === c.index ? null : c.index
                          );
                        }}
                      >
                        <div className="chat-card-header">
                          <span className="chat-card-idx">#{c.index}</span>
                          <span className="chat-card-title">{c.title}</span>
                          <span className="chat-card-meta">
                            {c.messageCount} msg
                            {c.messageCount !== 1 ? "s" : ""}
                          </span>
                          <span className="chat-card-date">
                            {c.date
                              ? new Date(c.date).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })
                              : ""}
                          </span>
                        </div>
                        {expandedConvIdx === c.index && (
                          <div className="chat-card-details">
                            <div className="chat-detail-row">
                              <span className="chat-detail-label">
                                Session ID
                              </span>
                              <span className="mono">{c.sessionId}</span>
                            </div>
                            <div className="chat-detail-row">
                              <span className="chat-detail-label">
                                First message
                              </span>
                              <span>
                                {c.date
                                  ? new Date(c.date).toLocaleString()
                                  : "—"}
                              </span>
                            </div>
                            <div className="chat-detail-row">
                              <span className="chat-detail-label">
                                Last message
                              </span>
                              <span>
                                {c.lastDate
                                  ? new Date(c.lastDate).toLocaleString()
                                  : "—"}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
```

---

### `client/src/components/CloudSelector.jsx`

```jsx
import { useState } from "react";

const CLOUDS = [
  {
    id: "copilot",
    name: "Microsoft Copilot",
    icon: "/copilot-icon.png",
    iconType: "img",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    icon: "/gemini-icon.svg",
    iconType: "img",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    icon: null,
    iconType: "svg",
  },
];

const VALID_COMBOS = [
  { source: "copilot", dest: "gemini" },
  { source: "gemini", dest: "copilot" },
  { source: "chatgpt", dest: "gemini" },
];

function ChatGPTIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="24" fill="#10a37f" />
      <path
        d="M33.6 21.6a6.01 6.01 0 0 0-5.16-8.28 6.01 6.01 0 0 0-9.72-1.68A6.02 6.02 0 0 0 10.68 17a6.01 6.01 0 0 0-1.08 6.12A6.01 6.01 0 0 0 14.76 31.4a6.01 6.01 0 0 0 9.72 1.68A6.02 6.02 0 0 0 32.52 27.8a6.01 6.01 0 0 0 1.08-6.2z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M22.2 18l-6 10.4h7.2L22.2 34" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M25.8 14l1.2 5.6-6 10.4h7.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function isValidCombo(sourceId, destId) {
  return VALID_COMBOS.some((c) => c.source === sourceId && c.dest === destId);
}

export default function CloudSelector({ onSelect }) {
  const [source, setSource] = useState(null);
  const [dest, setDest] = useState(null);

  const handleCloudClick = (cloudId, role) => {
    if (role === "source") {
      setSource(cloudId);
      if (dest === cloudId) setDest(null);
    } else {
      setDest(cloudId);
    }
  };

  const handleConfirm = () => {
    if (source && dest) {
      onSelect(`${source}-${dest}`);
    }
  };

  const renderCard = (cloud, role) => {
    const selected =
      (role === "source" && source === cloud.id) ||
      (role === "dest" && dest === cloud.id);

    const disabled =
      (role === "source" && dest === cloud.id) ||
      (role === "dest" && source === cloud.id) ||
      (role === "dest" && source && !isValidCombo(source, cloud.id)) ||
      (role === "source" && dest && !isValidCombo(cloud.id, dest));

    return (
      <div
        key={cloud.id}
        className={`cs-card ${selected ? "cs-card-selected" : ""} ${disabled ? "cs-card-disabled" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && handleCloudClick(cloud.id, role)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) handleCloudClick(cloud.id, role);
        }}
      >
        <div className="cs-card-icon">
          {cloud.iconType === "img" ? (
            <img src={cloud.icon} alt={cloud.name} width="48" height="48" />
          ) : (
            <ChatGPTIcon />
          )}
        </div>
        <div className="cs-card-name">{cloud.name}</div>
        {selected && (
          <span className="cs-card-check">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0129AC" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </span>
        )}
      </div>
    );
  };

  const comboLabel = source && dest
    ? `${CLOUDS.find((c) => c.id === source)?.name} → ${CLOUDS.find((c) => c.id === dest)?.name}`
    : null;

  return (
    <section className="panel cs-panel">
      <div className="panel-head">
        <h2>Select Migration Clouds</h2>
        <p className="panel-desc">
          Choose a source platform and a destination platform for the migration.
        </p>
      </div>

      <div className="cs-layout">
        <div className="cs-column">
          <div className="cs-column-header cs-column-header-source">Select Source</div>
          <div className="cs-cards">
            {CLOUDS.map((c) => renderCard(c, "source"))}
          </div>
        </div>

        <div className="cs-arrows">
          <svg width="40" height="24" viewBox="0 0 40 24" fill="none">
            <path d="M2 12h36M28 4l10 8-10 8" stroke="#0129AC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
          </svg>
        </div>

        <div className="cs-column">
          <div className="cs-column-header cs-column-header-dest">Select Destination</div>
          <div className="cs-cards">
            {CLOUDS.map((c) => renderCard(c, "dest"))}
          </div>
        </div>
      </div>

      {comboLabel && (
        <div className="cs-confirm-bar">
          <span className="cs-combo-label">{comboLabel}</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
          >
            Continue →
          </button>
        </div>
      )}
    </section>
  );
}
```

---

### `client/src/components/CombinationPanel.jsx`

```jsx
function ChatGPTIconSmall() {
  return (
    <svg width="36" height="36" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="24" fill="#10a37f" />
      <path
        d="M33.6 21.6a6.01 6.01 0 0 0-5.16-8.28 6.01 6.01 0 0 0-9.72-1.68A6.02 6.02 0 0 0 10.68 17a6.01 6.01 0 0 0-1.08 6.12A6.01 6.01 0 0 0 14.76 31.4a6.01 6.01 0 0 0 9.72 1.68A6.02 6.02 0 0 0 32.52 27.8a6.01 6.01 0 0 0 1.08-6.2z"
        fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M22.2 18l-6 10.4h7.2L22.2 34" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M25.8 14l1.2 5.6-6 10.4h7.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ALL_COMBOS = [
  { id: "copilot-gemini", source: "microsoft", dest: "google", label: "Microsoft Copilot → Google Gemini", desc: "Export Copilot chats as DOCX and upload to Google Drive" },
  { id: "gemini-copilot", source: "google", dest: "microsoft", label: "Google Gemini → Microsoft Copilot", desc: "Vault export Gemini conversations to OneNote pages" },
  { id: "chatgpt-gemini", source: "chatgpt", dest: "google", label: "ChatGPT → Google Gemini", desc: "Upload ChatGPT export JSON and migrate to Google Drive" },
];

export default function CombinationPanel({ authStatus, migrationMode, onModeChange }) {
  const msConnected = !!authStatus?.sourceLoggedIn;
  const googleConnected = !!authStatus?.googleLoggedIn;

  const availableCombos = ALL_COMBOS.filter((c) => {
    if (c.source === "microsoft" && !msConnected) return false;
    if (c.source === "google" && !googleConnected) return false;
    if (c.dest === "microsoft" && !msConnected) return false;
    if (c.dest === "google" && !googleConnected) return false;
    if (c.source === "chatgpt" && c.dest === "google" && !googleConnected) return false;
    return true;
  });

  const noClouds = !msConnected && !googleConnected;

  return (
    <section className="panel" aria-labelledby="combo-heading">
      <div className="panel-head">
        <h2 id="combo-heading">Select Combination</h2>
        <p className="panel-desc">
          Choose a migration direction based on your connected clouds.
        </p>
      </div>

      {noClouds && (
        <div className="callout callout-warn">
          No clouds connected yet. Go to the <strong>Connect</strong> tab first to add your cloud accounts.
        </div>
      )}

      {!noClouds && availableCombos.length === 0 && (
        <div className="callout callout-warn">
          Connect at least one source and one destination cloud to see available combinations.
        </div>
      )}

      {availableCombos.length > 0 && (
        <div className="combo-grid">
          {availableCombos.map((combo) => {
            const isActive = migrationMode === combo.id;
            return (
              <div
                key={combo.id}
                className={`combo-card ${isActive ? "combo-card-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => onModeChange(combo.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onModeChange(combo.id); }}
              >
                <div className="combo-card-icons">
                  {combo.source === "microsoft" && <img src="/copilot-icon.png" alt="" width="28" height="28" />}
                  {combo.source === "google" && <img src="/gemini-icon.svg" alt="" width="28" height="28" />}
                  {combo.source === "chatgpt" && <ChatGPTIconSmall />}
                  <span className="combo-card-arrow">→</span>
                  {combo.dest === "google" && <img src="/gemini-icon.svg" alt="" width="28" height="28" />}
                  {combo.dest === "microsoft" && <img src="/copilot-icon.png" alt="" width="28" height="28" />}
                </div>
                <div className="combo-card-info">
                  <div className="combo-card-label">{combo.label}</div>
                  <div className="combo-card-desc">{combo.desc}</div>
                </div>
                {isActive && (
                  <span className="combo-card-check">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0129AC" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {migrationMode && (
        <div className="callout callout-success" style={{ marginTop: "1.25rem" }}>
          Selected: <strong>{ALL_COMBOS.find((c) => c.id === migrationMode)?.label}</strong>. Proceed to the next step.
        </div>
      )}
    </section>
  );
}
```

---

### `client/src/components/MapPanel.jsx`

```jsx
import { useEffect, useMemo, useRef, useState } from "react";

export default function MapPanel({
  msUsers,
  googleUsers,
  loadingMsUsers,
  loadingGoogleUsers,
  mapping,
  onMappingChange,
  onError,
  migrationMode,
  addLog,
}) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);

  const msUserList = msUsers?.users ?? [];
  const gUserList = googleUsers?.users ?? [];

  const hasManualMapping = useRef(false);

  // Auto-map when both user lists are available
  useEffect(() => {
    if (msUserList.length > 0 && gUserList.length > 0 && !hasManualMapping.current) {
      const auto = buildAutoMapping(msUserList, gUserList);
      onMappingChange(auto);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msUserList.length, gUserList.length]);

  // Show MS users when only MS is loaded (no Google yet)
  useEffect(() => {
    if (msUserList.length > 0 && gUserList.length === 0 && mapping.length === 0) {
      const auto = msUserList.map((ms) => ({
        sourceUserId: ms.id,
        sourceEmail: ms.userPrincipalName || "",
        sourceDisplayName: ms.displayName || "",
        destEmail: "",
      }));
      onMappingChange(auto);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msUserList.length]);

  function buildAutoMapping(msList, gList) {
    const gEmailMap = new Map();
    for (const g of gList) {
      gEmailMap.set((g.email || "").toLowerCase(), g);
    }

    const usedGoogleEmails = new Set();
    const pairs = [];

    for (const ms of msList) {
      const msEmail = (ms.userPrincipalName || "").toLowerCase();
      const match = gEmailMap.get(msEmail);
      if (match) {
        usedGoogleEmails.add(match.email.toLowerCase());
        pairs.push({
          sourceUserId: ms.id,
          sourceEmail: ms.userPrincipalName || "",
          sourceDisplayName: ms.displayName || "",
          destEmail: match.email,
          destName: match.name || match.email,
        });
      } else {
        pairs.push({
          sourceUserId: ms.id,
          sourceEmail: ms.userPrincipalName || "",
          sourceDisplayName: ms.displayName || "",
          destEmail: "",
          destName: "",
        });
      }
    }

    for (const g of gList) {
      if (!usedGoogleEmails.has((g.email || "").toLowerCase())) {
        pairs.push({
          sourceUserId: "",
          sourceEmail: "",
          sourceDisplayName: "",
          destEmail: g.email,
          destName: g.name || g.email,
        });
      }
    }

    return pairs;
  }

  // Sorted: mapped first, then unmapped
  const sortedMapping = useMemo(() => {
    return [...mapping].sort((a, b) => {
      const aMapped = Boolean(a.sourceEmail && a.destEmail);
      const bMapped = Boolean(b.sourceEmail && b.destEmail);
      if (aMapped === bMapped) return 0;
      return aMapped ? -1 : 1;
    });
  }, [mapping]);

  const downloadCsv = () => {
    const header = "sourceEmail,destEmail\n";
    const rows = sortedMapping
      .filter((p) => p.sourceEmail || p.destEmail)
      .map((p) => `${p.sourceEmail},${p.destEmail}`)
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "user-mapping.csv";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  };

  const uploadCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/mapping/csv", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      hasManualMapping.current = true;
      onMappingChange(j.pairs || []);

      await fetch("/api/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: j.pairs || [] }),
      });

      const mapped = (j.pairs || []).filter((p) => p.sourceEmail && p.destEmail).length;
      setUploadMsg(`CSV uploaded — ${mapped} of ${(j.pairs || []).length} pairs mapped.`);
      addLog?.(`CSV mapping uploaded — ${mapped} of ${(j.pairs || []).length} pairs mapped`, "success");
      setTimeout(() => setUploadMsg(null), 5000);
    } catch (err) {
      onError(err.message || String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const mappedCount = useMemo(
    () => mapping.filter((p) => p.sourceEmail && p.destEmail).length,
    [mapping]
  );
  const unmappedCount = mapping.length - mappedCount;

  const isLoading = loadingMsUsers || loadingGoogleUsers;

  const srcHeader = migrationMode === "gemini-copilot" ? "Google Users" : migrationMode === "chatgpt-gemini" ? "ChatGPT Users" : "Source Users";
  const destHeader = migrationMode === "gemini-copilot" ? "Microsoft Users" : "Destination Users";

  return (
    <section className="panel" aria-labelledby="map-heading">
      <div className="panel-head">
        <h2 id="map-heading">User Mapping</h2>
        <p className="panel-desc">
          Users are auto-matched by email. Mapped users appear at the top.
          Download the CSV to manually edit mappings, then upload to apply
          changes.
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={downloadCsv}
          disabled={mapping.length === 0}
        >
          Download CSV
        </button>
        <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {uploading ? "Uploading…" : "Upload CSV"}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="sr-only"
            onChange={uploadCsv}
          />
        </label>
        {mapping.length > 0 && (
          <span className="muted toolbar-hint">
            {mappedCount} mapped · {unmappedCount} unmapped
          </span>
        )}
      </div>

      {uploadMsg && (
        <div className="callout callout-success">{uploadMsg}</div>
      )}

      {isLoading && (
        <div className="migrate-progress">
          <div className="migrate-progress-bar" />
          <p className="muted">Loading users…</p>
        </div>
      )}

      {!isLoading && mapping.length === 0 && (
        <p className="muted" style={{ marginTop: "1rem" }}>
          Connect both Microsoft and Google on the Connect tab to see user
          mappings.
        </p>
      )}

      {sortedMapping.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="map-th-icon"></th>
                <th>{srcHeader}</th>
                <th className="map-th-icon"></th>
                <th>{destHeader}</th>
                <th>Mapping Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedMapping.map((pair, idx) => {
                const isMapped = Boolean(pair.sourceEmail && pair.destEmail);
                return (
                  <tr key={idx} className={isMapped ? "" : "map-row-unmapped"}>
                    <td className="map-icon-cell">
                      {pair.sourceEmail && (
                        <span className="map-icon map-icon-ms" title="Microsoft">
                          <svg width="16" height="16" viewBox="0 0 23 23"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>
                        </span>
                      )}
                    </td>
                    <td className={pair.sourceEmail ? "" : "muted"}>
                      {pair.sourceEmail || "–"}
                    </td>
                    <td className="map-icon-cell">
                      {pair.destEmail && (
                        <span className="map-icon map-icon-google" title="Google">
                          <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.9 7.35 2.56 10.52l7.97-5.93z"/><path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.93C6.51 42.62 14.62 48 24 48z"/></svg>
                        </span>
                      )}
                    </td>
                    <td className={pair.destEmail ? "" : "muted"}>
                      {pair.destEmail || "–"}
                    </td>
                    <td>
                      <span
                        className={`map-status ${isMapped ? "map-status-mapped" : "map-status-unmapped"}`}
                      >
                        {isMapped ? "Mapped" : "Unmapped"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

---

### `client/src/components/MigratePanel.jsx`

```jsx
import { useMemo, useState } from "react";

const MODE_DESC = {
  "copilot-gemini": "Each user's Copilot conversations will be exported as DOCX files and uploaded to a CopilotChats folder in the destination user's Google Drive.",
  "gemini-copilot": "Each user's Gemini conversations will be migrated to OneNote pages and associated Drive files will be transferred to OneDrive.",
  "chatgpt-gemini": "Each user's ChatGPT conversations will be exported as DOCX files and uploaded to a ChatGPTChats folder in the destination user's Google Drive.",
};

export default function MigratePanel({
  mapping,
  onMigrationComplete,
  onSwitchTab,
  onError,
  setMigrating: setParentMigrating,
  migrationMode,
  addLog,
}) {
  const [selected, setSelected] = useState(new Set());
  const [migrating, setMigrating] = useState(false);

  const validPairs = useMemo(
    () => mapping.filter((p) => p.sourceUserId && p.destEmail),
    [mapping]
  );

  const toggleAll = () => {
    if (selected.size === validPairs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(validPairs.map((p) => p.sourceUserId)));
    }
  };

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const startMigration = async () => {
    if (selected.size === 0) return;
    setMigrating(true);
    setParentMigrating(true);
    onError(null);
    onSwitchTab("reports");

    const endpoint = "/api/migrate";

    try {
      const pairs = validPairs.filter((p) => selected.has(p.sourceUserId));
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs, mode: migrationMode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onMigrationComplete(j.results || []);
    } catch (err) {
      onError(err.message || String(err));
    } finally {
      setMigrating(false);
      setParentMigrating(false);
    }
  };

  const srcLabel = migrationMode === "gemini-copilot" ? "Google User" : migrationMode === "chatgpt-gemini" ? "ChatGPT User" : "Microsoft User";
  const srcEmailLabel = migrationMode === "gemini-copilot" ? "Google Email" : migrationMode === "chatgpt-gemini" ? "ChatGPT Email" : "Microsoft Email";
  const destLabel = migrationMode === "gemini-copilot" ? "Microsoft Destination" : "Google Destination";

  return (
    <section className="panel" aria-labelledby="migrate-heading">
      <div className="panel-head">
        <h2 id="migrate-heading">Migrate</h2>
        <p className="panel-desc">
          Select mapped user pairs and start migration.{" "}
          {MODE_DESC[migrationMode] || ""}
        </p>
      </div>

      {validPairs.length === 0 && (
        <div className="callout callout-warn">
          No valid user pairs found. Go to the <strong>Map</strong> tab and
          assign destination emails to source users first.
        </div>
      )}

      {validPairs.length > 0 && (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="btn btn-primary"
              onClick={startMigration}
              disabled={migrating || selected.size === 0}
            >
              {migrating
                ? "Migrating…"
                : `Start Migration (${selected.size} user${selected.size === 1 ? "" : "s"})`}
            </button>
            <span className="muted toolbar-hint">
              {selected.size} of {validPairs.length} selected
            </span>
          </div>

          <div className="table-wrap">
            <table className="table-compact">
              <thead>
                <tr>
                  <th className="th-check">
                    <input
                      type="checkbox"
                      checked={selected.size === validPairs.length}
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th>{srcLabel}</th>
                  <th>{srcEmailLabel}</th>
                  <th>{destLabel}</th>
                </tr>
              </thead>
              <tbody>
                {validPairs.map((p) => (
                  <tr key={p.sourceUserId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(p.sourceUserId)}
                        onChange={() => toggle(p.sourceUserId)}
                      />
                    </td>
                    <td>{p.sourceDisplayName || "—"}</td>
                    <td className="mono">{p.sourceEmail || "—"}</td>
                    <td className="mono">{p.destEmail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
```

---

### `client/src/components/MigrationLog.jsx`

```jsx
import { useEffect, useRef } from "react";

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <polyline points="20 6 9 17 4 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CompletionCheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="#fff" strokeWidth="2" />
      <polyline points="8 12 11 15 16 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusIcon({ status }) {
  if (status === "success") return <CheckIcon />;
  if (status === "warning") return <WarnIcon />;
  if (status === "error") return <ErrorIcon />;
  return <InfoIcon />;
}

function CatIcon() {
  return (
    <span className="mlog-cat">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="7" width="18" height="14" rx="2" stroke="#fff" strokeWidth="2" />
        <path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" stroke="#fff" strokeWidth="2" />
        <circle cx="12" cy="14" r="2" fill="#fff" />
      </svg>
    </span>
  );
}

export default function MigrationLog({ entries, migrating }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  const statusLabel = migrating ? "Running" : entries.length > 0 ? "Ready" : "Waiting";
  const statusClass = migrating ? "mlog-st-running" : entries.length > 0 ? "mlog-st-ready" : "mlog-st-waiting";

  const isCompletionEntry = (msg) => {
    const lower = (msg || "").toLowerCase();
    return lower.includes("migration complete") || lower.includes("reports saved");
  };

  return (
    <aside className="mlog-panel" aria-label="Migration Log">
      <div className="mlog-header">
        <h3 className="mlog-title">Migration Log</h3>
        <span className={`mlog-hdr-status ${statusClass}`}>
          <span className="mlog-hdr-dot" />
          {statusLabel}
        </span>
      </div>

      <div className="mlog-list">
        {entries.length === 0 && (
          <div className="mlog-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <p className="mlog-empty-title">No activity yet</p>
            <p className="mlog-empty-sub">Events will appear here as you connect clouds, import data, map users, and run migrations.</p>
          </div>
        )}

        {entries.map((entry, i) => {
          const completion = isCompletionEntry(entry.message);

          if (completion) {
            return (
              <div key={i} className="mlog-row">
                <CatIcon />
                <div className="mlog-pill mlog-pill-completion">
                  <CompletionCheckIcon />
                  <span className="mlog-pill-time">{formatTime(entry.timestamp)}</span>
                  <span className="mlog-pill-dashes">------</span>
                  <span className="mlog-pill-msg">{entry.message}</span>
                  <span className="mlog-pill-dashes">------</span>
                </div>
              </div>
            );
          }

          const pillClass = entry.status === "success" ? "mlog-pill-success"
            : entry.status === "error" ? "mlog-pill-error"
            : entry.status === "warning" ? "mlog-pill-warn"
            : "mlog-pill-info";

          return (
            <div key={i} className="mlog-row">
              <CatIcon />
              <div className={`mlog-pill ${pillClass}`}>
                <span className="mlog-pill-icon">
                  <StatusIcon status={entry.status} />
                </span>
                <span className="mlog-pill-time">{formatTime(entry.timestamp)}</span>
                <span className="mlog-pill-msg">{entry.message}</span>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
```

---

### `client/src/components/ReportsPanel.jsx`

```jsx
import { useMemo, useState } from "react";

export default function ReportsPanel({ results, migrating }) {
  const [expandedIdx, setExpandedIdx] = useState(null);

  const summary = useMemo(() => {
    const total = results.length;
    const succeeded = results.filter(
      (r) => r.filesUploaded > 0 && r.errors.length === 0
    ).length;
    const partial = results.filter(
      (r) => r.filesUploaded > 0 && r.errors.length > 0
    ).length;
    const failed = results.filter((r) => r.filesUploaded === 0).length;
    const totalConversations = results.reduce(
      (s, r) => s + r.conversationsCount,
      0
    );
    const totalFiles = results.reduce((s, r) => s + r.filesUploaded, 0);
    return { total, succeeded, partial, failed, totalConversations, totalFiles };
  }, [results]);

  if (migrating) {
    return (
      <section className="panel" aria-labelledby="reports-heading">
        <div className="panel-head">
          <h2 id="reports-heading">Migration Reports</h2>
          <p className="panel-desc">
            Migration is currently running. Please wait while files are being
            generated and uploaded.
          </p>
        </div>
        <div className="migrate-progress">
          <div className="migrate-progress-bar" />
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            Migration in progress — this may take several minutes for large
            datasets. Do not close this page.
          </p>
        </div>
      </section>
    );
  }

  if (results.length === 0) {
    return (
      <section className="panel" aria-labelledby="reports-heading">
        <div className="panel-head">
          <h2 id="reports-heading">Migration Reports</h2>
        </div>
        <p className="muted" style={{ marginTop: "1rem" }}>
          No migration results yet. Go to the <strong>Migrate</strong> tab to
          start a migration.
        </p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="reports-heading">
      <div className="panel-head">
        <h2 id="reports-heading">Migration Reports</h2>
      </div>

      <div className="callout callout-success" style={{ marginTop: "0.5rem" }}>
        Migration completed successfully.
      </div>

      <div className="settings-grid" style={{ marginTop: "1rem" }}>
        <div className="stat-card">
          <span className="stat-label">Total Pairs</span>
          <span className="stat-value">{summary.total}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Succeeded</span>
          <span className="stat-ok">{summary.succeeded}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Partial</span>
          <span className="stat-value">{summary.partial}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Failed</span>
          <span className="stat-bad">{summary.failed}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Conversations</span>
          <span className="stat-value">{summary.totalConversations}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Files Uploaded</span>
          <span className="stat-value">{summary.totalFiles}</span>
        </div>
      </div>

      <div className="table-wrap" style={{ marginTop: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>Microsoft User</th>
              <th>Destination</th>
              <th>Conversations</th>
              <th>Files</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, idx) => {
              const hasErrors = r.errors.length > 0;
              const status =
                r.filesUploaded > 0 && !hasErrors
                  ? "success"
                  : r.filesUploaded > 0 && hasErrors
                    ? "partial"
                    : "failed";
              return (
                <tr
                  key={idx}
                  className="report-row"
                  onClick={() =>
                    setExpandedIdx(expandedIdx === idx ? null : idx)
                  }
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    {r.sourceDisplayName}
                    <br />
                    <span className="mono muted" style={{ fontSize: "0.72rem" }}>
                      {r.sourceUserId}
                    </span>
                  </td>
                  <td className="mono">{r.destUserEmail}</td>
                  <td>{r.conversationsCount}</td>
                  <td>{r.filesUploaded}</td>
                  <td>
                    <span
                      className={`cloud-badge ${
                        status === "success"
                          ? "cloud-badge-ok"
                          : status === "partial"
                            ? "badge-pending"
                            : "badge-fail"
                      }`}
                    >
                      {status}
                    </span>
                    {expandedIdx === idx && hasErrors && (
                      <div className="report-errors">
                        {r.errors.map((err, ei) => (
                          <p key={ei} className="report-error-line">
                            {err}
                          </p>
                        ))}
                      </div>
                    )}
                    {expandedIdx === idx &&
                      r.files &&
                      r.files.length > 0 && (
                        <div className="report-files">
                          <p
                            className="muted"
                            style={{
                              fontSize: "0.75rem",
                              marginTop: "0.5rem",
                            }}
                          >
                            Uploaded files:
                          </p>
                          {r.files.map((f, fi) => (
                            <p key={fi} style={{ fontSize: "0.78rem" }}>
                              {f.webViewLink ? (
                                <a
                                  href={f.webViewLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {f.name}
                                </a>
                              ) : (
                                f.name
                              )}
                              {f.title && (
                                <span className="muted"> — {f.title}</span>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

---

### `client/src/components/SplitPane.jsx`

```jsx
import { useCallback, useEffect, useRef, useState } from "react";

export default function SplitPane({ left, right, defaultSplit = 50, minLeft = 25, minRight = 20 }) {
  const containerRef = useRef(null);
  const [split, setSplit] = useState(defaultSplit);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let pct = (x / rect.width) * 100;
    pct = Math.max(minLeft, Math.min(100 - minRight, pct));
    setSplit(pct);
  }, [minLeft, minRight]);

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div className="split-pane" ref={containerRef}>
      <div className="split-pane-left" style={{ width: `${split}%` }}>
        {left}
      </div>
      <div className="split-pane-divider" onMouseDown={onMouseDown}>
        <div className="split-pane-handle" />
      </div>
      <div className="split-pane-right" style={{ width: `${100 - split}%` }}>
        {right}
      </div>
    </div>
  );
}
```

---

### `client/src/components/ExportPanel.jsx`

```jsx
import { useMemo, useState } from "react";
import { downloadJson } from "../utils/downloadJson.js";

export default function ExportPanel({
  settings,
  usersPayload,
  loadingUsers,
  onLoadUsers,
  onError,
}) {
  const [loadingExport, setLoadingExport] = useState(false);
  const [loadingExportDocx, setLoadingExportDocx] = useState(false);
  const [loadingUserId, setLoadingUserId] = useState(null);
  const [loadingDocxUserId, setLoadingDocxUserId] = useState(null);
  const [query, setQuery] = useState("");

  const users = usersPayload?.users ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const dn = (u.displayName || "").toLowerCase();
      const upn = (u.userPrincipalName || "").toLowerCase();
      const id = (u.id || "").toLowerCase();
      return dn.includes(q) || upn.includes(q) || id.includes(q);
    });
  }, [users, query]);

  const downloadAll = async () => {
    onError(null);
    setLoadingExport(true);
    try {
      const r = await fetch("/api/export/all");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      downloadJson(
        `copilot-export-all-${new Date().toISOString().slice(0, 10)}.json`,
        j
      );
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingExport(false);
    }
  };

  const downloadUser = async (userId) => {
    onError(null);
    setLoadingUserId(userId);
    try {
      const q =
        settings?.copilotChatOnly === false ? "?copilotChatOnly=false" : "";
      const r = await fetch(
        `/api/users/${encodeURIComponent(userId)}/copilot${q}`
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error || j.message || `HTTP ${r.status}`);
      }
      const safe = userId.replace(/[^a-z0-9-]/gi, "_").slice(0, 36);
      downloadJson(`copilot-${safe}.json`, j);
      if (j.error) {
        onError(
          `File saved; Graph returned an issue for this user (see "error" in the JSON): ${j.error}`
        );
      }
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingUserId(null);
    }
  };

  const downloadUserDocx = async (userId, displayName) => {
    onError(null);
    setLoadingDocxUserId(userId);
    try {
      const q =
        settings?.copilotChatOnly === false ? "&copilotChatOnly=false" : "";
      const dn = encodeURIComponent(displayName || userId);
      const r = await fetch(
        `/api/users/${encodeURIComponent(userId)}/copilot/docx?displayName=${dn}${q}`
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || j.message || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const safe = userId.replace(/[^a-z0-9-]/gi, "_").slice(0, 36);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `copilot-${safe}.docx`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 500);
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingDocxUserId(null);
    }
  };

  const downloadAllDocx = async () => {
    onError(null);
    setLoadingExportDocx(true);
    try {
      const r = await fetch("/api/export/all/docx");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || j.message || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const dateStr = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `copilot-export-all-${dateStr}.docx`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 500);
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingExportDocx(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="export-heading">
      <div className="panel-head">
        <h2 id="export-heading">Export Copilot Chats</h2>
        <p className="panel-desc">
          Load directory users, then download their Copilot chat interactions
          as <strong>JSON</strong> (raw data) or <strong>DOCX</strong>{" "}
          (formatted Word document with conversations grouped neatly).
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onLoadUsers}
          disabled={loadingUsers}
        >
          {loadingUsers ? "Loading users…" : "Load all users"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={downloadAll}
          disabled={loadingExport}
        >
          {loadingExport
            ? "Building full export…"
            : "Download JSON — all users"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={downloadAllDocx}
          disabled={loadingExportDocx}
        >
          {loadingExportDocx
            ? "Building DOCX…"
            : "Download DOCX — all users"}
        </button>
        <span className="muted toolbar-hint">
          Full export can take several minutes for large tenants.
        </span>
      </div>

      {usersPayload && (
        <p className="meta-line">
          <strong>{usersPayload.count}</strong> user(s) · loaded at{" "}
          {usersPayload.generatedAt}
        </p>
      )}

      {users.length > 0 && (
        <div className="search-row">
          <label className="search-label" htmlFor="user-filter">
            Filter table
          </label>
          <input
            id="user-filter"
            type="search"
            className="input-search"
            placeholder="Search by name, UPN, or object id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <span className="muted search-count">
            Showing {filtered.length} of {users.length}
          </span>
        </div>
      )}

      {users.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Display name</th>
                <th>User principal name</th>
                <th>Object id</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName ?? "—"}</td>
                  <td className="mono">{u.userPrincipalName ?? "—"}</td>
                  <td className="mono">{u.id}</td>
                  <td>
                    {u.accountEnabled === undefined
                      ? "—"
                      : String(u.accountEnabled)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={loadingUserId === u.id}
                      onClick={() => downloadUser(u.id)}
                    >
                      {loadingUserId === u.id ? "…" : "JSON"}
                    </button>
                    {" "}
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={loadingDocxUserId === u.id}
                      onClick={() => downloadUserDocx(u.id, u.displayName)}
                    >
                      {loadingDocxUserId === u.id ? "…" : "DOCX"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loadingUsers && usersPayload && users.length === 0 && (
        <p className="muted">No users returned.</p>
      )}

      {!loadingUsers && usersPayload && filtered.length === 0 && users.length > 0 && (
        <p className="muted">No users match your filter.</p>
      )}
    </section>
  );
}
```

---

### `client/src/utils/downloadJson.js`

```js
export function downloadJson(filename, data) {
  const text = JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", filename);
  a.setAttribute("rel", "noopener");
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}
```

---

### `server/index.mjs`

```js
import "dotenv/config";
import cors from "cors";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { connectDB } from "./src/db/connection.js";
import {
  createSourceGraphClient,
  getCopilotInteractionsForUser,
  listDirectoryUsers,
  readGraphEnvOptions,
} from "./src/copilotService.js";
import { readTenantSummaryForApi } from "./src/graphCredentials.js";
import { authRouter, getSessionToken } from "./src/auth/oauthRoutes.mjs";
import {
  googleAuthRouter,
  getGoogleSessionToken,
} from "./src/auth/googleOauthRoutes.mjs";
import { buildDocx } from "./src/docBuilder.js";
import { listGoogleUsers } from "./src/googleService.js";
import { runMigration } from "./src/migration/migrate.js";
import {
  parseChatGPTExport,
  chatgptToInteractions,
} from "./src/chatgptService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const isProduction = process.env.NODE_ENV === "production";
if (isProduction) app.set("trust proxy", 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "copilot-export-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000,
      sameSite: isProduction ? "lax" : false,
    },
  })
);

app.use("/auth", authRouter);
app.use("/auth/google", googleAuthRouter);

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

async function resolveSourceToken(req) {
  const sessionToken = getSessionToken(req, "source");
  if (sessionToken) return sessionToken;
  const { accessToken } = await createSourceGraphClient();
  return accessToken;
}

async function getAppOnlyToken() {
  const { accessToken } = await createSourceGraphClient();
  return accessToken;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings", (_req, res) => {
  try {
    const o = readGraphEnvOptions();
    const tenants = readTenantSummaryForApi();
    res.json({
      copilotChatOnly: o.copilotChatOnly,
      graphApiVersion: o.apiVersion,
      graphTop: o.top,
      tenants,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/users", async (_req, res) => {
  try {
    const accessToken = await getAppOnlyToken();
    const users = await listDirectoryUsers(accessToken);
    res.json({
      generatedAt: new Date().toISOString(),
      count: users.length,
      users,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Copilot JSON export
// ---------------------------------------------------------------------------

app.get("/api/users/:userId/copilot", async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const copilotOnly = req.query.copilotChatOnly;
  const copilotChatOnly =
    copilotOnly === undefined
      ? undefined
      : String(copilotOnly).toLowerCase() === "true";

  try {
    const accessToken = await getAppOnlyToken();
    const interactions = await getCopilotInteractionsForUser(
      accessToken,
      userId,
      copilotChatOnly === undefined ? {} : { copilotChatOnly }
    );
    res.json({
      userId,
      generatedAt: new Date().toISOString(),
      count: interactions.length,
      interactions,
    });
  } catch (e) {
    const msg = String(e.message || e);
    res.json({
      userId,
      generatedAt: new Date().toISOString(),
      count: 0,
      interactions: [],
      error: msg,
    });
  }
});

app.get("/api/export/all", async (_req, res) => {
  try {
    const appToken = await getAppOnlyToken();
    const directoryUsers = await listDirectoryUsers(appToken);
    const result = {
      exportedAt: new Date().toISOString(),
      users: directoryUsers,
      interactionsByUserId: {},
      errorsByUserId: {},
    };

    for (const u of directoryUsers) {
      try {
        const interactions = await getCopilotInteractionsForUser(appToken, u.id, {});
        result.interactionsByUserId[u.id] = interactions;
      } catch (err) {
        result.errorsByUserId[u.id] = String(err.message || err);
      }
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Copilot DOCX export
// ---------------------------------------------------------------------------

app.get("/api/users/:userId/copilot/docx", async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  const displayName = req.query.displayName || userId;
  const copilotOnly = req.query.copilotChatOnly;
  const copilotChatOnly =
    copilotOnly === undefined
      ? undefined
      : String(copilotOnly).toLowerCase() === "true";

  try {
    const accessToken = await getAppOnlyToken();
    const interactions = await getCopilotInteractionsForUser(
      accessToken,
      userId,
      copilotChatOnly === undefined ? {} : { copilotChatOnly }
    );

    const buffer = await buildDocx(userId, displayName, interactions);
    const safe = userId.replace(/[^a-z0-9-]/gi, "_").slice(0, 36);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="copilot-${safe}.docx"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/export/all/docx", async (_req, res) => {
  try {
    const appToken = await getAppOnlyToken();
    const directoryUsers = await listDirectoryUsers(appToken);

    const allInteractions = [];
    const errors = {};

    for (const u of directoryUsers) {
      try {
        const interactions = await getCopilotInteractionsForUser(appToken, u.id, {});
        for (const item of interactions) {
          item._displayName = u.displayName || u.userPrincipalName || u.id;
        }
        allInteractions.push(...interactions);
      } catch (err) {
        errors[u.id] = String(err.message || err);
      }
    }

    const buffer = await buildDocx(
      "all-users",
      `All Users (${directoryUsers.length} users)`,
      allInteractions
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="copilot-export-all-${dateStr}.docx"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Copilot chat preview (conversation summaries)
// ---------------------------------------------------------------------------

app.get("/api/users/:userId/copilot/preview", async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  try {
    const accessToken = await getAppOnlyToken();
    const interactions = await getCopilotInteractionsForUser(
      accessToken,
      userId,
      {}
    );

    const sessionMap = new Map();
    for (const item of interactions) {
      const sid = item.sessionId || "unknown";
      if (!sessionMap.has(sid)) sessionMap.set(sid, []);
      sessionMap.get(sid).push(item);
    }

    const conversations = [];
    let idx = 0;
    for (const [sessionId, items] of sessionMap) {
      items.sort(
        (a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime)
      );
      idx++;

      let title = `Conversation ${idx}`;
      for (const item of items) {
        if (item.interactionType === "userPrompt") {
          const body = item.body?.content ?? "";
          const text =
            item.body?.contentType === "html"
              ? body.replace(/<[^>]+>/g, "").trim()
              : body.trim();
          if (text) {
            title = text.slice(0, 100);
            break;
          }
        }
      }

      conversations.push({
        index: idx,
        sessionId,
        title,
        messageCount: items.length,
        date: items[0]?.createdDateTime || null,
        lastDate: items[items.length - 1]?.createdDateTime || null,
      });
    }

    res.json({ userId, conversations });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Google users
// ---------------------------------------------------------------------------

app.get("/api/google/users", async (req, res) => {
  try {
    const token = getGoogleSessionToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ error: "Not signed in with Google. Please connect Google first." });
    }
    const users = await listGoogleUsers(token);
    res.json({ count: users.length, users });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// User mapping (session-stored)
// ---------------------------------------------------------------------------

app.get("/api/mapping", (req, res) => {
  res.json({ pairs: req.session.mapping || [] });
});

app.post("/api/mapping", (req, res) => {
  const { pairs } = req.body;
  if (!Array.isArray(pairs)) {
    return res.status(400).json({ error: "pairs must be an array" });
  }
  req.session.mapping = pairs;
  res.json({ ok: true, count: pairs.length });
});

app.get("/api/mapping/csv", (req, res) => {
  const pairs = req.session.mapping || [];
  const header = "sourceEmail,destEmail\n";
  const rows = pairs
    .map((p) => `${p.sourceEmail || ""},${p.destEmail || ""}`)
    .join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="user-mapping.csv"'
  );
  res.send(header + rows);
});

app.post("/api/mapping/csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const text = req.file.buffer.toString("utf-8");
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      return res
        .status(400)
        .json({ error: "CSV must have a header row and at least one data row" });
    }

    const delimiter = lines[0].includes("\t") ? "\t" : ",";
    const headerCols = lines[0].split(delimiter).map((c) => c.trim().toLowerCase());
    const srcIdx = headerCols.indexOf("sourceemail");
    const dstIdx = headerCols.indexOf("destemail");

    const rawPairs = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delimiter).map((c) => c.trim());
      if (srcIdx >= 0 && dstIdx >= 0) {
        rawPairs.push({
          sourceEmail: cols[srcIdx] || "",
          destEmail: cols[dstIdx] || "",
        });
      } else if (cols.length >= 2) {
        rawPairs.push({
          sourceEmail: cols[0] || "",
          destEmail: cols[1] || "",
        });
      }
    }

    let msUsers = [];
    try {
      const accessToken = await getAppOnlyToken();
      msUsers = await listDirectoryUsers(accessToken);
    } catch { /* best-effort enrichment */ }

    const emailToUser = new Map();
    for (const u of msUsers) {
      emailToUser.set((u.userPrincipalName || "").toLowerCase(), u);
    }

    const pairs = rawPairs.map((p) => {
      const msUser = emailToUser.get((p.sourceEmail || "").toLowerCase());
      return {
        sourceEmail: p.sourceEmail,
        destEmail: p.destEmail,
        sourceUserId: msUser?.id || "",
        sourceDisplayName: msUser?.displayName || "",
      };
    });

    req.session.mapping = pairs;
    res.json({ ok: true, count: pairs.length, pairs });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// ChatGPT import
// ---------------------------------------------------------------------------

app.post("/api/chatgpt/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    let jsonStr;
    const fileName = (req.file.originalname || "").toLowerCase();

    if (fileName.endsWith(".zip")) {
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(req.file.buffer);
      const entry = zip.getEntries().find((e) =>
        e.entryName.toLowerCase().endsWith("conversations.json")
      );
      if (!entry) {
        return res.status(400).json({
          error: "conversations.json not found inside the ZIP. Make sure you uploaded the ChatGPT export ZIP.",
        });
      }
      jsonStr = entry.getData().toString("utf-8");
    } else {
      jsonStr = req.file.buffer.toString("utf-8");
    }

    const conversations = parseChatGPTExport(jsonStr);
    const interactions = chatgptToInteractions(conversations);

    req.session.chatgptConversations = conversations;
    req.session.chatgptInteractions = interactions;

    res.json({
      ok: true,
      conversationCount: conversations.length,
      userCount: 1,
      totalMessages: interactions.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Gemini import (Vault ZIP placeholder)
// ---------------------------------------------------------------------------

app.post("/api/gemini/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    req.session.geminiUpload = {
      fileName: req.file.originalname,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
    };
    res.json({
      ok: true,
      conversationCount: 0,
      userCount: 0,
      message: "Vault ZIP uploaded. Processing will be available after GEM_CO integration.",
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

let migrationResults = [];

app.post("/api/migrate", async (req, res) => {
  const { pairs, mode } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res
      .status(400)
      .json({ error: "pairs array is required and must not be empty" });
  }

  try {
    if (mode === "chatgpt-gemini") {
      const chatgptInteractions = req.session.chatgptInteractions || [];
      if (chatgptInteractions.length === 0) {
        return res.status(400).json({ error: "No ChatGPT data imported. Upload a ChatGPT JSON file first." });
      }
      const migrationPairs = pairs.map((p) => ({
        sourceUserId: p.sourceUserId || "chatgpt-user",
        sourceDisplayName: p.sourceDisplayName || p.sourceEmail || "ChatGPT User",
        destUserEmail: p.destEmail,
        _chatgptInteractions: chatgptInteractions,
      }));
      const results = await runMigration(migrationPairs);
      migrationResults = results;
      req.session.migrationResults = results;
      return res.json({ ok: true, results });
    }

    if (mode === "gemini-copilot") {
      return res.status(501).json({
        error: "Gemini → Copilot migration is not yet fully integrated. GEM_CO module porting is in progress.",
      });
    }

    // Default: Copilot → Gemini
    const migrationPairs = pairs.map((p) => ({
      sourceUserId: p.sourceUserId,
      sourceDisplayName: p.sourceDisplayName || p.sourceEmail || p.sourceUserId,
      destUserEmail: p.destEmail,
    }));

    const results = await runMigration(migrationPairs);
    migrationResults = results;
    req.session.migrationResults = results;
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/migrate/results", (req, res) => {
  res.json({ results: req.session.migrationResults || migrationResults || [] });
});

// ---------------------------------------------------------------------------
// Static UI (production build)
// ---------------------------------------------------------------------------

const distPath = path.join(__dirname, "..", "dist", "client");
if (fs.existsSync(path.join(distPath, "index.html"))) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api|\/auth).*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

async function start() {
  try {
    await connectDB();
  } catch {
    console.warn("[Server] Starting without MongoDB — session-based storage only");
  }
  app.listen(PORT, () => {
    console.log(`Cloud Migration Platform API: http://localhost:${PORT}`);
  });
}

start();
```

---

### `server/src/chatgptService.js`

```js
/**
 * Parses ChatGPT export JSON (from OpenAI Settings > Data Controls > Export).
 * The export zip contains a `conversations.json` array of conversation objects.
 */

export function parseChatGPTExport(jsonString) {
  const data = JSON.parse(jsonString);
  const conversations = Array.isArray(data) ? data : [data];

  const results = [];

  for (const conv of conversations) {
    if (!conv.mapping) continue;

    const title = conv.title || "Untitled Conversation";
    const createTime = conv.create_time
      ? new Date(conv.create_time * 1000)
      : null;
    const updateTime = conv.update_time
      ? new Date(conv.update_time * 1000)
      : null;

    const messages = [];
    for (const [, node] of Object.entries(conv.mapping)) {
      const msg = node.message;
      if (!msg || !msg.content) continue;
      if (!msg.author?.role) continue;

      const role = msg.author.role;
      if (role === "system") continue;

      const parts = msg.content.parts || [];
      const text = parts
        .filter((p) => typeof p === "string")
        .join("\n")
        .trim();

      if (!text) continue;

      messages.push({
        role,
        text,
        timestamp: msg.create_time
          ? new Date(msg.create_time * 1000).toISOString()
          : null,
      });
    }

    messages.sort((a, b) => {
      if (!a.timestamp || !b.timestamp) return 0;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    if (messages.length > 0) {
      results.push({
        conversationId: conv.id || conv.conversation_id || null,
        title,
        createTime: createTime?.toISOString() || null,
        updateTime: updateTime?.toISOString() || null,
        messageCount: messages.length,
        messages,
      });
    }
  }

  return results;
}

/**
 * Converts parsed ChatGPT conversations into the same interaction format
 * that buildDocx expects, so we can reuse the existing DOCX builder.
 */
export function chatgptToInteractions(conversations) {
  const interactions = [];

  for (const conv of conversations) {
    const sessionId = conv.conversationId || `chatgpt-${Date.now()}`;
    for (const msg of conv.messages) {
      interactions.push({
        sessionId,
        interactionType:
          msg.role === "user" ? "userPrompt" : "aiResponse",
        createdDateTime: msg.timestamp || conv.createTime || new Date().toISOString(),
        body: {
          contentType: "text",
          content: msg.text,
        },
        _conversationTitle: conv.title,
      });
    }
  }

  return interactions;
}
```

---

### `server/src/copilotService.js`

```js
import {
  buildCopilotChatOnlyFilter,
  isCopilotChatSurface,
} from "./appClass.js";
import { getGraphAccessToken } from "./auth.js";
import { requireSourceCredentials } from "./graphCredentials.js";
import { fetchAllEnterpriseInteractions } from "./graph.js";
import { fetchAllDirectoryUsers } from "./users.js";

export function readGraphEnvOptions() {
  const apiVersion = process.env.GRAPH_API_VERSION?.trim() || "v1.0";
  const top = Math.min(
    999,
    Math.max(1, parseInt(process.env.GRAPH_TOP || "100", 10) || 100)
  );
  const copilotChatOnly =
    String(process.env.COPILOT_CHAT_ONLY ?? "true").toLowerCase() !== "false";
  const graphFilterExplicit = process.env.GRAPH_FILTER?.trim() || "";
  const filter =
    graphFilterExplicit ||
    (copilotChatOnly ? buildCopilotChatOnlyFilter() : "");
  const usersOdataFilter = process.env.USERS_ODATA_FILTER?.trim() || "";
  const usersPageSize = Math.min(
    999,
    Math.max(1, parseInt(process.env.USERS_PAGE_SIZE || "999", 10) || 999)
  );
  return {
    apiVersion,
    top,
    copilotChatOnly,
    graphFilterExplicit,
    filter,
    usersOdataFilter,
    usersPageSize,
  };
}

/** Copilot read + source directory — uses SOURCE_* or legacy AZURE_* */
export async function createSourceGraphClient() {
  const { tenantId, clientId, clientSecret } = requireSourceCredentials();
  const accessToken = await getGraphAccessToken({
    tenantId,
    clientId,
    clientSecret,
  });
  return { accessToken };
}

/** @deprecated Use createSourceGraphClient */
export async function createGraphClient() {
  return createSourceGraphClient();
}

export async function listDirectoryUsers(accessToken, overrides = {}) {
  const o = { ...readGraphEnvOptions(), ...overrides };
  const usersFilter =
    overrides.usersFilter ??
    (o.usersOdataFilter ? o.usersOdataFilter : undefined);
  return fetchAllDirectoryUsers({
    accessToken,
    apiVersion: o.apiVersion,
    usersFilter,
    pageSize: o.usersPageSize,
  });
}

/**
 * @param {string} userId
 * @param {object} [overrides] - optional { copilotChatOnly, filter, apiVersion, top }
 */
export async function getCopilotInteractionsForUser(accessToken, userId, overrides = {}) {
  const base = readGraphEnvOptions();
  const copilotChatOnly =
    overrides.copilotChatOnly !== undefined
      ? overrides.copilotChatOnly
      : base.copilotChatOnly;
  const filter =
    overrides.filter !== undefined
      ? overrides.filter
      : base.graphFilterExplicit ||
        (copilotChatOnly ? buildCopilotChatOnlyFilter() : "");

  let interactions = await fetchAllEnterpriseInteractions({
    accessToken,
    apiVersion: overrides.apiVersion ?? base.apiVersion,
    userId,
    top: overrides.top ?? base.top,
    filter: filter || undefined,
  });

  if (copilotChatOnly) {
    interactions = interactions.filter((item) =>
      isCopilotChatSurface(item.appClass)
    );
  }

  return interactions;
}
```

---

### `server/src/docBuilder.js`

```js
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
```

---

### `server/src/googleService.js`

```js
/**
 * Google Workspace helpers:
 *  - List users via Admin SDK (Directory API)
 *  - Create folders / upload files to a user's Drive via Service Account impersonation
 */

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";

// ── Admin SDK: list users ────────────────────────────────────────────

export async function listGoogleUsers(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const admin = google.admin({ version: "directory_v1", auth });
  const users = [];
  let pageToken;

  do {
    const res = await admin.users.list({
      customer: "my_customer",
      maxResults: 500,
      orderBy: "email",
      pageToken,
    });
    for (const u of res.data.users || []) {
      users.push({
        id: u.id,
        email: u.primaryEmail,
        name: u.name?.fullName || u.primaryEmail,
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return users;
}

// ── Service Account auth (domain-wide delegation) ────────────────────

function getServiceAccountKeyPath() {
  return (
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
    path.join(process.cwd(), "google-service-account.json")
  );
}

export function getServiceAccountAuth(userEmail) {
  const keyPath = getServiceAccountKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Service account key file not found at ${keyPath}. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env.`
    );
  }
  const auth = new GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/drive"],
    clientOptions: { subject: userEmail },
  });
  return auth;
}

// ── Drive helpers ────────────────────────────────────────────────────

export async function createDriveFolder(auth, folderName, parentId) {
  const drive = google.drive({ version: "v3", auth });
  const metadata = {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await drive.files.create({
    requestBody: metadata,
    fields: "id, name, webViewLink",
  });
  return res.data;
}

export async function uploadFileToDrive(
  auth,
  fileName,
  mimeType,
  content,
  parentFolderId
) {
  const drive = google.drive({ version: "v3", auth });
  const { Readable } = await import("node:stream");

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    media: {
      mimeType,
      body: Readable.from(Buffer.isBuffer(content) ? content : Buffer.from(content)),
    },
    fields: "id, name, webViewLink",
  });
  return res.data;
}
```

---

### `server/src/graph.js`

```js
/**
 * Microsoft Graph: getAllEnterpriseInteractions for a user.
 * @see https://learn.microsoft.com/graph/api/aiinteractionhistory-getallenterpriseinteractions
 */

function buildBaseUrl(apiVersion, userId) {
  const v = apiVersion === "beta" ? "beta" : "v1.0";
  return `https://graph.microsoft.com/${v}/copilot/users/${encodeURIComponent(userId)}/interactionHistory/getAllEnterpriseInteractions`;
}

function appendQueryParams(url, { top, filter }) {
  const u = new URL(url);
  if (top != null && top > 0) {
    u.searchParams.set("$top", String(top));
  }
  if (filter && String(filter).trim()) {
    u.searchParams.set("$filter", String(filter).trim());
  }
  return u.toString();
}

export async function fetchAllEnterpriseInteractions({
  accessToken,
  apiVersion,
  userId,
  top,
  filter,
}) {
  let url = appendQueryParams(buildBaseUrl(apiVersion, userId), { top, filter });
  const items = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        data.error?.message ||
        data.error_description ||
        data.error ||
        res.statusText;
      throw new Error(`Graph request failed (${res.status}): ${msg}`);
    }

    const batch = Array.isArray(data.value) ? data.value : [];
    items.push(...batch);

    const next = data["@odata.nextLink"];
    url = typeof next === "string" && next.length > 0 ? next : null;
  }

  return items;
}
```

---

### `server/src/graphCredentials.js`

```js
/**
 * Source Entra app credentials for reading Copilot interactions.
 */

/**
 * @returns {{ tenantId: string, clientId: string, clientSecret: string } | null}
 */
export function tryResolveSourceCredentials() {
  const tenantId =
    process.env.SOURCE_AZURE_TENANT_ID?.trim() ||
    process.env.AZURE_TENANT_ID?.trim();
  const clientId =
    process.env.SOURCE_AZURE_CLIENT_ID?.trim() ||
    process.env.AZURE_CLIENT_ID?.trim();
  const clientSecret =
    process.env.SOURCE_AZURE_CLIENT_SECRET?.trim() ||
    process.env.AZURE_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) {
    return null;
  }
  return { tenantId, clientId, clientSecret };
}

export function requireSourceCredentials() {
  const c = tryResolveSourceCredentials();
  if (!c) {
    throw new Error(
      "Missing app credentials: set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET."
    );
  }
  return c;
}

/**
 * Public summary for /api/settings (no secrets).
 */
export function readTenantSummaryForApi() {
  const source = tryResolveSourceCredentials();
  return {
    sourceConfigured: Boolean(source),
    sourceTenantId: source?.tenantId ?? null,
  };
}
```

---

### `server/src/users.js`

```js
/**
 * List all users in the directory (object IDs) via Microsoft Graph.
 * Requires application permission: User.Read.All (admin consent).
 * @see https://learn.microsoft.com/graph/api/user-list
 */

function buildUsersUrl(apiVersion, { select, filter, top }) {
  const v = apiVersion === "beta" ? "beta" : "v1.0";
  const u = new URL(`https://graph.microsoft.com/${v}/users`);
  u.searchParams.set(
    "$select",
    select || "id,displayName,userPrincipalName,accountEnabled"
  );
  u.searchParams.set("$top", String(Math.min(999, Math.max(1, top || 999))));
  if (filter && String(filter).trim()) {
    u.searchParams.set("$filter", String(filter).trim());
  }
  return u.toString();
}

/**
 * @returns {Promise<Array<{ id: string, displayName?: string, userPrincipalName?: string, accountEnabled?: boolean }>>}
 */
export async function fetchAllDirectoryUsers({
  accessToken,
  apiVersion,
  usersFilter,
  pageSize,
}) {
  let url = buildUsersUrl(apiVersion, {
    filter: usersFilter,
    top: pageSize || 999,
  });
  const rows = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        data.error?.message ||
        data.error_description ||
        data.error ||
        res.statusText;
      throw new Error(`Graph users list failed (${res.status}): ${msg}`);
    }

    const batch = Array.isArray(data.value) ? data.value : [];
    for (const u of batch) {
      if (u?.id) {
        rows.push({
          id: u.id,
          displayName: u.displayName ?? null,
          userPrincipalName: u.userPrincipalName ?? null,
          accountEnabled: u.accountEnabled,
        });
      }
    }

    const next = data["@odata.nextLink"];
    url = typeof next === "string" && next.length > 0 ? next : null;
  }

  return rows;
}
```

---

### `server/src/appClass.js`

```js
/**
 * Microsoft Graph aiInteraction appClass values (Copilot surfaces).
 * @see https://learn.microsoft.com/graph/api/aiinteractionhistory-getallenterpriseinteractions
 */

export const APP_CLASS = {
  BizChat: "IPM.SkypeTeams.Message.Copilot.BizChat",
  WebChat: "IPM.SkypeTeams.Message.Copilot.WebChat",
  Teams: "IPM.SkypeTeams.Message.Copilot.Teams",
  Word: "IPM.SkypeTeams.Message.Copilot.Word",
  Excel: "IPM.SkypeTeams.Message.Copilot.Excel",
};

/** Microsoft 365 Copilot Chat (browser/app) + Copilot web chat — excludes Teams meetings, Word, Excel, etc. */
const COPILOT_CHAT_SURFACES = [APP_CLASS.BizChat, APP_CLASS.WebChat];

/**
 * OData $filter: only BizChat + WebChat.
 */
export function buildCopilotChatOnlyFilter() {
  const [a, b] = COPILOT_CHAT_SURFACES;
  return `(appClass eq '${a}' or appClass eq '${b}')`;
}

export function isCopilotChatSurface(appClass) {
  if (appClass == null || appClass === "") {
    return false;
  }
  return COPILOT_CHAT_SURFACES.includes(String(appClass));
}
```

---

### `server/src/auth.js`

```js
/**
 * Client credentials token for Microsoft Graph (application permission flow).
 */

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export async function getGraphAccessToken({ tenantId, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: "client_credentials",
  });

  const res = await fetch(TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error_description || data.error || res.statusText;
    throw new Error(`Token request failed (${res.status}): ${msg}`);
  }

  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }

  return data.access_token;
}
```

---

### `server/src/auth/msalConfig.js`

```js
import { ConfidentialClientApplication } from "@azure/msal-node";

// AiEnterpriseInteraction.Read.All is application-only — it cannot appear in a
// delegated OAuth scope list. Use .default so Microsoft sends all permissions
// that have already been admin-consented on the app registration in Entra.
const SCOPES = ["https://graph.microsoft.com/.default"];

/**
 * Build MSAL ConfidentialClientApplication for a given tenant.
 * @param {string} tenantId
 * @returns {ConfidentialClientApplication}
 */
export function buildMsalApp(tenantId) {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set for the OAuth login flow."
    );
  }
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
}

/**
 * Build the redirect URI for source or destination.
 * @param {"source"|"dest"} role
 */
export function getRedirectUri(role) {
  const base = process.env.OAUTH_REDIRECT_BASE || "http://localhost:3000";
  return `${base}/auth/${role}/callback`;
}

export { SCOPES };
```

---

### `server/src/auth/oauthRoutes.mjs`

```js
/**
 * OAuth 2.0 Authorization Code Flow routes for source tenant admin.
 * Mounts on the Express app to provide:
 *   GET  /auth/source/login      – redirect to Microsoft login
 *   GET  /auth/source/callback   – exchange code, store token in session
 *   GET  /auth/status            – { sourceLoggedIn, sourceUser }
 *   POST /auth/source/logout     – clear source token from session
 */

import { Router } from "express";
import { buildMsalApp, getRedirectUri, SCOPES } from "./msalConfig.js";

export const authRouter = Router();

function getSourceTenantId() {
  return (
    process.env.SOURCE_TENANT_ID ||
    process.env.SOURCE_AZURE_TENANT_ID ||
    process.env.AZURE_TENANT_ID
  );
}

authRouter.get("/source/login", async (req, res) => {
  const tenantId = getSourceTenantId();
  if (!tenantId) {
    return res.status(500).send("AZURE_TENANT_ID is not configured.");
  }
  try {
    const msalApp = buildMsalApp(tenantId);
    const redirectUri = getRedirectUri("source");
    const authUrl = await msalApp.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri,
      state: "source",
    });
    req.session.sourceTenantId = tenantId;
    res.redirect(authUrl);
  } catch (e) {
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

authRouter.get("/source/callback", async (req, res) => {
  const tenantId = req.session.sourceTenantId || getSourceTenantId();
  if (!tenantId) {
    return res.status(500).send("Tenant ID not found in session.");
  }
  try {
    const msalApp = buildMsalApp(tenantId);
    const redirectUri = getRedirectUri("source");
    const tokenResponse = await msalApp.acquireTokenByCode({
      code: req.query.code,
      scopes: SCOPES,
      redirectUri,
    });

    req.session.sourceAuth = {
      accessToken: tokenResponse.accessToken,
      account: {
        username: tokenResponse.account?.username,
        name: tokenResponse.account?.name,
      },
      expiresOn: tokenResponse.expiresOn?.toISOString(),
      tenantId,
    };

    res.redirect("/?auth=success");
  } catch (e) {
    res.status(500).send(`Token exchange failed: ${e.message}`);
  }
});

authRouter.post("/source/logout", (req, res) => {
  delete req.session.sourceAuth;
  res.json({ ok: true });
});

authRouter.get("/status", (req, res) => {
  const src = req.session?.sourceAuth;
  const g = req.session?.googleAuth;
  res.json({
    sourceLoggedIn: Boolean(src?.accessToken),
    sourceUser: src?.account?.username || src?.account?.name || null,
    googleLoggedIn: Boolean(g?.accessToken),
    googleUser: g?.email || g?.name || null,
  });
});

/**
 * Get the access token for a role from the current session.
 * @param {import("express").Request} req
 * @param {"source"} role
 */
export function getSessionToken(req, role) {
  if (role === "source") {
    return req.session?.sourceAuth?.accessToken || null;
  }
  return null;
}
```

---

### `server/src/auth/googleOauthRoutes.mjs`

```js
/**
 * Google OAuth 2.0 Authorization Code Flow routes.
 *   GET  /auth/google/login     – redirect to Google consent screen
 *   GET  /auth/google/callback  – exchange code, store tokens in session
 *   POST /auth/google/logout    – clear Google tokens from session
 */

import { Router } from "express";
import { OAuth2Client } from "google-auth-library";

export const googleAuthRouter = Router();

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    `${process.env.OAUTH_REDIRECT_BASE || "http://localhost:3000"}/auth/google/callback`;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.");
  }
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "openid",
  "email",
  "profile",
];

googleAuthRouter.get("/login", (_req, res) => {
  try {
    const client = getOAuth2Client();
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
    });
    res.redirect(authUrl);
  } catch (e) {
    res.status(500).send(`Google OAuth error: ${e.message}`);
  }
});

googleAuthRouter.get("/callback", async (req, res) => {
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    req.session.googleAuth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email: payload?.email || null,
      name: payload?.name || null,
      expiresOn: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
    };

    res.redirect("/?auth=google_success");
  } catch (e) {
    res.status(500).send(`Google token exchange failed: ${e.message}`);
  }
});

googleAuthRouter.post("/logout", (req, res) => {
  delete req.session.googleAuth;
  res.json({ ok: true });
});

export function getGoogleSessionToken(req) {
  return req.session?.googleAuth?.accessToken || null;
}
```

---

### `server/src/db/connection.js`

```js
import mongoose from "mongoose";

let isConnected = false;

export async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[MongoDB] MONGODB_URI not set — running without database persistence");
    return;
  }

  try {
    await mongoose.connect(uri);
    isConnected = true;
    console.error(`[MongoDB] Connected to ${uri.replace(/\/\/[^@]+@/, "//***@")}`);
  } catch (err) {
    console.error(`[MongoDB] Connection failed: ${err.message}`);
    throw err;
  }
}

export function isDBConnected() {
  return isConnected;
}
```

---

### `server/src/db/models/User.js`

```js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ["admin", "user"], default: "user" },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
```

---

### `server/src/db/models/Cloud.js`

```js
import mongoose from "mongoose";

const cloudSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    provider: {
      type: String,
      enum: ["microsoft", "google"],
      required: true,
    },
    accessToken: { type: String, default: "" },
    refreshToken: { type: String, default: "" },
    tokenExpiry: { type: Date },
    email: { type: String, default: "" },
    displayName: { type: String, default: "" },
    tenantId: { type: String, default: "" },
    account: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

cloudSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.model("Cloud", cloudSchema);
```

---

### `server/src/db/models/ChatsHistory.js`

```js
import mongoose from "mongoose";

const chatsHistorySchema = new mongoose.Schema(
  {
    cloudId: { type: mongoose.Schema.Types.ObjectId, ref: "Cloud", required: true },
    userEmail: { type: String, required: true, lowercase: true },
    provider: {
      type: String,
      enum: ["copilot", "gemini", "chatgpt"],
      required: true,
    },
    conversations: { type: [mongoose.Schema.Types.Mixed], default: [] },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

chatsHistorySchema.index({ cloudId: 1, userEmail: 1 });

export default mongoose.model("ChatsHistory", chatsHistorySchema);
```

---

### `server/src/db/models/UserMapping.js`

```js
import mongoose from "mongoose";

const pairSchema = new mongoose.Schema(
  {
    sourceUserId: { type: String, default: "" },
    sourceEmail: { type: String, default: "" },
    sourceDisplayName: { type: String, default: "" },
    destEmail: { type: String, default: "" },
    destName: { type: String, default: "" },
  },
  { _id: false }
);

const userMappingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    migrationMode: {
      type: String,
      enum: ["copilot-gemini", "gemini-copilot", "chatgpt-gemini"],
      required: true,
    },
    pairs: { type: [pairSchema], default: [] },
    isManual: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userMappingSchema.index({ userId: 1, migrationMode: 1 });

export default mongoose.model("UserMapping", userMappingSchema);
```

---

### `server/src/db/models/Job.js`

```js
import mongoose from "mongoose";

const jobSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    migrationMode: {
      type: String,
      enum: ["copilot-gemini", "gemini-copilot", "chatgpt-gemini"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    pairsCount: { type: Number, default: 0 },
    progress: {
      completed: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    results: { type: [mongoose.Schema.Types.Mixed], default: [] },
    error: { type: String, default: "" },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

jobSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model("Job", jobSchema);
```

---

### `server/src/gemini/vaultExporter.js`

```js
import { google } from "googleapis";
import fs from "fs";
import path from "path";

/**
 * Google Vault eDiscovery exporter for Gemini data.
 * Ported from GEM_CO project.
 */
export class VaultExporter {
  constructor(auth) {
    this.vault = google.vault({ version: "v1", auth });
    this.auth = auth;
  }

  async _getToken() {
    const tok = await this.auth.getAccessToken();
    return tok.token || tok;
  }

  async createMatter(name) {
    const res = await this.vault.matters.create({
      requestBody: { name, state: "OPEN" },
    });
    return res.data;
  }

  async createExport(matterId, userEmails) {
    const token = await this._getToken();
    const url = `https://vault.googleapis.com/v1/matters/${matterId}/exports`;
    const body = {
      name: `gemini-export-${Date.now()}`,
      query: {
        corpus: "GEMINI",
        dataScope: "ALL_DATA",
        accountInfo: { emails: userEmails },
        searchMethod: "ACCOUNT",
        geminiOptions: {},
      },
      exportOptions: {
        geminiOptions: { exportFormat: "XML" },
        region: "ANY",
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error?.message || JSON.stringify(data));
    }
    return data;
  }

  async downloadExport(matterId, exportId, destDir) {
    const exportData = await this.vault.matters.exports.get({
      matterId,
      exportId,
    });
    const files = exportData.data.cloudStorageSink?.files || [];
    if (files.length === 0) {
      throw new Error("Export completed but no files found in cloud storage");
    }

    fs.mkdirSync(destDir, { recursive: true });
    const storage = google.storage({ version: "v1", auth: this.auth });

    for (const file of files) {
      const filePath = path.join(destDir, path.basename(file.objectName));
      const res = await storage.objects.get(
        { bucket: file.bucketName, object: file.objectName, alt: "media" },
        { responseType: "stream" }
      );
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(filePath);
        res.data.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    }

    return destDir;
  }

  async closeMatter(matterId) {
    await this.vault.matters.close({ matterId, requestBody: {} });
  }
}
```

---

### `server/src/gemini/vaultReader.js`

```js
import fs from "fs";
import path from "path";
import { parseStringPromise } from "xml2js";

/**
 * Google Vault Export Reader — parses Gemini conversation XML from Vault exports.
 *
 * XML schema:
 *   <GeminiUserConversationHistory>
 *     <User><Email>...</Email></User>
 *     <Conversations>
 *       <Conversation>
 *         <ConversationId>c_xxx</ConversationId>
 *         <ConversationTopic>Title</ConversationTopic>
 *         <ConversationTurns>
 *           <ConversationTurn>
 *             <Timestamp>...</Timestamp>
 *             <Prompt><Text>...</Text></Prompt>
 *             <PrimaryResponse><Text>...</Text></PrimaryResponse>
 *           </ConversationTurn>
 *         </ConversationTurns>
 *       </Conversation>
 *     </Conversations>
 *   </GeminiUserConversationHistory>
 */
export class VaultReader {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    this._userFiles = null;
  }

  async discoverUsers() {
    const xmlFiles = fs
      .readdirSync(this.vaultPath)
      .filter((f) => f.toLowerCase().endsWith(".xml"))
      .map((f) => path.join(this.vaultPath, f));

    if (xmlFiles.length === 0) {
      throw new Error(`No XML files found in: ${this.vaultPath}`);
    }

    this._userFiles = {};
    const users = [];

    for (const filePath of xmlFiles) {
      try {
        const email = await this._extractEmailFromFile(filePath);
        if (!email) continue;
        this._userFiles[email] = filePath;
        const convCount = await this._countConversations(filePath);
        users.push({
          email,
          displayName: email,
          conversationCount: convCount,
          exportFile: filePath,
        });
      } catch {
        /* skip unreadable files */
      }
    }

    return users;
  }

  async loadUserConversations(email, fromDate = null, toDate = null) {
    if (!this._userFiles) await this.discoverUsers();

    const filePath = this._userFiles[email];
    if (!filePath || !fs.existsSync(filePath)) return [];

    const xml = fs.readFileSync(filePath, "utf8");
    const parsed = await parseStringPromise(xml, {
      explicitArray: true,
      trim: true,
    });

    const root = parsed.GeminiUserConversationHistory;
    const rawConvs = root?.Conversations?.[0]?.Conversation || [];

    const conversations = [];

    for (const conv of rawConvs) {
      const id = conv.ConversationId?.[0] || "";
      const title = conv.ConversationTopic?.[0] || "Untitled Conversation";
      const turns = conv.ConversationTurns?.[0]?.ConversationTurn || [];
      if (turns.length === 0) continue;

      const firstTs = turns[0]?.Timestamp?.[0] || null;

      if (firstTs && (fromDate || toDate)) {
        const d = new Date(firstTs);
        if (fromDate && d < new Date(fromDate + "T00:00:00Z")) continue;
        if (toDate && d > new Date(toDate + "T23:59:59Z")) continue;
      }

      const normTurns = turns
        .map((turn, i) => ({
          turn_id: turn.RequestId?.[0] || `turn_${i}`,
          prompt: turn.Prompt?.[0]?.Text?.[0] || "",
          response: turn.PrimaryResponse?.[0]?.Text?.[0] || "",
          timestamp: turn.Timestamp?.[0] || null,
          is_followup: i > 0,
        }))
        .filter((t) => t.prompt);

      if (normTurns.length === 0) continue;

      conversations.push({
        id,
        title,
        created_at: firstTs,
        geminiUrl: id ? `https://gemini.google.com/app/${id}` : null,
        turns: normTurns,
      });
    }

    return conversations;
  }

  async _extractEmailFromFile(filePath) {
    const xml = fs.readFileSync(filePath, "utf8");
    const parsed = await parseStringPromise(xml, {
      explicitArray: true,
      trim: true,
    });
    return (
      parsed?.GeminiUserConversationHistory?.User?.[0]?.Email?.[0] || null
    );
  }

  async _countConversations(filePath) {
    const xml = fs.readFileSync(filePath, "utf8");
    const parsed = await parseStringPromise(xml, {
      explicitArray: true,
      trim: true,
    });
    const convs =
      parsed?.GeminiUserConversationHistory?.Conversations?.[0]
        ?.Conversation || [];
    return convs.length;
  }
}
```

---

### `server/src/migration/migrate.js`

```js
/**
 * Migration runner: for each user pair, fetch Copilot interactions,
 * generate per-conversation DOCX files, and upload them to the
 * destination user's Gemini.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
} from "docx";
import {
  getServiceAccountAuth,
  createDriveFolder,
  uploadFileToDrive,
} from "../googleService.js";
import { getCopilotInteractionsForUser } from "../copilotService.js";
import { createSourceGraphClient } from "../copilotService.js";

// ── Text extraction (mirrors docBuilder.js) ──────────────────────────

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
        if (el.type === "TextBlock" && el.text) parts.push(el.text);
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
    .filter(
      (a) =>
        a.contentType === "application/vnd.microsoft.card.adaptive" && a.content
    )
    .map((a) => textFromAdaptiveCard(a.content))
    .filter(Boolean);
  if (attachmentTexts.length > 0) return attachmentTexts.join("\n\n");
  return contentType === "html" ? stripHtml(body) : body.trim();
}

// ── Grouping ─────────────────────────────────────────────────────────

function groupBySession(interactions) {
  const map = new Map();
  for (const item of interactions) {
    const sid = item.sessionId || "unknown";
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(item);
  }
  for (const items of map.values()) {
    items.sort(
      (a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime)
    );
  }
  return map;
}

function formatTimestamp(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function textRuns(text, style = {}) {
  const lines = text.split("\n");
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) runs.push(new TextRun({ break: 1, ...style }));
    runs.push(new TextRun({ text: lines[i], ...style }));
  }
  return runs;
}

// ── Build single-conversation DOCX ───────────────────────────────────

async function buildConversationDocx(items, convIdx, userName) {
  const children = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Conversation ${convIdx}`,
          bold: true,
          size: 44,
        }),
      ],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: `${userName} — ${items.length} message${items.length === 1 ? "" : "s"}`,
          size: 24,
          color: "666666",
          italics: true,
        }),
      ],
    })
  );

  const firstDate = items[0]?.createdDateTime;
  if (firstDate) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        children: [
          new TextRun({
            text: formatTimestamp(firstDate),
            size: 20,
            color: "888888",
          }),
        ],
      })
    );
  }

  const isChatGPT = items.some((i) => i.sessionId?.startsWith("chatgpt-") || i._conversationTitle);

  for (const item of items) {
    const isUser = item.interactionType === "userPrompt";
    const senderLabel = isUser ? "You" : isChatGPT ? "ChatGPT" : "Copilot";
    const text = extractText(item);
    if (!text) continue;

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
            text: `    ${formatTimestamp(item.createdDateTime)}`,
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
        children: textRuns(text, {
          size: 21,
          font: "Calibri",
          color: "333333",
        }),
      })
    );
  }

  const doc = new Document({
    creator: "Copilot Migration Tool",
    title: `Conversation ${convIdx}`,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Conversation title (first user prompt, truncated) ────────────────

function conversationTitle(items) {
  const chatgptTitle = items[0]?._conversationTitle;
  if (chatgptTitle && chatgptTitle !== "Untitled Conversation") return chatgptTitle.slice(0, 80);

  for (const item of items) {
    if (item.interactionType === "userPrompt") {
      const text = extractText(item);
      if (text) return text.slice(0, 80).replace(/\n/g, " ");
    }
  }
  return "Untitled";
}

// ── Main migration function ──────────────────────────────────────────

export async function migrateUserPair({
  sourceUserId,
  sourceDisplayName,
  destUserEmail,
  _chatgptInteractions,
}) {
  const result = {
    sourceUserId,
    sourceDisplayName: sourceDisplayName || sourceUserId,
    destUserEmail,
    conversationsCount: 0,
    filesUploaded: 0,
    errors: [],
    files: [],
  };

  try {
    let interactions;
    let folderName;

    if (_chatgptInteractions && _chatgptInteractions.length > 0) {
      interactions = _chatgptInteractions;
      folderName = "ChatGPTChats";
    } else {
      const { accessToken } = await createSourceGraphClient();
      interactions = await getCopilotInteractionsForUser(
        accessToken,
        sourceUserId,
        {}
      );
      folderName = "CopilotChats";
    }

    const sessions = groupBySession(interactions);
    result.conversationsCount = sessions.size;

    if (sessions.size === 0) {
      result.errors.push("No conversations found for this user.");
      return result;
    }

    const auth = getServiceAccountAuth(destUserEmail);
    const folder = await createDriveFolder(auth, folderName);

    let convIdx = 0;
    for (const [, items] of sessions) {
      convIdx++;
      try {
        const title = conversationTitle(items);
        const dateStr = items[0]?.createdDateTime
          ? new Date(items[0].createdDateTime).toISOString().slice(0, 10)
          : "unknown";
        const fileName = `Conversation_${convIdx}_${dateStr}.docx`;

        const buffer = await buildConversationDocx(
          items,
          convIdx,
          sourceDisplayName || sourceUserId
        );

        const file = await uploadFileToDrive(
          auth,
          fileName,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buffer,
          folder.id
        );

        result.filesUploaded++;
        result.files.push({
          name: fileName,
          title,
          driveFileId: file.id,
          webViewLink: file.webViewLink,
        });
      } catch (err) {
        result.errors.push(
          `Conversation ${convIdx}: ${err.message || String(err)}`
        );
      }
    }
  } catch (err) {
    result.errors.push(err.message || String(err));
  }

  return result;
}

/**
 * Run migration for multiple user pairs.
 * @param {Array<{sourceUserId: string, sourceDisplayName?: string, destUserEmail: string}>} pairs
 */
export async function runMigration(pairs) {
  const results = [];
  for (const pair of pairs) {
    const r = await migrateUserPair(pair);
    results.push(r);
  }
  return results;
}
```

---

*End of PROJECT_CONTEXT.md — Generated on 2026-04-16*
