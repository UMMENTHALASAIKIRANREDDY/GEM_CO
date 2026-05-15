/**
 * One-shot script: deploy/update the Gemini Conversation Agent to the filefuze.co
 * Teams catalog using the active MS session.
 *
 * Run: node --env-file=.env deploy-gemini-agent-test.js
 */

import { connectMongo, getDb } from './src/db/mongo.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';
import { restoreMsSessions } from './src/core/auth/microsoft.js';

const APP_USER_ID  = '69d651fb1fb027942f3a9d73'; // erik@filefuze.co
const ACCOUNT_ID   = 'bb673537-3f00-4624-99c9-0700562c8861'; // erik@filefuze.co accountId
const TENANT_ID    = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // filefuze.co
const CUSTOMER     = 'FileFuze';
// Canonical catalog entry — use 1b46ecb3 (most recent) with its externalId as appId
const CATALOG_ID   = '1b46ecb3-be8f-4587-b80d-ed1ec204cae7';
const EXTERNAL_ID  = '06104ef7-ca2e-49f3-8ff4-e5e07cefd5b0'; // must match manifest id field

await connectMongo();
const db = getDb();
await restoreMsSessions();

const deployer = new AgentDeployer(CUSTOMER, TENANT_ID, {
  agentName:    'Gemini Conversation Agent',
  sourceLabel:  'Gemini',
  notebookName: `${CUSTOMER} Conversations`,
  sectionName:  `${CUSTOMER} Conversations`,
  appId:        EXTERNAL_ID,
}, APP_USER_ID, ACCOUNT_ID);

console.log(`Force-updating Gemini agent (catalogId=${CATALOG_ID}) to v1.2.0…`);
const result = await deployer.updateAgent(CATALOG_ID);
if (!result.updated) {
  console.log('Update failed — check logs above');
  process.exit(1);
}

await db.collection('agentDeployments').updateOne(
  { tenantId: TENANT_ID, agentName: 'Gemini Conversation Agent' },
  { $set: { catalogId: CATALOG_ID, appId: EXTERNAL_ID, updatedAt: new Date(), msEmail: 'erik@filefuze.co' } },
  { upsert: true },
);
console.log('Deployment record updated.');

console.log('\n--- Result ---');
console.log(JSON.stringify(result, null, 2));

process.exit(0);
