/**
 * One-shot script: deploy the Claude Conversation Agent to the filefuze.co
 * Teams catalog using Dave QA's active MS session.
 *
 * Run: node --env-file=.env deploy-agent-test.js
 */

import { connectMongo, getDb } from './src/db/mongo.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';
import { restoreMsSessions } from './src/core/auth/microsoft.js';

const APP_USER_ID  = '69d651fb1fb027942f3a9d75'; // erik@filefuze.co
const ACCOUNT_ID   = '50d89c86-08b9-49cd-87d4-c02fe562c391'; // erik@filefuze.co accountId
const TENANT_ID   = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // filefuze.co
const CUSTOMER    = 'FileFuze';

await connectMongo();
const db = getDb();
await restoreMsSessions(); // loads MSAL cache from authSessions into memory

const KNOWN_CATALOG_ID = 'eb613bd7-b046-467c-bfcf-9356790a180e';
const EXTERNAL_ID      = '88486dc9-3491-4964-ad36-d7d827abbb43'; // must match manifest id

const deployer = new AgentDeployer(CUSTOMER, TENANT_ID, {
  agentName:    'Claude Conversation Agent',
  sourceLabel:  'Claude',
  notebookName: 'ClaudeChats',
  sectionName:  'ClaudeChats Conversations',
  appId:        EXTERNAL_ID,
}, APP_USER_ID, ACCOUNT_ID);

console.log(`Updating Claude agent (catalogId=${KNOWN_CATALOG_ID}) to v1.3.0…`);
const result = await deployer.updateAgent(KNOWN_CATALOG_ID);
if (!result.updated) { console.log('Update failed — check logs above'); process.exit(1); }

await db.collection('agentDeployments').updateOne(
  { tenantId: TENANT_ID, agentName: 'Claude Conversation Agent' },
  { $set: { catalogId: KNOWN_CATALOG_ID, appId: EXTERNAL_ID, updatedAt: new Date(), msEmail: 'erik@filefuze.co' } },
  { upsert: true },
);
console.log('Deployment record updated.');

console.log('\n--- Result ---');
console.log(JSON.stringify(result, null, 2));
console.log('\n--- Install Instructions ---');
console.log(result.installInstructions || 'See Teams App catalog for the agent.');

process.exit(0);
