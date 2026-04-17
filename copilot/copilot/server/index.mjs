import "dotenv/config";
import cors from "cors";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { connectDB, isDBConnected } from "./src/db/connection.js";
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
import { jwtAuthRouter, optionalAuth } from "./src/auth/jwtAuth.js";
import { buildDocx } from "./src/docBuilder.js";
import { listGoogleUsers } from "./src/googleService.js";
import { runMigration } from "./src/migration/migrate.js";
import CloudMember from "./src/db/models/ChatsHistory.js";
import UserMapping from "./src/db/models/UserMapping.js";
import ReportsWorkspace from "./src/db/models/Job.js";
import MigrationLog from "./src/db/models/MigrationLog.js";
import Upload from "./src/db/models/Upload.js";
import Checkpoint from "./src/db/models/Checkpoint.js";
import CopilotHistory from "./src/db/models/CopilotHistory.js";

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
app.use("/api/auth", jwtAuthRouter);
app.use(optionalAuth);

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

    if (isDBConnected()) {
      const ops = users.map((u) => ({
        updateOne: {
          filter: { source: "microsoft", email: (u.userPrincipalName || "").toLowerCase() },
          update: {
            $set: {
              displayName: u.displayName || "",
              tenantId: process.env.SOURCE_TENANT_ID || null,
              discoveredAt: new Date(),
            },
            $setOnInsert: { source: "microsoft", email: (u.userPrincipalName || "").toLowerCase() },
          },
          upsert: true,
        },
      }));
      CloudMember.bulkWrite(ops).catch((e) => console.warn("[DB] cloudMembers bulk:", e.message));

      fetchAndStoreCopilotHistory(accessToken, users).catch((e) =>
        console.warn("[DB] copilot history fetch:", e.message)
      );
    }

    res.json({
      generatedAt: new Date().toISOString(),
      count: users.length,
      users,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

async function fetchAndStoreCopilotHistory(accessToken, users) {
  for (const u of users) {
    try {
      const existing = await CopilotHistory.findOne({ userId: u.id, source: "copilot" });
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (existing && existing.fetchedAt > oneHourAgo) continue;

      const interactions = await getCopilotInteractionsForUser(accessToken, u.id, {});
      if (interactions.length === 0) continue;

      const sessionSet = new Set(interactions.map((i) => i.sessionId || "unknown"));

      await CopilotHistory.findOneAndUpdate(
        { userId: u.id, source: "copilot" },
        {
          userEmail: (u.userPrincipalName || "").toLowerCase(),
          displayName: u.displayName || "",
          interactionsCount: interactions.length,
          conversationsCount: sessionSet.size,
          interactions,
          fetchedAt: new Date(),
        },
        { upsert: true }
      );
    } catch (e) {
      console.warn(`[DB] copilot history for ${u.userPrincipalName}:`, e.message);
    }
  }
}

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
    let interactions;

    if (isDBConnected()) {
      const cached = await CopilotHistory.findOne({ userId, source: "copilot" });
      if (cached && cached.interactions?.length > 0) {
        interactions = cached.interactions;
      }
    }

    if (!interactions) {
      const accessToken = await getAppOnlyToken();
      interactions = await getCopilotInteractionsForUser(accessToken, userId, {});
    }

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

    if (isDBConnected()) {
      const ops = users.map((u) => ({
        updateOne: {
          filter: { source: "google", email: (u.email || "").toLowerCase() },
          update: {
            $set: { displayName: u.name || "", discoveredAt: new Date() },
            $setOnInsert: { source: "google", email: (u.email || "").toLowerCase() },
          },
          upsert: true,
        },
      }));
      CloudMember.bulkWrite(ops).catch((e) => console.warn("[DB] cloudMembers bulk:", e.message));
    }

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

app.post("/api/mapping", async (req, res) => {
  const { pairs, migrationMode } = req.body;
  if (!Array.isArray(pairs)) {
    return res.status(400).json({ error: "pairs must be an array" });
  }
  req.session.mapping = pairs;

  if (isDBConnected()) {
    const batchId = String(Date.now());
    const mappingsObj = {};
    for (const p of pairs) {
      if (p.sourceEmail && p.destEmail) mappingsObj[p.sourceEmail] = p.destEmail;
    }
    try {
      await UserMapping.create({
        batchId,
        migrationMode: migrationMode || "copilot-gemini",
        mappings: mappingsObj,
        appUserId: req.appUserId || "anonymous",
      });
    } catch (e) {
      console.warn("[DB] userMapping save:", e.message);
    }
  }

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
// Gemini import (Vault ZIP placeholder)
// ---------------------------------------------------------------------------

app.post("/api/gemini/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    // Placeholder: store the raw buffer for later processing with vaultReader
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

async function persistMigration(batchId, mode, pairs, results, appUserId) {
  if (!isDBConnected()) return;
  try {
    await MigrationLog.create({ batchId, type: "info", message: "--- Migration started ---" });

    const succeeded = results.filter((r) => r.filesUploaded > 0 && r.errors.length === 0).length;
    const failed = results.filter((r) => r.filesUploaded === 0).length;
    const totalConvs = results.reduce((s, r) => s + r.conversationsCount, 0);

    for (const r of results) {
      const status = r.filesUploaded > 0 && r.errors.length === 0 ? "success" : r.filesUploaded > 0 ? "warning" : "error";
      await MigrationLog.create({
        batchId,
        type: status,
        message: `${r.sourceDisplayName}: ${r.filesUploaded} files, ${r.conversationsCount} conversations`,
        extra: { destEmail: r.destUserEmail },
      });
    }

    await MigrationLog.create({ batchId, type: "success", message: "--- Migration complete! Reports saved. ---" });

    const reportUsers = results.map((r) => ({
      email: r.destUserEmail,
      conversations_processed: r.conversationsCount,
      files_uploaded: r.filesUploaded,
      error_count: r.errors.length,
      errors: r.errors.map((e) => ({ error_message: e })),
      status: r.filesUploaded > 0 && r.errors.length === 0 ? "success" : "failed",
    }));

    await ReportsWorkspace.create({
      _id: batchId,
      migrationMode: mode || "copilot-gemini",
      startTime: new Date(),
      endTime: new Date(),
      status: failed === results.length ? "failed" : "completed",
      appUserId: appUserId || "anonymous",
      totalUsers: results.length,
      migratedUsers: succeeded,
      failedUsers: failed,
      totalConversations: totalConvs,
      migratedConversations: totalConvs,
      report: {
        report_type: "migration_report",
        generated_at: new Date().toISOString(),
        summary: {
          total_users: results.length,
          total_files_uploaded: results.reduce((s, r) => s + r.filesUploaded, 0),
          total_errors: results.reduce((s, r) => s + r.errors.length, 0),
        },
        users: reportUsers,
      },
    });

    await Checkpoint.findOneAndUpdate(
      { batchId },
      { completedUsers: results.map((r) => r.destUserEmail), updatedAt: new Date() },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[DB] persistMigration:", e.message);
  }
}

app.post("/api/migrate", async (req, res) => {
  const { pairs, mode } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return res
      .status(400)
      .json({ error: "pairs array is required and must not be empty" });
  }

  const batchId = String(Date.now());

  try {
    if (mode === "gemini-copilot") {
      return res.status(501).json({
        error: "Gemini to Copilot migration is not yet fully integrated.",
      });
    }

    const migrationPairs = pairs.map((p) => {
      console.log(`[Migrate] Pair: sourceUserId="${p.sourceUserId}", sourceEmail="${p.sourceEmail}", destEmail="${p.destEmail}"`);
      return {
        sourceUserId: p.sourceUserId,
        sourceDisplayName: p.sourceDisplayName || p.sourceEmail || p.sourceUserId,
        destUserEmail: p.destEmail,
      };
    });

    const results = await runMigration(migrationPairs);
    migrationResults = results;
    req.session.migrationResults = results;
    persistMigration(batchId, mode, pairs, results, req.appUserId);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/migrate/results", (req, res) => {
  res.json({ results: req.session.migrationResults || migrationResults || [] });
});

app.get("/api/migrate/history", async (_req, res) => {
  if (!isDBConnected()) return res.json({ reports: [] });
  try {
    const reports = await ReportsWorkspace.find().sort({ startTime: -1 }).limit(50).lean();
    res.json({ reports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/migrate/logs/:batchId", async (req, res) => {
  if (!isDBConnected()) return res.json({ logs: [] });
  try {
    const logs = await MigrationLog.find({ batchId: req.params.batchId }).sort({ ts: 1 }).lean();
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
