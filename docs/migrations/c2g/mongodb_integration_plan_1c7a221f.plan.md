---
name: MongoDB Integration Plan
overview: Integrate MongoDB Atlas into the Copilot-to-Gemini migration tool, adding user authentication (login/signup), persistent cloud connections, auto-fetched chat history, user mapping, and migration reports across 5 collections.
todos: []
isProject: false
---

# MongoDB Integration Plan

## Current State

The app currently stores everything **in-memory** via `express-session` (default MemoryStore):
- Auth tokens in `req.session.sourceAuth` / `req.session.googleAuth`
- User mapping in `req.session.mapping`
- Migration results in `req.session.migrationResults` + a module-level variable

This means all data is lost on server restart. MongoDB will make everything persistent.

## Architecture

```mermaid
flowchart TD
    LoginPage["Login / Signup Page"] --> AuthMiddleware["Auth Middleware (JWT)"]
    AuthMiddleware --> Wizard["5-Step Wizard"]
    Wizard --> ConnectStep["Connect Clouds"]
    ConnectStep -->|"MS OAuth callback"| AutoFetch["Auto-fetch Copilot chats"]
    AutoFetch --> ChatsHistoryCol["MongoDB: chatsHistory"]
    ConnectStep --> CloudsCol["MongoDB: clouds"]
    Wizard --> ChatsStep["View Chats (from DB)"]
    ChatsStep --> ChatsHistoryCol
    Wizard --> MapStep["Map Users"]
    MapStep --> UserMappingCol["MongoDB: userMappings"]
    Wizard --> MigrateStep["Migrate"]
    MigrateStep --> ReportsCol["MongoDB: reports"]
    MigrateStep --> GoogleDrive["Google Drive Upload"]
```

## MongoDB Collections

### 1. `users` - App authentication
```js
{
  _id: ObjectId,
  email: String,          // unique, lowercase
  passwordHash: String,   // bcrypt hashed
  displayName: String,
  createdAt: Date,
  lastLoginAt: Date
}
```

### 2. `clouds` - Connected cloud accounts
```js
{
  _id: ObjectId,
  userId: ObjectId,       // ref to users._id
  provider: "microsoft" | "google",
  accessToken: String,
  refreshToken: String,   // Google only
  account