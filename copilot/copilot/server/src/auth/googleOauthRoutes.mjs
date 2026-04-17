import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import AuthSession from "../db/models/Cloud.js";
import CloudMember from "../db/models/ChatsHistory.js";
import { isDBConnected } from "../db/connection.js";

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

    const email = payload?.email || "";
    const name = payload?.name || "";

    req.session.googleAuth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email,
      name,
      expiresOn: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
    };

    if (isDBConnected()) {
      const appUserId = req.session.appUserId || "anonymous";
      try {
        await AuthSession.findOneAndUpdate(
          { appUserId, provider: "google" },
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || "",
            email,
            displayName: name,
            tokenExpiry: tokens.expiry_date || null,
            connectedAt: new Date(),
            lastRefreshed: new Date(),
          },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        console.warn("[DB] Failed to persist Google auth session:", dbErr.message);
      }
    }

    res.redirect("/?auth=google_success");
  } catch (e) {
    res.status(500).send(`Google token exchange failed: ${e.message}`);
  }
});

googleAuthRouter.post("/logout", async (req, res) => {
  delete req.session.googleAuth;
  if (isDBConnected()) {
    try {
      const appUserId = req.session.appUserId || "anonymous";
      await AuthSession.deleteOne({ appUserId, provider: "google" });
      await CloudMember.deleteMany({ source: "google" });
      console.log("[DB] Google disconnect: cleared authSession, cloudMembers");
    } catch (e) {
      console.warn("[DB] Google disconnect cleanup:", e.message);
    }
  }
  res.json({ ok: true });
});

export function getGoogleSessionToken(req) {
  return req.session?.googleAuth?.accessToken || null;
}
