import mongoose from "mongoose";

const userMappingSchema = new mongoose.Schema({
  batchId: { type: String, required: true },
  customerName: { type: String, default: "" },
  migrationMode: { type: String, enum: ["copilot-gemini", "gemini-copilot"], default: "copilot-gemini" },
  mappings: { type: mongoose.Schema.Types.Mixed, default: {} },
  appUserId: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

userMappingSchema.index({ appUserId: 1, batchId: 1 });

export default mongoose.model("UserMapping", userMappingSchema, "userMappings");
