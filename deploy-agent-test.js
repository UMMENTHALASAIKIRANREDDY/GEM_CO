/**
 * One-shot script: deploy the Claude Conversation Agent to the filefuze.co
 * Teams catalog using Dave QA's active MS session.
 *
 * Run: node --env-file=.env deploy-agent-test.js
 */

import { connectMongo, getDb } from './src/db/mongo.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';
import { restoreMsSessions } from './src/core/auth/microsoft.js';

const APP_USER_ID = '69d651fb1fb027942f3a9d73'; // active MS session (erik@filefuze.co)
const TENANT_ID   = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // filefuze.co
const CUSTOMER    = 'FileFuze';

await connectMongo();
const db = getDb();
await restoreMsSessions(); // loads MSAL cache from authSessions into memory

// Known catalog ID from previous deployment
const KNOWN_CATALOG_ID = 'eb613bd7-b046-467c-bfcf-9356790a180e';

const deployer = new AgentDeployer(CUSTOMER, TENANT_ID, {
  agentName:    'Claude Conversation Agent',
  sourceLabel:  'Claude',
  notebookName: 'ClaudeChats',
  sectionName:  'ClaudeChats Conversations',
  appId:        'your-app-guid', // will be overwritten if we read from DB
}, APP_USER_ID);

// Check DB for stored appId (to keep manifest GUID consistent)
const existing = await db.collection('agentDeployments').findOne({
  tenantId: TENANT_ID, agentName: 'Claude Conversation Agent',
});
if (existing?.appId) deployer.appId = existing.appId;

let result;
console.log(`Force-updating agent (catalogId=${KNOWN_CATALOG_ID}) to v1.1.0…`);
result = await deployer.updateAgent(KNOWN_CATALOG_ID);
if (!result.updated) {
  console.log('Update failed — check Graph API response above');
  process.exit(1);
}

// Upsert deployment record
await db.collection('agentDeployments').updateOne(
  { tenantId: TENANT_ID, agentName: 'Claude Conversation Agent' },
  { $set: { catalogId: KNOWN_CATALOG_ID, appId: deployer.appId, updatedAt: new Date(), msEmail: 'erik@filefuze.co' } },
  { upsert: true },
);
console.log('Deployment record updated.');

console.log('\n--- Result ---');
console.log(JSON.stringify(result, null, 2));
console.log('\n--- Install Instructions ---');
console.log(result.installInstructions || 'See Teams App catalog for the agent.');

process.exit(0);
