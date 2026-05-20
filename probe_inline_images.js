/**
 * Diagnostic: find ALL `data:` URLs across every recent Copilot interaction
 * for a given user. Dumps where (which field path) each one was found so we
 * can teach extractAttachments to walk that field.
 */
import 'dotenv/config';
import { getTenantAccessToken } from './src/modules/c2c/multiTenantAuth.js';

const SOURCE_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e'; // filefuze
const USER_EMAIL = process.argv[2] || 'alex@filefuze.co';

const t = await getTenantAccessToken(SOURCE_TENANT);

const u = await (await fetch(
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(USER_EMAIL)}?$select=id,displayName`,
  { headers: { Authorization: 'Bearer ' + t } }
)).json();
console.log(`User: ${u.displayName} (${u.id})`);

const filter = encodeURIComponent(
  "(appClass eq 'IPM.SkypeTeams.Message.Copilot.BizChat' or appClass eq 'IPM.SkypeTeams.Message.Copilot.WebChat')"
);
const r = await fetch(
  `https://graph.microsoft.com/v1.0/copilot/users/${u.id}/interactionHistory/getAllEnterpriseInteractions?%24top=200&%24filter=${filter}`,
  { headers: { Authorization: 'Bearer ' + t } }
);
const items = ((await r.json()).value || []);
console.log(`Found ${items.length} interactions\n`);

// Recursively walk; collect every (path, dataUrlPrefix) we find
function walk(node, path, hits) {
  if (typeof node === 'string') {
    const re = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]{20,40})/gi;
    let m;
    while ((m = re.exec(node)) !== null) {
      hits.push({ path, mime: m[1], prefix: m[2].slice(0, 30) + '...' });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((x, i) => walk(x, `${path}[${i}]`, hits));
    return;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k, hits);
  }
}

let total = 0;
for (const item of items) {
  const hits = [];
  walk(item, '', hits);
  if (hits.length === 0) continue;
  total += hits.length;
  console.log(`\n=== ${item.id}  ${item.createdDateTime}  session=${item.sessionId?.slice(0, 30)} ===`);
  console.log(`     interactionType=${item.interactionType}  appClass=${item.appClass}`);
  for (const h of hits) {
    console.log(`     path: ${h.path}`);
    console.log(`           mime=${h.mime}  bytes=${h.prefix}`);
  }
}

console.log(`\nTotal data: URL hits across all interactions: ${total}`);
process.exit(0);
