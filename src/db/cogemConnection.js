import mongoose from "mongoose";

let isConnected = false;

/**
 * Build the cogem URI from MONGO_HOST + C2G_DB, falling back to legacy MONGO_URI_COGEM / MONGO_URI.
 */
function buildCogemUri() {
  // Preferred: MONGO_HOST (base URI, no db name) + C2G_DB
  if (process.env.MONGO_HOST) {
    const base = process.env.MONGO_HOST.replace(/\/[^/?]+(\?|$)/, '$1');
    const dbName = process.env.C2G_DB || 'cogem';
    return `${base}/${dbName}?authSource=admin`;
  }
  // Legacy fallbacks
  return process.env.MONGO_URI_COGEM || process.env.MONGO_URI || process.env.MONGODB_URI;
}

export async function connectDB() {
  if (isConnected) return;

  const uri = buildCogemUri();
  if (!uri) {
    console.warn("[MongoDB] MONGO_HOST / MONGO_URI not set — running without cogem database persistence");
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
