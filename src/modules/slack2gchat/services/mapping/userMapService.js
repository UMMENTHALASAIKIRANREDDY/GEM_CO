import { getS2GDb } from '../../db/ensureCollections.js';

export async function saveUserMap(batchId, users) {
  const db = getS2GDb();
  if (!users.length) return;
  const ops = users.map(u => ({
    updateOne: {
      filter: { batchId, slackUserId: u.slackUserId },
      update: { $set: { batchId, ...u } },
      upsert: true,
    },
  }));
  await db.collection('userMap').bulkWrite(ops, { ordered: false });
}

export async function getUserMap(batchId) {
  const db = getS2GDb();
  return db.collection('userMap').find({ batchId }).toArray();
}

export async function updateUserMapping(batchId, slackUserId, googleEmail) {
  const db = getS2GDb();
  await db.collection('userMap').updateOne(
    { batchId, slackUserId },
    { $set: { googleEmail, matchMethod: 'manual', verified: true } }
  );
}

export async function applyBulkMapping(batchId, mappingObj) {
  // mappingObj: { slackEmail/slackUserId → googleEmail }
  const db = getS2GDb();
  const users = await db.collection('userMap').find({ batchId }).toArray();
  const ops = [];
  for (const u of users) {
    const key = (u.slackEmail || u.slackUserId || '').toLowerCase();
    const googleEmail = mappingObj[key] || mappingObj[u.slackUserId];
    if (googleEmail) {
      ops.push({
        updateOne: {
          filter: { batchId, slackUserId: u.slackUserId },
          update: { $set: { googleEmail, matchMethod: 'csv', verified: true } },
        },
      });
    }
  }
  if (ops.length) await db.collection('userMap').bulkWrite(ops, { ordered: false });
  return ops.length;
}

// Returns Map<slackUserId, googleEmail> for fast lookup during migration
export async function getUserMapLookup(batchId) {
  const users = await getUserMap(batchId);
  const lookup = new Map();
  for (const u of users) {
    if (u.googleEmail) lookup.set(u.slackUserId, u.googleEmail);
  }
  return lookup;
}
