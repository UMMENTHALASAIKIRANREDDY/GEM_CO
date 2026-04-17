import { Router } from "express";
import { buildMsalApp, getRedirectUri, SCOPES } from "./msalConfig.js";
import AuthSession from "../db/models/Cloud.js";
import CloudMember from "../db/models/ChatsHistory.js";
import CopilotHistory from "../db/models/CopilotHistory.js";
import { isDBConnected } from "../db/connection.js";

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

    const username = tokenResponse.account?.username || "";
    const displayName = tokenResponse.account?.name || "";

    req.session.sourceAuth = {
      accessToken: tokenResponse.accessToken,
      account: { username, name: displayName },
      expiresOn: tokenResponse.expiresOn?.toISOString(),
      tenantId,
    };

    if (isDBConnected()) {
      const appUserId = req.session.appUserId || "anonymous";
      try {
        await AuthSession.findOneAndUpdate(
          { appUserId, provider: "microsoft" },
          {
            accessToken: tokenResponse.accessToken,
            email: username,
            displayName,
            tenantId,
            tokenExpiry: tokenResponse.expiresOn ? tokenResponse.expiresOn.getTime() : null,
            connectedAt: new Date(),
            lastRefreshed: new Date(),
          },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        console.warn("[DB] Failed to persist MS auth session:", dbErr.message);
      }
    }

    res.redirect("/?auth=success");
  } catch (e) {
    res.status(500).send(`Token exchange failed: ${e.message}`);
  }
});

authRouter.post("/source/logout", async (req, res) => {
  delete req.session.sourceAuth;
  if (isDBConnected()) {
    try {
      const appUserId = req.session.appUserId || "anonymous";
      await AuthSession.deleteOne({ appUserId, provider: "microsoft" });
      await CloudMember.deleteMany({ source: "microsoft" });
      await CopilotHistory.deleteMany({ source: "copilot" });
      console.log("[DB] Microsoft disconnect: cleared authSession, cloudMembers, chatsHistory");
    } catch (e) {
      console.warn("[DB] Microsoft disconnect cleanup:", e.message);
    }
  }
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

export function getSessionToken(req, role) {
  if (role === "source") {
    return req.session?.sourceAuth?.accessToken || null;
  }
  return null;
}
