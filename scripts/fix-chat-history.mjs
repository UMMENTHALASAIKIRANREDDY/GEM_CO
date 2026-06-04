import { connectMongo, getDb } from '../src/db/mongo.js';

await connectMongo();
const db = getDb();

const dupes = await db.collection('chatHistory').aggregate([
  { $group: { _id: '$appUserId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
]).toArray();

for (const d of dupes) {
  const [, ...toDelete] = d.ids;
  await db.collection('chatHistory').deleteMany({ _id: { $in: toDelete } });
}

console.log(`Cleaned ${dupes.length} duplicate chatHistory doc(s)`);

try {
  await db.collection('chatHistory').createIndex({ appUserId: 1 }, { unique: true });
  console.log('chatHistory unique index created');
} catch (e) {
  console.log('Index already exists or error:', e.message);
}

process.exit(0);
