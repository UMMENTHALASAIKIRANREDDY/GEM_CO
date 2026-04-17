import mongoose from "mongoose";

const reportsWorkspaceSchema = new mongoose.Schema({
  _id: { type: String },
  customerName: { type: String, default: "" },
  migrationMode: { type: String, default: "copilot-gemini" },
  dryRun: { type: Boolean, default: false },
  startTime: { type: Date },
  endTime: { type: Date },
  status: { type: String, enum: ["pending", "running", "completed", "failed"], default: "pending" },
  tenantId: { type: String, default: "" },
  appUserId: { type: String, default: "" },
  totalUsers: { type: Number, default: 0 },
  migratedUsers: { type: Number, default: 0 },
  failedUsers: { type: Number, default: 0 },
  totalConversations: { type: Number, default: 0 },
  migratedConversations: { type: Number, default: 0 },
  report: { type: mongoose.Schema.Types.Mixed, default: {} },
});

export default mongoose.model("ReportsWorkspace", reportsWorkspaceSchema, "reportsWorkspace");
