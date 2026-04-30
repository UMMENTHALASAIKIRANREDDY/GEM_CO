/**
 * Unified DB factory — one MongoDB client per database name.
 * Usage:
 *   import { connectDb, getDb } from './src/core/db.js';
 *   await connectDb('gemco');   // connects + caches
 *   const db = getDb('gemco'); // returns cached Db instance
 */

import { MongoClient } from 'mongodb';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('db:core');

/** @type {Map<string, { client: MongoClient, db: import('mongodb').Db }>} */
const connections = new Map();

/**
 * Parse the base URI (no db-name appended) from MONGO_HOST env var.
 * Falls back to constructing from MONGO_USERNAME / MONGO_PASSWORD if MONGO_HOST
 * is not set (backward-compat).
 */
function stripDbFromUri(raw) {
  // Find path start: first '/' after the authority section (after '://')
  const afterScheme = raw.indexOf('://');
  if (afterScheme === -1) return raw;
  const pathStart = raw.indexOf('/', afterScheme + 3);
  if (pathStart === -1) return raw; // no /dbname present, return as-is
  const queryStart = raw.indexOf('?', pathStart);
  return raw.substring(0, pathStart);
}

function buildBaseUri() {
  if (process.env.MONGO_HOST) return stripDbFromUri(process.env.MONGO_HOST);
  const legacy = process.env.MONGO_URI;
  if (legacy) return stripDbFromUri(legacy);
  throw new Error('MONGO_HOST (or legacy MONGO_URI) not set in .env');
}

/**
 * Connect to the given database and cache the connection.
 * Safe to call multiple times for the same dbName.
 *
 * @param {string} dbName  e.g. 'gemco' or 'cogem'
 * @param {number} [retries=5]
 * @param {number} [delayMs=3000]
 */
export async function connectDb(dbName, retries = 5, delayMs = 3000) {
  if (connections.has(dbName)) return; // already connected

  const baseUri = buildBaseUri();
  const uri = `${baseUri}/${dbName}?authSource=admin`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 0,       // no socket timeout — let the OS handle it
        maxPoolSize: 10,
        retryWrites: true,        // auto-retry write ops on transient network errors
        retryReads: true,
      });
      await client.connect();
      const db = client.db(dbName);
      connections.set(dbName, { client, db });
      logger.info(`MongoDB connected → ${dbName}`);
      return;
    } catch (err) {
      logger.warn(`MongoDB connect attempt ${attempt}/${retries} for "${dbName}" failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/**
 * Return a cached Db instance.
 * Throws if connectDb() was not called for this dbName yet.
 *
 * @param {string} dbName
 * @returns {import('mongodb').Db}
 */
export function getDb(dbName) {
  const conn = connections.get(dbName);
  if (!conn) throw new Error(`DB "${dbName}" not connected — call connectDb('${dbName}') first`);
  return conn.db;
}
