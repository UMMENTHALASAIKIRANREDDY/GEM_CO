/**
 * One-shot script: deploy CloudFuze Migration History tab app to filefuze.co Teams catalog.
 * Run: node --env-file=.env deploy-tab-test.js
 *
 * For Teams testing, tab URL must be HTTPS. Options:
 *   - Set TAB_URL env var to an ngrok URL: TAB_URL=https://abc.ngrok.io/tab.html node --env-file=.env deploy-tab-test.js
 *   - Or test tab.html directly in browser: http://localhost:4000/tab.html
 */
import { connectMongo, getDb } from './src/db/mongo.js';
import { TabDeployer } from './src/agent/tabDeployer.js';
import { restoreMsSessions } from './src/core/auth/microsoft.js';

const APP_USER_ID = '69d651fb1fb027942f3a9d75'; // erik@filefuze.co
const ACCOUNT_ID  = '50d89c86-08b9-49cd-87d4-c02fe562c391';
const TENANT_ID   = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const TAB_URL     = process.env.TAB_URL || 'http://localhost:4000/tab.html';

await connectMongo();
const db = getDb();
await restoreMsSessions();

const existing = await db.collection('agentDeployments').findOne({
  tenantId: TENANT_ID, agentName: 'CloudFuze Migration History',
});

const deployer = new TabDeployer(TENANT_ID, {
  tabUrl: TAB_URL,
  appId: existing?.appId || undefined,
}, APP_USER_ID, ACCOUNT_ID);

let result;
if (existing?.catalogId) {
  console.log(`Updating tab app (catalogId=${existing.catalogId})...`);
  result = await deployer.updateTab(existing.catalogId);
  if (!result.updated) {
    console.log('Update failed — republishing fresh...');
    result = await deployer.deployTab();
  } else {
    result.id = existing.catalogId;
  }
} else {
  console.log('Deploying tab app fresh...');
  result = await deployer.deployTab();
}

if (result.id) {
  await db.collection('agentDeployments').updateOne(
    { tenantId: TENANT_ID, agentName: 'CloudFuze Migration History' },
    { $set: { catalogId: result.id, appId: deployer.appId, updatedAt: new Date(), msEmail: 'erik@filefuze.co' } },
    { upsert: true }
  );
  console.log(`Deployment record saved (catalogId=${result.id}).`);
}

console.log('\n--- Result ---');
console.log(JSON.stringify(result, null, 2));
console.log(`\nTab URL: ${TAB_URL}`);
console.log('\nInstall: Teams → Apps → Built for your org → "CloudFuze Migration History" → Add');
process.exit(0);
