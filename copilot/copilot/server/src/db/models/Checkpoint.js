import mongoose from "mongoose";

const checkpointSchema = new mongoose.Schema({
  batchId: { type: String, required: true, unique: true },
  completedUsers: { type: [String], default: [] },
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.model("Checkpoint", checkpointSchema, "checkpoints");
