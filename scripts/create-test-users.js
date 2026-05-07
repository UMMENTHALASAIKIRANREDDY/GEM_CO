// Run: node scripts/create-test-users.js
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';

dotenv.config();

const USERS = [
  { name: 'Alice Tester',   email: 'alice@test.com',   password: 'Test@1234', role: 'admin' },
  { name: 'Bob Reviewer',   email: 'bob@test.com',     password: 'Test@1234', role: 'user'  },
  { name: 'Carol Demo',     email: 'carol@test.com',   password: 'Test@1234', role: 'user'  },
  { name: 'Dave QA',        email: 'dave@test.com',    password: 'Test@1234', role: 'user'  },
  { name: 'Eve Staging',    email: 'eve@test.com',     password: 'Test@1234', role: 'user'  },
];

function buildUri() {
  const raw = process.env.MONGO_HOST || process.env.MONGO_URI;
  if (!raw) throw new Error('MONGO_HOST not set in .env');
  const afterScheme = raw.indexOf('://');
  const pathStart = raw.indexOf('/', afterScheme + 3);
  const base = pathStart === -1 ? raw : raw.substring(0, pathStart);
  return `${base}/gemco?authSource=admin`;
}

const client = new MongoClient(buildUri());
await client.connect();
const db = client.db('gemco');
const col = db.collection('appUsers');

let created = 0, skipped = 0;
for (const u of USERS) {
  const exists = await col.findOne({ email: u.email });
  if (exists) { console.log(`SKIP  ${u.email} (already exists)`); skipped++; continue; }
  const hash = await bcrypt.hash(u.password, 10);
  await col.insertOne({ name: u.name, email: u.email, password: hash, role: u.role, createdAt: new Date() });
  console.log(`OK    ${u.email}`);
  created++;
}

console.log(`\nDone — ${created} created, ${skipped} skipped`);
await client.close();
