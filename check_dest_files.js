/**
 * Diagnostic: list every file inside alex@gajha.com's "Migrated from Copilot"
 * folder, with size + webUrl, so we can confirm what's actually in OneDrive.
 */
import 'dotenv/config';
import { getTenantAccessToken } from './src/modules/c2c/multiTenantAuth.js';

const DEST_TENANT = '0de6d210-ac94-461d-a935-4f6c105239a4'; // gajha
const DEST_EMAIL = 'alex@gajha.com';
const FOLDER = 'Migrated from Copilot';

const t = await getTenantAccessToken(DEST_TENANT);

const u = await (await fetch(
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(DEST_EMAIL)}?$select=id`,
  { headers: { Authorization: 'Bearer ' + t } }
)).json();
console.log('User id:', u.id);

const folderRes = await (await fetch(
  `https://graph.microsoft.com/v1.0/users/${u.id}/drive/root:/${encodeURIComponent(FOLDER)}`,
  { headers: { Authorization: 'Bearer ' + t } }
)).json();
console.log('Folder id:', folderRes.id, 'webUrl:', folderRes.webUrl);

const itemsRes = await (await fetch(
  `https://graph.microsoft.com/v1.0/users/${u.id}/drive/items/${folderRes.id}/children?$top=200`,
  { headers: { Authorization: 'Bearer ' + t } }
)).json();

const items = itemsRes.value || [];
console.log(`\n=== ${items.length} files in "${FOLDER}" ===`);
items
  .sort((a, b) => a.name.localeCompare(b.name))
  .forEach(f => {
    console.log(`  ${f.name.padEnd(45)} ${String(f.size || 0).padStart(8)} bytes   ${f.lastModifiedDateTime}`);
  });

process.exit(0);
