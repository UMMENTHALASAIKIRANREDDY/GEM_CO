import mongoose from "mongoose";

const authSessionSchema = new mongoose.Schema({
  provider: { type: String, enum: ["microsoft", "google"], required: true },
  appUserId: { type: String, required: true },
  accessToken: { type: String, default: "" },
  refreshToken: { type: String, default: "" },
  tokenExpiry: { type: Number },
  email: { type: String, default: "" },
  displayName: { type: String, default: "" },
  tenantId: { type: String, default: "" },
  msalCache: { type: String, default: "" },
  connectedAt: { type: Date, default: Date.now },
  lastRefreshed: { type: Date, default: Date.now },
});

authSessionSchema.index({ appUserId: 1, provider: 1 }, { unique: true });

export default mongoose.model("AuthSession", authSessionSchema, "authSessions");
