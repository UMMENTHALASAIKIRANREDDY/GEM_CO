/**
 * Inspect the most recent G2G migration:
 *  - Mongo state (status, totals, errors)
 *  - Per-file source classification in destination Drive (Drive copy vs regen)
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { MongoClient } from 'mongodb';
import { getServiceAccountAuth } from './src/modules/c2g/googleService.js';

const mongoUri = process.env.MONGO_URI || process.env.MONGO_HOST || 'mongodb://localhost:27017';
const client = new MongoClient(mongoUri);
await client.connect();
const db = client.db(process.env.MONGO_DATABASE || 'gemco');

const all = await db.collection('migrationWorkspaces')
  .find({ _id: { $regex: '^g2g_' } })
  .sort({ _id: -1 }).limit(5).toArray();
console.log(`Most recent 5 G2G batches:`);
for (const b of all) {
  console.log(`  ${b._id}  status=${b.status}  files=${b.filesUploaded || 0}  errors=${(b.errors||[]).length}`);
}
console.log('');
const latest = all.slice(0, 1);
if (latest.length === 0) {
  console.log('No G2G batches found');
  process.exit(0);
}
const batch = latest[0];
console.log(`Batch: ${batch._id}`);
console.log(`Status: ${batch.status}`);
console.log(`Started: ${batch.requestedAt || batch.createdAt}`);
console.log(`Last updated: ${batch.lastUpdatedAt || batch.completedAt || '(in progress)'}`);
console.log(`Users: ${batch.users?.length || 0}`);
console.log(`Files uploaded: ${batch.filesUploaded || 0}`);
console.log(`Conversations: ${batch.conversationsCount || 0}`);
console.log(`Errors: ${(batch.errors || []).length}`);
if (batch.errors && batch.errors.length > 0) {
  for (const e of batch.errors.slice(0, 5)) console.log(`  - ${typeof e === 'string' ? e : JSON.stringify(e).slice(0, 200)}`);
}
console.log('');

// Now query the destination Drive for the latest "Migrated from Copilot" / "Gemini Conversations"
// folder to see what's in there.
const destEmail = batch.users?.[0]?.destEmail || process.argv[2];
if (!destEmail) {
  console.log('No dest email found. Pass as argv[2] to inspect Drive.');
  process.exit(0);
}
console.log(`Destination user: ${destEmail}\n`);

const auth = getServiceAccountAuth(destEmail);
const drive = google.drive({ version: 'v3', auth });

// Find the LATEST folder created in mia's Drive that's likely from G2G
// (Gemini Conversations / Migrated from Copilot / Copilot Conversations / etc.)
const folders = (await drive.files.list({
  q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
  fields: 'files(id, name, createdTime, webViewLink, parents)',
  orderBy: 'createdTime desc',
  pageSize: 15,
})).data.files;
console.log(`Most recent 15 folders in mia's Drive:`);
for (const f of folders) {
  console.log(`  ${f.createdTime}  ${f.name.padEnd(45)}  ${f.id}`);
}
console.log('');
if (!folders.length) {
  console.log('No "Migrated from Copilot" folder found in dest Drive');
  process.exit(0);
}
const folder = folders[0];
console.log(`Folder: ${folder.name}  id=${folder.id}  created=${folder.createdTime}`);
console.log(`URL:    ${folder.webViewLink}\n`);

const items = [];
let pageToken = null;
do {
  const res = await drive.files.list({
    q: `'${folder.id}' in parents and trashed=false`,
    fields: 'nextPageToken, files(name, size, createdTime, mimeType, description)',
    orderBy: 'createdTime asc',
    pageSize: 1000,
    pageToken,
  });
  items.push(...(res.data.files || []));
  pageToken = res.data.nextPageToken;
} while (pageToken);

console.log(`${items.length} files in destination folder:\n`);
for (const f of items) {
  const sz = (f.size || '0').padStart(10);
  console.log(`  ${f.name.padEnd(45)} ${sz} bytes   ${f.createdTime}`);
}
await client.close();
process.exit(0);
