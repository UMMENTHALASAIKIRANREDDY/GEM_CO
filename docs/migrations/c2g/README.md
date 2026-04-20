# Copilot interaction sync (Node.js)

Fetches **Microsoft 365 Copilot** enterprise interaction history via **Microsoft Graph** (`getAllEnterpriseInteractions`) and writes a **UTF-8 `.txt` file** (default `./copilot_interactions.txt` in the project folder). No database — all Copilot data is in that text export.

## Prerequisites

- Node.js 18+
- **Source** tenant: Entra app with **`AiEnterpriseInteraction.Read.All`** + **`User.Read.All`** (application; admin consent)
- **Destination** tenant (different directory): Entra app with **`User.Read.All`** + **`Files.ReadWrite.All`** for OneDrive migration
- For **tenant-wide sync** (`SYNC_ALL_USERS=true`): **`User.Read.All`** on the source app
- Microsoft 365 Copilot licensing per [Microsoft’s API documentation](https://learn.microsoft.com/graph/api/aiinteractionhistory-getallenterpriseinteractions)
- **`SYNC_ALL_USERS=true`** (recommended to fetch **everyone** without hardcoding user ids — needs **`User.Read.All`**), or **`GRAPH_USER_ID`** / **`GRAPH_USER_IDS`** for explicit users only

## Setup

1. Copy `.env.example` to `.env` and fill in values.

2. Grant API permissions and **admin consent** in Entra ID.

3. Install dependencies:

```bash
npm install
```

4. Run a sync:

```bash
npm run sync
```

## React UI (JSON download)

Configure **`SOURCE_AZURE_*`** and **`DEST_AZURE_*`** in **`.env`** (tenant IDs must differ). See **`docs/DEPLOYMENT.md`**.

```bash
npm run dev
```

- Open **http://localhost:5173** (Vite dev server; API on port **3001**).
- **Load all users** — lists Entra users from Graph.
- **Download JSON — all users** — one JSON file with `users`, `interactionsByUserId`, and `errorsByUserId` (can take a long time for large tenants).
- **Download JSON** on a row — Copilot interactions for that user only.

Production build (API + static UI on **`PORT`**, default **3001**):

```bash
npm run build:ui
npm start
```

Then open **http://localhost:3001** (or whatever port you set in **`PORT`**). Same command is suitable for deployment behind a reverse proxy.

### Port already in use (`EADDRINUSE :::3001`)

Another process (often an old `node server` instance) is still bound to **3001**. Either:

1. Set **`PORT=3002`** in **`.env`** (same file is used by the API and by Vite’s proxy), then run **`npm run dev`** again, or  
2. Stop the old process on Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Fetch all users automatically (no hardcoded user id)

1. In Entra ID, grant the app **application** permission **`User.Read.All`** + **`AiEnterpriseInteraction.Read.All`**, then **admin consent**.
2. In `.env` set **`SYNC_ALL_USERS=true`**.
3. You do **not** set **`GRAPH_USER_ID`** — the tool calls Microsoft Graph **`GET /users`** to read each user’s **object id**, then calls the Copilot interaction API **per user**.
4. Output: **`copilot_interactions.txt`** contains interactions for **all** users that return data; **`directory_users.txt`** lists the directory users that were enumerated.

## Output files (plain text)

| File | When |
|------|------|
| `copilot_interactions.txt` | Always (path overridden by `EXPORT_TXT_PATH`) — full interaction dump per record |
| `directory_users.txt` | When `SYNC_ALL_USERS=true` — tab-separated users plus a JSON block (path: `USER_LIST_EXPORT_PATH`, default `./directory_users.txt`) |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOURCE_AZURE_TENANT_ID` | Yes* | Source tenant ID (Copilot read) |
| `SOURCE_AZURE_CLIENT_ID` | Yes* | Source app client ID |
| `SOURCE_AZURE_CLIENT_SECRET` | Yes* | Source app secret |
| `DEST_AZURE_TENANT_ID` | Yes† | Destination tenant ID (must ≠ source) |
| `DEST_AZURE_CLIENT_ID` | Yes† | Destination app client ID |
| `DEST_AZURE_CLIENT_SECRET` | Yes† | Destination app secret |
| `AZURE_TENANT_ID` | legacy | Same as source if `SOURCE_*` omitted |
| `AZURE_CLIENT_ID` | legacy | Same as source if `SOURCE_*` omitted |
| `AZURE_CLIENT_SECRET` | legacy | Same as source if `SOURCE_*` omitted |
| `GRAPH_USER_ID` | Yes* | One user’s object ID — **omit** when `SYNC_ALL_USERS=true` (ids come from Graph `/users`) |
| `GRAPH_USER_IDS` | No | Comma-separated object IDs |
| `SYNC_ALL_USERS` | No | `true` = all Entra users (`User.Read.All`) |
| `USERS_ODATA_FILTER` | No | OData `$filter` for `/users` |
| `USER_LIST_EXPORT_PATH` | No | Directory export `.txt` (default when syncing all users: `./directory_users.txt`) |
| `USERS_PAGE_SIZE` | No | Max **999** per page for user listing |
| `GRAPH_API_VERSION` | No | `v1.0` (default) or `beta` |
| `GRAPH_FILTER` | No | Custom OData `$filter` for Copilot interactions |
| `COPILOT_CHAT_ONLY` | No | `true`: BizChat + WebChat only |
| `GRAPH_TOP` | No | Page size for interactions (default `100`) |
| `EXPORT_TXT_PATH` | No | Main export file (default `./copilot_interactions.txt`) |

\* **Source** credentials: use `SOURCE_*` or legacy `AZURE_*`.  
† **Destination** credentials: required for OneDrive migration and `/api/destination/users`.

Do not commit `.env` or exports that contain sensitive data. See **`docs/DEPLOYMENT.md`** and **`docs/GRAPH_PERMISSIONS.md`**.
