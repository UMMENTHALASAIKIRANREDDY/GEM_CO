import mongoose from "mongoose";

const copilotHistorySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userEmail: { type: String, required: true, lowercase: true },
  displayName: { type: String, default: "" },
  source: { type: String, enum: ["copilot", "chatgpt", "gemini"], default: "copilot" },
  interactionsCount: { type: Number, default: 0 },
  conversationsCount: { type: Number, default: 0 },
  interactions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  fetchedAt: { type: Date, default: Date.now },
});

copilotHistorySchema.index({ userId: 1, source: 1 }, { unique: true });

export default mongoose.model("CopilotHistory", copilotHistorySchema, "chatsHistory");
