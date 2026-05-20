/**
 * Try the Teams chat messages API for a Copilot session. The sessionId we
 * already have is a Teams thread ID (19:...@thread.v2), so /chats/{id}/messages
 * may return the same Copilot content WITH inline image references via the
 * hostedContents endpoint. Tests both app-only and ChannelMessage scopes.
 */
import 'dotenv/config';
import { getTenantAccessToken } from './src/modules/c2c/multiTenantAuth.js';

const SOURCE_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const USER_EMAIL = process.argv[2] || 'alex@filefuze.co';
const SESSION_ID = process.argv[3] || '19:xa3R0InCz8L3tCn9EgOsy58cfZFX-YzkAqiDeIPXAy01@thread.v2';

const t = await getTenantAccessToken(SOURCE_TENANT);
const u = await (await fetch(
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(USER_EMAIL)}?$select=id`,
  { headers: { Authorization: 'Bearer ' + t } }
)).json();
console.log(`User: ${u.id}`);
console.log(`Session: ${SESSION_ID}\n`);

// Try 1: GET the chat (does Copilot chat appear as a Teams chat?)
console.log('=== /chats/{sessionId} ===');
const chatRes = await fetch(
  `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(SESSION_ID)}`,
  { headers: { Authorization: 'Bearer ' + t } }
);
console.log('  status:', chatRes.status);
const chatBody = await chatRes.text();
console.log('  body:', chatBody.slice(0, 400));

// Try 2: GET the chat messages
console.log('\n=== /chats/{sessionId}/messages ===');
const msgRes = await fetch(
  `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(SESSION_ID)}/messages?$top=5`,
  { headers: { Authorization: 'Bearer ' + t } }
);
console.log('  status:', msgRes.status);
const msgBody = await msgRes.text();
console.log('  body (first 1500):', msgBody.slice(0, 1500));

// Try 3: getAllMessages across the user's Teams chats (admin scope)
console.log('\n=== /users/{id}/chats/getAllMessages (admin) ===');
const allRes = await fetch(
  `https://graph.microsoft.com/v1.0/users/${u.id}/chats/getAllMessages?$top=5`,
  { headers: { Authorization: 'Bearer ' + t } }
);
console.log('  status:', allRes.status);
const allBody = await allRes.text();
console.log('  body (first 1500):', allBody.slice(0, 1500));

process.exit(0);
