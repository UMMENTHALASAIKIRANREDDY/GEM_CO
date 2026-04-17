import mongoose from "mongoose";

const cloudMemberSchema = new mongoose.Schema({
  source: { type: String, enum: ["microsoft", "google", "chatgpt"], required: true },
  email: { type: String, required: true, lowercase: true },
  displayName: { type: String, default: "" },
  tenantId: { type: String, default: null },
  discoveredAt: { type: Date, default: Date.now },
});

cloudMemberSchema.index({ source: 1, email: 1 }, { unique: true });

export default mongoose.model("CloudMember", cloudMemberSchema, "cloudMembers");
