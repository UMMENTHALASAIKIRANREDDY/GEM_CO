import mongoose from "mongoose";

let isConnected = false;

export async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[MongoDB] MONGO_URI not set — running without database persistence");
    return;
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
    isConnected = true;
    const dbName = mongoose.connection.db.databaseName;
    console.log(`[MongoDB] Connected to database: ${dbName}`);
  } catch (err) {
    console.error(`[MongoDB] Connection failed: ${err.message}`);
    throw err;
  }
}

export function isDBConnected() {
  return isConnected;
}
