# Deployment

## Layout

| Path | Role |
|------|------|
| `server/index.mjs` | HTTP API + static UI (`dist/client` after build) |
| `src/` | Graph clients, migration engine, CLI sync |
| `client/` | React UI (Vite) |

## Environment

1. Copy `.env.example` to `.env` on the host (never commit `.env`).
2. Register **two** Entra applications:
   - **Source** tenant: `AiEnterpriseInteraction.Read.All`, `User.Read.All` (read Copilot history).
   - **Destination** tenant (different directory): `User.Read.All`, `Files.ReadWrite.All` (list users + upload OneDrive).
3. **Source and destination tenant IDs must differ** — the app enforces this for migration.
4. Set `MIGRATE_API_KEY` to a long random string; the UI or CLI sends it as `X-Migrate-Api-Key`.

## Build and run (production)

```bash
npm ci
npm run build:ui
node server/index.mjs
```

Or set `npm start` to `node server/index.mjs` and run `npm start` after `npm run build:ui`.

Listen on `PORT` (default `3001`). Place a reverse proxy (HTTPS) in front for internet-facing deployments.

## CLI migration

```bash
node src/migrate-onedrive.js --pairs=./pairs.json --dry-run
```

`pairs.json`:

```json
[
  { "sourceUserId": "guid-from-source-tenant", "destUserId": "guid-from-dest-tenant" }
]
```

## Health check

`GET /api/health` → `{ "ok": true }`

## Web UI workflow

The built React app is served from `dist/client` when you run `node server/index.mjs`. The UI is organized into five tabs: **Connect** (OAuth for source/destination admins), **Export** (load users and download JSON), **Map** (pair source users to destination users; mapping is stored in `sessionStorage` per tenant pair), **Run** (OneDrive migration, OneNote migration, Copilot Studio agent deploy), and **Reports** (history of runs stored in the browser’s `localStorage`, up to 30 entries). Reports are per-browser only unless you add a server-side audit endpoint later.
