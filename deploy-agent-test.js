/**
 * One-shot script: deploy the Claude Conversation Agent to the filefuze.co
 * Teams catalog using Dave QA's active MS session.
 *
 * Run: node --env-file=.env deploy-agent-test.js
 */

import { connectMongo, getDb } from './src/db/mongo.js';
import { AgentDeployer } from './src/agent/agentDeployer.js';
import { restoreMsSessions } from './src/core/auth/microsoft.js';

const APP_USER_ID = '69f761943237ab4719b99ed8'; // Dave QA — has active MS session
const TENANT_ID   = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // filefuze.co
const CUSTOMER    = 'FileFuze';

await connectMongo();
const db = getDb();
await restoreMsSessions(); // loads MSAL cache from authSessions into memory

// Check for existing deployment so we update instead of duplicate-publish
const existing = await db.collection('agentDeployments').findOne({
  appUserId: APP_USER_ID, tenantId: TENANT_ID, agentName: 'Claude Conversation Agent',
});

const deployer = new AgentDeployer(CUSTOMER, TENANT_ID, {
  agentName:    'Claude Conversation Agent',
  sourceLabel:  'Claude',
  notebookName: 'ClaudeChats',
  sectionName:  'ClaudeChats Conversations',
}, APP_USER_ID);

let result;
if (existing?.catalogId) {
  console.log(`Updating agent (catalogId=${existing.catalogId}) to v1.1.0…`);
  result = await deployer.updateAgent(existing.catalogId);
  if (!result.updated) {
    console.log('Update failed, falling back to fresh publish…');
    result = await deployer.deployAgent();
  }
} else {
  console.log('No existing deployment — publishing new agent…');
  result = await deployer.deployAgent();
}

if (result.alreadyExisted) {
  console.log('Agent was already in catalog (no changes needed).');
} else {
  // Upsert deployment record
  await db.collection('agentDeployments').updateOne(
    { appUserId: APP_USER_ID, tenantId: TENANT_ID, agentName: 'Claude Conversation Agent' },
    { $set: { catalogId: result.id, appId: deployer.appId, deployedAt: new Date(), msEmail: 'erik@filefuze.co' } },
    { upsert: true },
  );
  console.log('Deployment record saved.');
}

console.log('\n--- Result ---');
console.log(JSON.stringify(result, null, 2));
console.log('\n--- Install Instructions ---');
console.log(result.installInstructions || 'See Teams App catalog for the agent.');

process.exit(0);
