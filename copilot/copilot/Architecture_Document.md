# Copilot to Gemini Migration — System Architecture Document

**Product:** Copilot to Gemini Migration Tool  
**Company:** CloudFuze, Inc.  
**Version:** 1.0  
**Date:** April 14, 2026

---

## Overview

The Copilot to Gemini Migration Tool is a full-stack web application that migrates Microsoft Copilot chat history from Microsoft 365 to Google Workspace. It extracts each user's Copilot conversation data via the Microsoft Graph API, converts conversations into DOCX documents, and uploads them into a dedicated folder in each mapped Google user's Google Drive using a service account with domain-wide delegation.

The system follows a **four-layer architecture** — Presentation, API, Service, and External Services — each with clearly defined responsibilities.

---

## Layer 1: Presentation Layer (React SPA)

**Technology:** React 18, Vite, CSS  
**Location:** `client/src/`

### Purpose

This is the user-facing interface. It is a single-page application (SPA) built with React and bundled by Vite. In production, the compiled output (`dist/client/`) is served as static files by the Express server, so the entire application runs on a single port.

### Components

| Component | Step | Responsibility |
|-----------|------|----------------|
| **AuthPanel.jsx** | Connect | Displays two cloud cards — Microsoft Copilot and Google Gemini. Each card lets the tenant admin sign in via OAuth or disconnect. It polls `/auth/status` to reflect real-time connection state. |
| **ChatsPanel.jsx** | Chats | Lists all Microsoft 365 directory users. When a user row is expanded, it fetches that user's Copilot conversation summaries from the API and displays them inline. This gives the admin visibility into what data exists before migration. |
| **MapPanel.jsx** | Map | Shows Microsoft users on the left and Google users on the right. It auto-maps users by matching email addresses. The admin can override mappings by uploading a CSV/TSV file (`sourceEmail, destEmail`). A CSV download option is also available for offline editing. |
| **MigratePanel.jsx** | Migrate | Presents all valid mapped pairs (those with both a `sourceUserId` and a `destEmail`) in a selectable table. The admin selects which users to migrate and clicks "Start Migration." The UI immediately redirects to the Reports tab while the migration runs in the background. |
| **ReportsPanel.jsx** | Reports | Displays migration progress and results. While migration is running, it shows an animated progress bar. Once complete, it renders summary statistics (total, succeeded, partial, failed, conversations, files uploaded) and a detailed per-user results table with expandable error details and Google Drive file links. |

### Supporting Modules

| Module | Role |
|--------|------|
| **App.jsx** | Root component. Manages global state (auth status, user lists, mapping, migration results, active step). Renders the stepper navigation and conditionally mounts the active panel. Contains Back/Next step navigation buttons. |
| **App.css** | All application styling — header, stepper wizard, cloud cards, tables, buttons, stat cards, progress bars, and step navigation. Uses a white background with `#0129AC` (CloudFuze blue) accent color throughout. |
| **index.css** | Base/global styles — body background (`#f5f7fa`), font stack, reset rules. |
| **main.jsx** | React 18 entry point. Calls `createRoot` and renders `<App />` inside `<StrictMode>`. |
| **utils/downloadJson.js** | Helper to trigger a browser-side JSON file download from in-memory data. |

### Data Flow Within This Layer

1. `App.jsx` loads settings on mount (`GET /api/settings`).
2. When Microsoft auth is detected, it loads directory users (`GET /api/users`).
3. When Google auth is detected, it loads Google users (`GET /api/google/users`).
4. These user lists are passed down as props to `ChatsPanel`, `MapPanel`, and `MigratePanel`.
5. Mapping state and migration results are lifted to `App.jsx` and shared across panels.

---

## Layer 2: API Layer (Express.js)

**Technology:** Express.js, express-session, multer, CORS  
**Location:** `server/index.mjs`

### Purpose

This is the HTTP server that acts as the single gateway between the frontend and all backend logic. It handles authentication redirects, exposes RESTful endpoints for data retrieval and manipulation, manages user sessions, and in production serves the compiled frontend assets.

### Route Groups

#### Authentication Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/source/login` | Redirects to Microsoft OAuth consent screen (MSAL auth-code flow). |
| GET | `/auth/source/callback` | Handles Microsoft OAuth callback. Stores access token and user info in the session. |
| POST | `/auth/source/logout` | Clears Microsoft auth data from the session. |
| GET | `/auth/google/login` | Redirects to Google OAuth consent screen (Admin Directory read-only + OpenID scopes). |
| GET | `/auth/google/callback` | Handles Google OAuth callback. Stores access/refresh tokens and user info in the session. |
| POST | `/auth/google/logout` | Clears Google auth data from the session. |
| GET | `/auth/status` | Returns combined auth status — whether Microsoft and Google are connected, and the logged-in user's email/name for each. |

#### User Data Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | Returns all Microsoft 365 directory users. Uses an **application-only** Graph token (client credentials), not the delegated OAuth token. |
| GET | `/api/google/users` | Returns all Google Workspace users via the Admin SDK, using the Google OAuth session token. |
| GET | `/api/users/:userId/copilot` | Fetches all Copilot interactions for a specific user. Supports `?copilotChatOnly=true` filter. |
| GET | `/api/users/:userId/copilot/preview` | Returns a lightweight conversation summary (session grouping, message counts) for the Chats panel preview. |

#### Mapping Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mapping` | Returns the current user mapping pairs stored in the session. |
| POST | `/api/mapping` | Saves mapping pairs to the session. |
| GET | `/api/mapping/csv` | Downloads the current mapping as a CSV file. |
| POST | `/api/mapping/csv` | Accepts a CSV/TSV file upload (`multipart/form-data`). Auto-detects delimiter (tab or comma). Enriches each pair with `sourceUserId` and `sourceDisplayName` by looking up the source email in the Microsoft directory. Stores the result in the session. |

#### Migration Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/migrate` | Accepts `{ pairs: [...] }` and runs the full migration pipeline. Returns per-user results (conversations processed, files uploaded, errors, Drive links). |
| GET | `/api/migrate/results` | Returns previously stored migration results from the session. |

#### Export Routes (Standalone)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/export/all` | Exports all users and their Copilot interactions as JSON. |
| GET | `/api/users/:userId/copilot/docx` | Downloads a single user's Copilot data as a DOCX file. |
| GET | `/api/export/all/docx` | Downloads all users' Copilot data as a single combined DOCX file. |

#### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Returns non-sensitive configuration — Graph API version, page size, Copilot chat filter flag, tenant summary. |
| GET | `/api/health` | Simple health check returning `{ ok: true }`. |

### Middleware Stack

| Middleware | Purpose |
|------------|---------|
| **CORS** | Allows cross-origin requests during development (Vite dev server on a different port). |
| **express.json()** | Parses JSON request bodies. |
| **express-session** | Maintains server-side sessions. Stores OAuth tokens (Microsoft and Google), user mapping pairs, and migration results. Currently uses in-memory store (planned migration to MongoDB). |
| **multer (memoryStorage)** | Handles `multipart/form-data` file uploads for CSV/TSV mapping files. Files are kept in memory buffers, not written to disk. |
| **express.static** | In production, serves the compiled React app from `dist/client/`. A catch-all route sends `index.html` for any non-API, non-auth path to support SPA client-side routing. |

---

## Layer 3: Service Layer (Business Logic)

**Technology:** Node.js modules  
**Location:** `server/src/`

### Purpose

This layer contains all business logic, external API communication, and data transformation. Each module has a single responsibility and is consumed by the API layer's route handlers.

### Modules

#### copilotService.js — Microsoft Graph Client

Provides the primary interface for interacting with Microsoft Graph. Reads environment variables for tenant ID, client ID, client secret, and Graph API options. Creates an application-only Graph client using client credentials. Exposes two key functions:

- **`listDirectoryUsers(token)`** — Calls Microsoft Graph `/users` with pagination to retrieve all directory users. Returns an array of user objects with `id`, `displayName`, `userPrincipalName`, and `mail`.
- **`getCopilotInteractionsForUser(token, userId, options)`** — Calls the Copilot `getAllEnterpriseInteractions` endpoint for a specific user. Supports filtering by `appClass` to isolate BizChat and WebChat conversations only. Returns raw interaction objects.

#### googleService.js — Google Drive + Admin SDK

Manages all Google API interactions using two different authentication mechanisms:

- **OAuth token** (from the admin's Google sign-in): Used by `listGoogleUsers(accessToken)` to call the Google Admin Directory API and retrieve all Google Workspace users.
- **Service Account with domain-wide delegation**: Used for Drive operations during migration. The function `getServiceAccountAuth(subjectEmail)` creates a `GoogleAuth` instance that impersonates the destination user, allowing file uploads into their personal Drive.

Key functions:
- **`listGoogleUsers(accessToken)`** — Lists all users in the Google Workspace domain.
- **`getServiceAccountAuth(subjectEmail)`** — Creates an authenticated client impersonating the given user.
- **`createDriveFolder(auth, folderName)`** — Creates a folder (e.g., `CopilotChats`) in the impersonated user's Drive.
- **`uploadFileToDrive(auth, folderId, fileName, mimeType, buffer)`** — Uploads a file (DOCX) to the specified Drive folder.

#### docBuilder.js — DOCX Generator

Converts raw Copilot interaction data into formatted Word documents using the `docx` npm package. Groups interactions by `sessionId` to form logical conversations. Each conversation becomes a section in the document with:

- A heading showing the conversation title or first message preview
- Timestamped message entries with sender identification
- Extracted text from HTML content and Adaptive Card payloads

The function `buildDocx(userId, displayName, interactions)` returns a Buffer containing the complete `.docx` file.

#### migrate.js — Migration Engine

Orchestrates the end-to-end migration for one or more user pairs. For each pair:

1. Fetches all Copilot interactions for the source Microsoft user (via `copilotService`).
2. Groups interactions by `sessionId` into distinct conversations.
3. Generates one DOCX file per conversation (via `docBuilder`).
4. Authenticates as the destination Google user via service account delegation (via `googleService`).
5. Creates a `CopilotChats` folder in the destination user's Google Drive (or reuses if it exists).
6. Uploads each DOCX file to that folder.
7. Collects results: conversations count, files uploaded, errors, and Google Drive links for each file.

Exposes:
- **`migrateUserPair(pair)`** — Migrates a single source→destination user pair.
- **`runMigration(pairs)`** — Runs `migrateUserPair` for each pair in the array and aggregates all results.

#### auth.js — Token Manager

Handles the client credentials OAuth flow for obtaining an application-only Microsoft Graph access token. Sends a POST request to `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` with the app's client ID and client secret. The returned token has application-level permissions (`User.Read.All`, `AIInteractionHistory.Read.All`) and is used for all Graph data-read operations.

#### msalConfig.js — MSAL Authentication

Configures the `@azure/msal-node` `ConfidentialClientApplication` for the Microsoft OAuth authorization code flow. This is the delegated (user-based) auth flow used when the admin clicks "Sign in with Microsoft" in the UI. It configures:

- Client ID, client secret, and tenant authority
- Redirect URI (`/auth/source/callback`)
- Required scopes (defaults to `User.Read`)

#### appClass.js — Copilot Filters

Defines constants for Microsoft Copilot `appClass` values (BizChat, WebChat, Teams, Word, Excel, etc.) and provides utility functions:

- **`buildCopilotChatOnlyFilter()`** — Constructs an OData `$filter` expression that isolates only chat-based Copilot interactions.
- **`isCopilotChatSurface(appClass)`** — Returns true if the given `appClass` represents a Copilot chat surface.

#### graphCredentials.js — Credential Resolution

Resolves Microsoft Entra (Azure AD) application credentials from environment variables. Supports both `SOURCE_*` prefixed variables and legacy `AZURE_*` variables for backward compatibility. Provides:

- **`tryResolveSourceCredentials()`** — Returns `{ tenantId, clientId, clientSecret }` or null if not configured.
- **`requireSourceCredentials()`** — Same as above but throws if credentials are missing.
- **`readTenantSummaryForApi()`** — Returns a sanitized tenant summary (IDs only, no secrets) for the `/api/settings` endpoint.

#### graph.js — Graph API Paginator

Low-level function that handles paginated Microsoft Graph API calls to the `getAllEnterpriseInteractions` endpoint. Follows `@odata.nextLink` pagination tokens until all results are fetched. Returns the full array of interaction objects.

#### users.js — User Directory Paginator

Low-level function that handles paginated Microsoft Graph API calls to `/users`. Supports custom OData filters and configurable page size. Returns the complete array of user objects.

---

## Layer 4: External Services

### Purpose

These are the third-party cloud services that the application integrates with. The Service Layer communicates with these services over HTTPS using OAuth tokens or service account credentials.

### Microsoft Identity Platform (Entra ID)

**Endpoint:** `login.microsoftonline.com`

Two authentication flows are used:

1. **Authorization Code Flow (Delegated):** The tenant admin signs in through the browser. The application obtains a delegated access token scoped to `User.Read`. This token is stored in the Express session and is primarily used to confirm that the admin is authenticated. The UI shows "Connected" based on this.

2. **Client Credentials Flow (Application):** The server directly requests a token from Azure AD using the application's client ID and client secret. This token carries application-level permissions and is used for all data-read operations. This separation ensures that even if the admin's delegated token lacks certain permissions, the application can still read users and Copilot data.

**Required Application Permissions:**
- `User.Read.All` — Read all user profiles in the Microsoft 365 tenant.
- `AIInteractionHistory.Read.All` — Read all Copilot interaction history for any user in the tenant.

### Microsoft Graph API

**Endpoint:** `graph.microsoft.com`

The application calls two primary Graph resources:

- **`/users`** — Retrieves all directory users with `id`, `displayName`, `userPrincipalName`, and `mail` fields. Used to populate the Chats panel user list and to enrich mapping pairs.
- **`/copilot/users/{userId}/interactionHistory/getAllEnterpriseInteractions`** — Retrieves all Copilot conversations for a given user. Each interaction includes session ID (for conversation grouping), app class (BizChat, WebChat, etc.), timestamps, and message content in HTML and Adaptive Card formats.

### Google OAuth 2.0

**Endpoint:** `accounts.google.com`

The tenant admin signs in with their Google Workspace admin account. The application requests the following scopes:

- `https://www.googleapis.com/auth/admin.directory.user.readonly` — Read the Google Workspace user directory.
- `openid`, `email`, `profile` — Identify the signed-in admin.

The resulting access token is used to list Google Workspace users via the Admin SDK.

### Google Admin SDK (Directory API)

**Endpoint:** `admin.googleapis.com`

Used to list all Google Workspace users in the domain. The response provides `primaryEmail`, `name.fullName`, and `id` for each user. This data powers the right-hand column of the Map panel and enables auto-mapping by email.

### Google Drive API

**Endpoint:** `www.googleapis.com/drive/v3`

Used during migration to upload DOCX files into each destination user's personal Google Drive. Authentication uses a **Google Cloud service account with domain-wide delegation**, which allows the application to impersonate any user in the Google Workspace domain without requiring their individual consent.

For each destination user, the application:
1. Creates an auth client impersonating that user (`subject` parameter in `GoogleAuth`).
2. Creates a `CopilotChats` folder in their Drive root (if it doesn't already exist).
3. Uploads one DOCX file per Copilot conversation into that folder.
4. Returns the `webViewLink` for each uploaded file so it can be displayed in the Reports panel.

**Required Domain-Wide Delegation Scopes:**
- `https://www.googleapis.com/auth/drive` — Full read/write access to the impersonated user's Drive.

---

## Infrastructure & Configuration

### Environment Variables (`.env`)

| Variable | Purpose |
|----------|---------|
| `AZURE_TENANT_ID` / `SOURCE_TENANT_ID` | Microsoft 365 tenant identifier |
| `AZURE_CLIENT_ID` / `SOURCE_CLIENT_ID` | Azure AD application (client) ID |
| `AZURE_CLIENT_SECRET` / `SOURCE_CLIENT_SECRET` | Azure AD application secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SESSION_SECRET` | Secret key for express-session cookie signing |
| `PORT` | HTTP server port (default: 3000) |
| `GRAPH_API_VERSION` | Microsoft Graph API version (default: beta) |
| `COPILOT_CHAT_ONLY` | Filter to BizChat/WebChat interactions only (true/false) |

### Service Account Key

A Google Cloud service account key file (`service_account.json` or `google-service-account.json`) must be present at the project root. This file contains the private key used for domain-wide delegation. It is excluded from version control via `.gitignore`.

### Session Store

Currently uses the default in-memory store provided by `express-session`. This means sessions (OAuth tokens, mapping data, migration results) are lost on server restart. A planned migration to MongoDB will provide persistent storage.

---

## Data Flow Summary

```
User Browser
    |
    v
[Presentation Layer - React SPA]
    |  HTTP requests (fetch)
    v
[API Layer - Express.js]
    |  Function calls
    v
[Service Layer - Node.js modules]
    |  HTTPS (OAuth tokens, service account)
    v
[External Services]
    ├── Microsoft Identity → Access Tokens
    ├── Microsoft Graph    → Users + Copilot Data
    ├── Google OAuth        → Admin Token
    ├── Google Admin SDK    → Google Users
    └── Google Drive API    → DOCX Upload
```

### Migration Flow (End to End)

1. Admin signs in with Microsoft (OAuth) → session stores token → UI shows "Connected."
2. Admin signs in with Google (OAuth) → session stores token → UI shows "Connected."
3. App fetches Microsoft users (client credentials → Graph `/users`).
4. App fetches Google users (OAuth token → Admin SDK).
5. Users are auto-mapped by matching email addresses; admin can override via CSV upload.
6. Admin selects user pairs and clicks "Start Migration."
7. For each pair, the server:
   - Fetches Copilot interactions from Graph (client credentials).
   - Groups interactions by session/conversation.
   - Generates a DOCX file for each conversation.
   - Impersonates the destination Google user via service account.
   - Creates a `CopilotChats` folder in their Drive.
   - Uploads all DOCX files.
8. Results (success/failure, file counts, Drive links) are returned to the UI.
9. Reports panel displays the migration summary and per-user details.

---

*Document generated for internal presentation purposes.*
