/**
 * PHASE 1 PoC — Extract Python source from a Copilot Analysis interaction
 * and run it locally to confirm we can regenerate the file outputs.
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getTenantAccessToken } from './src/modules/c2c/multiTenantAuth.js';

const INTERACTION_ID = '1779176596685'; // the multi-file generator from this morning

const t = await getTenantAccessToken('807d6772-847c-40e2-9bec-e2c930b3a42e');
const userId = (await (await fetch('https://graph.microsoft.com/v1.0/users/erik@filefuze.co?$select=id', {
  headers: { Authorization: 'Bearer ' + t }
})).json()).id;

const filter = encodeURIComponent("(appClass eq 'IPM.SkypeTeams.Message.Copilot.BizChat' or appClass eq 'IPM.SkypeTeams.Message.Copilot.WebChat')");
const r = await fetch(`https://graph.microsoft.com/v1.0/copilot/users/${userId}/interactionHistory/getAllEnterpriseInteractions?%24top=999&%24filter=${filter}`, {
  headers: { Authorization: 'Bearer ' + t }
});
const items = ((await r.json()).value || []);
const item = items.find(i => i.id === INTERACTION_ID);
if (!item) { console.error('Interaction not found'); process.exit(1); }

console.log('Found interaction:', item.id, 'at', item.createdDateTime);
console.log('Session:', item.sessionId);

// Walk adaptive card → extract Python code
function findPythonInCard(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  // TextRun.text often holds the raw Python
  if ((node.type === 'TextRun' || node.type === 'TextBlock') && typeof node.text === 'string') {
    const txt = node.text;
    if (/(\bimport\b|\bdef\b|\bfrom\b\s+\w+\s+import|Path\(|with\s+open\(|\.write_text\(|\.to_csv\(|\.to_excel\()/.test(txt)) {
      out.push(txt);
    }
  }
  for (const k of ['body', 'items', 'columns', 'actions', 'inlines', 'facts']) {
    if (Array.isArray(node[k])) for (const child of node[k]) findPythonInCard(child, out);
  }
  return out;
}

const codeBlocks = [];
for (const att of (item.attachments||[])) {
  if (att.contentType !== 'application/vnd.microsoft.card.adaptive' || !att.content) continue;
  const card = typeof att.content === 'string' ? JSON.parse(att.content) : att.content;
  findPythonInCard(card, codeBlocks);
}

console.log(`\nExtracted ${codeBlocks.length} code block(s):`);
codeBlocks.forEach((c, i) => console.log(`  [${i}] length=${c.length}, starts: ${c.split('\n')[0].slice(0, 80)}`));

// Combine the largest code block as our candidate
if (codeBlocks.length === 0) { console.error('No Python code found in this interaction.'); process.exit(1); }
const code = codeBlocks.sort((a,b) => b.length - a.length)[0];

// Patch: replace /mnt/data with a local sandbox dir
const sandbox = path.resolve('./poc_sandbox');
if (fs.existsSync(sandbox)) fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
const patched = code.replace(/\/mnt\/data/g, sandbox.replace(/\\/g, '/'));

const scriptPath = path.join(sandbox, '_copilot_code.py');
fs.writeFileSync(scriptPath, patched);
console.log(`\nWrote ${patched.length} bytes of code to ${scriptPath}`);
console.log('Running with local Python...\n');

const start = Date.now();
const proc = spawnSync('python', [scriptPath], { cwd: sandbox, encoding: 'utf8', timeout: 60_000 });
const dur = Date.now() - start;
console.log(`Exit code: ${proc.status} (${dur}ms)`);
if (proc.stdout) console.log('--- STDOUT ---\n' + proc.stdout);
if (proc.stderr) console.log('--- STDERR ---\n' + proc.stderr);

console.log('\n--- Generated files in sandbox ---');
function walk(dir, prefix = '') {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === '_copilot_code.py') continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      console.log(`  ${prefix}${f.name}/`);
      walk(full, prefix + '  ');
    } else {
      const sz = fs.statSync(full).size;
      console.log(`  ${prefix}${f.name}  (${sz} bytes)`);
    }
  }
}
walk(sandbox);

process.exit(0);
