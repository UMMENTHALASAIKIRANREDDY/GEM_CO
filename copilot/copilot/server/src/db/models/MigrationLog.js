import mongoose from "mongoose";

const migrationLogSchema = new mongoose.Schema({
  batchId: { type: String, required: true },
  type: { type: String, enum: ["info", "success", "warning", "error"], default: "info" },
  message: { type: String, default: "" },
  ts: { type: Date, default: Date.now },
  extra: { type: mongoose.Schema.Types.Mixed, default: {} },
});

migrationLogSchema.index({ batchId: 1, ts: 1 });

export default mongoose.model("MigrationLog", migrationLogSchema, "migrationLogs");
