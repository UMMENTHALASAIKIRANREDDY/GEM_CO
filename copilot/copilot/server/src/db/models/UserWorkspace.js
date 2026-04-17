import mongoose from "mongoose";

const userWorkspaceSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  config: { type: mongoose.Schema.Types.Mixed, default: {} },
  currentBatchId: { type: String, default: "" },
  migrationMode: { type: String, default: "copilot-gemini" },
  mappings: { type: mongoose.Schema.Types.Mixed, default: {} },
  selectedUsers: { type: [String], default: [] },
  options: { type: mongoose.Schema.Types.Mixed, default: {} },
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  step: { type: Number, default: 0 },
  migDone: { type: Boolean, default: false },
  uploadData: { type: mongoose.Schema.Types.Mixed, default: null },
  googleEmail: { type: String, default: null },
  msEmail: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

userWorkspaceSchema.index({ userId: 1 }, { unique: true });

export default mongoose.model("UserWorkspace", userWorkspaceSchema, "userWorkspace");
