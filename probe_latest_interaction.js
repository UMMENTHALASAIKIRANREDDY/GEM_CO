/**
 * Dump full structure of the most recent N interactions for a user.
 * Used to find where Microsoft stores user-uploaded screenshot references.
 */
import 'dotenv/config';
import { getTenantAccessToken } from './src/modules/c2c/multiTenantAuth.js';

const SOURCE_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const USER_EMAIL = process.argv[2] || 'alex@filefuze.co';
const N = parseInt(process.argv[3] || '3', 10);

const t = await getTenantAccessToken(SOURCE_TENANT);
const u = await (await fetch(
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(USER_EMAIL)}?$select=id`,
  { headers: { Authorization: 'Bearer ' + t } }
)).json();

const filter = encodeURIComponent(
  "(appClass eq 'IPM.SkypeTeams.Message.Copilot.BizChat' or appClass eq 'IPM.SkypeTeams.Message.Copilot.WebChat')"
);
const r = await fetch(
  `https://graph.microsoft.com/v1.0/copilot/users/${u.id}/interactionHistory/getAllEnterpriseInteractions?%24top=200&%24filter=${filter}`,
  { headers: { Authorization: 'Bearer ' + t } }
);
const items = ((await r.json()).value || []);
items.sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));

console.log(`Total: ${items.length}. Showing top ${N}:\n`);
for (const item of items.slice(0, N)) {
  console.log('━'.repeat(80));
  console.log(`id=${item.id}  ${item.createdDateTime}  type=${item.interactionType}`);
  console.log(`session=${item.sessionId}`);
  console.log(`body.contentType=${item.body?.contentType}  body.content (first 400 chars):`);
  console.log(item.body?.content?.slice(0, 400));
  console.log('\nattachments:');
  console.log(JSON.stringify(item.attachments, null, 2)?.slice(0, 2000));
  console.log('\ncontexts:');
  console.log(JSON.stringify(item.contexts, null, 2)?.slice(0, 1000));
  console.log('\nlinks:');
  console.log(JSON.stringify(item.links, null, 2)?.slice(0, 500));
}
process.exit(0);
