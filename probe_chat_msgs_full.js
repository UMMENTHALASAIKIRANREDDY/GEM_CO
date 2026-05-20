/**
 * Dump full Teams chat messages for a Copilot session, specifically looking
 * for hostedContents references that point at user-uploaded inline images.
 */
import 'dotenv/config';
import { getTenantAccessToken } from './src/modules/c2c/multiTenantAuth.js';

const SOURCE_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const SESSION_ID = process.argv[2] || '19:xa3R0InCz8L3tCn9EgOsy58cfZFX-YzkAqiDeIPXAy01@thread.v2';

const t = await getTenantAccessToken(SOURCE_TENANT);

// Page through ALL messages
let url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(SESSION_ID)}/messages?$top=50`;
const all = [];
while (url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
  const j = await r.json();
  all.push(...(j.value || []));
  url = j['@odata.nextLink'] || null;
}
console.log(`Total messages: ${all.length}\n`);

// Recursively walk each msg looking for hostedContents refs OR image URLs
function findImages(msg) {
  const hits = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      // <img src=... in HTML body
      const m1 = [...node.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
      for (const x of m1) hits.push({ kind: 'img-src', path, url: x[1].slice(0, 200) });
      // hostedContents url
      const m2 = [...node.matchAll(/(https:\/\/graph\.microsoft\.com\/[^"' )<>]+hostedContents[^"' )<>]+)/gi)];
      for (const x of m2) hits.push({ kind: 'hostedContents', path, url: x[1] });
    } else if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k);
    }
  };
  walk(msg, '');
  return hits;
}

// Dump every USER message in full (these are where uploaded images would appear)
for (const msg of all) {
  const fromUser = msg.from?.user;
  if (!fromUser) continue;
  console.log('━'.repeat(80));
  console.log(`USER msg=${msg.id}  ${msg.createdDateTime}  from=${fromUser.displayName}`);
  console.log(JSON.stringify(msg, null, 2));
}
process.exit(0);
