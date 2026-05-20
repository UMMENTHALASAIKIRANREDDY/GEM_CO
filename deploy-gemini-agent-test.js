/**
 * One-shot script: deploy/update the Gemini Conversation Agent to the filefuze.co
 * Teams catalog using the active MS session.
 *
 * Run: node --env-file=.env deploy-gemini-agent-test.js
 */

import { connectMongo, getDb } from './src/db/mongo.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';
import { IndexWriter } from './src/agent/indexWriter.js';
import { restoreMsSessions } from './src/core/auth/microsoft.js';

const APP_USER_ID  = '69d651fb1fb027942f3a9d75'; // erik@filefuze.co
const ACCOUNT_ID   = '50d89c86-08b9-49cd-87d4-c02fe562c391'; // erik@filefuze.co accountId
const TENANT_ID    = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // filefuze.co
const CUSTOMER     = 'geminiiiiii'; // must match the actual migration folder name
// Canonical catalog entry — use 1b46ecb3 (most recent) with its externalId as appId
const CATALOG_ID   = 'b2db5c7d-c111-43d3-87ab-30106bff186e';
const EXTERNAL_ID  = '06104ef7-ca2e-49f3-8ff4-e5e07cefd5b0'; // must match manifest id field

await connectMongo();
const db = getDb();
await restoreMsSessions();

const deployer = new AgentDeployer(CUSTOMER, TENANT_ID, {
  agentName:    'Gemini Conversation Agent 1',
  sourceLabel:  'Gemini',
  notebookName: `${CUSTOMER} Conversations`,
  sectionName:  `${CUSTOMER} Conversations`,
  appId:        EXTERNAL_ID,
}, APP_USER_ID, ACCOUNT_ID);

// Try update first; if not found, publish fresh
console.log(`Updating Gemini agent (catalogId=${CATALOG_ID}) to v1.5.0…`);
let result = await deployer.updateAgent(CATALOG_ID);
let finalCatalogId = CATALOG_ID;

if (!result.updated) {
  console.log('Update failed — republishing fresh…');
  result = await deployer.deployAgent();
  finalCatalogId = result?.id || CATALOG_ID;
}

const TARGET_EMAIL = 'erik@filefuze.co';

if (finalCatalogId) {
  await db.collection('agentDeployments').updateOne(
    { tenantId: TENANT_ID, agentName: 'Gemini Conversation Agent 1' },
    { $set: { catalogId: finalCatalogId, appId: deployer.appId, updatedAt: new Date(), msEmail: TARGET_EMAIL } },
    { upsert: true },
  );
  console.log(`Deployment record updated (catalogId=${finalCatalogId}).`);

  // Write catalog ID to the user's GemCo/index.json so the Teams tab can deep-link to this agent
  const writer = new IndexWriter(APP_USER_ID, ACCOUNT_ID);
  await writer.writeAgentId(TARGET_EMAIL, finalCatalogId);
  console.log(`Written agentCatalogId to ${TARGET_EMAIL}'s OneDrive index.json`);
}

console.log('\n--- Result ---');
console.log(JSON.stringify(result, null, 2));

process.exit(0);
