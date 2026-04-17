import mongoose from "mongoose";

const uploadSchema = new mongoose.Schema({
  _id: { type: String },
  appUserId: { type: String, required: true },
  originalName: { type: String, default: "" },
  uploadTime: { type: Date, default: Date.now },
  totalUsers: { type: Number, default: 0 },
  totalConversations: { type: Number, default: 0 },
  source: { type: String, enum: ["chatgpt", "gemini-vault"], default: "chatgpt" },
  users: { type: [mongoose.Schema.Types.Mixed], default: [] },
});

uploadSchema.index({ appUserId: 1 });

export default mongoose.model("Upload", uploadSchema, "uploads");
