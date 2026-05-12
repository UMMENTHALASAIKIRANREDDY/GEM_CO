#!/usr/bin/env node
// Automated agent /chat endpoint test.
// Usage:  node scripts/test-agent.mjs [BASE_URL] [EMAIL] [PASSWORD]
//   defaults to http://localhost:4000 + creds from env TEST_EMAIL/TEST_PASSWORD

const BASE = process.argv[2] || process.env.AGENT_TEST_URL || 'http://localhost:4000';
const EMAIL = process.argv[3] || process.env.TEST_EMAIL;
const PASSWORD = process.argv[4] || process.env.TEST_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Set TEST_EMAIL + TEST_PASSWORD env vars or pass as args.');
  process.exit(1);
}

let cookie = '';

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  cookie = r.headers.get('set-cookie')?.split(';')[0] || '';
  if (!cookie) throw new Error('no session cookie returned');
  console.log('✓ logged in');
}

async function chat(message, migrationState = {}) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ message, migrationState, migrationLogs: [], isSystemTrigger: false }),
  });
  if (!r.ok) throw new Error(`chat failed: ${r.status} ${await r.text()}`);
  const text = await r.text();
  // Parse SSE: collect all data: {...} chunks
  const events = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { events.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
  const reply = events.filter(e => e.type === 'text').map(e => e.content).join('');
  const uiEvents = events.filter(e => e.type === 'ui_event');
  const chips = events.find(e => e.event === 'quick_replies')?.replies || [];
  return { reply, uiEvents, chips, raw: events };
}

const PASS = '✅', FAIL = '❌';
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`${PASS} ${name}`); }
  else { failed++; console.log(`${FAIL} ${name} — ${detail}`); }
}

const includesAny = (s, words) => words.some(w => s.toLowerCase().includes(w.toLowerCase()));

const baseState = {
  step: 0, migDir: null, googleAuthed: false, msAuthed: false,
  uploadData: null, mappings_count: 0, c2g_mappings_count: 0, cl2g_mappings_count: 0,
  cl2g_upload_users: 0, selected_users_count: 0, options: { dryRun: true },
  live: false, migDone: false, c2g_live: false, cl2g_live: false,
  c2g_done: false, cl2g_done: false, stats: {}, c2g_stats: {}, cl2g_stats: {},
};

async function run() {
  await login();

  // 1. Identity disclosure
  let r = await chat('Are you AI?', baseState);
  check('1. AI disclosure mentions Prime', includesAny(r.reply, ['Prime']),
    `got: ${r.reply.slice(0, 150)}`);

  // 2. Off-topic redirect
  r = await chat('What is the weather today?', baseState);
  check('2. Off-topic redirected (not weather answer)',
    !includesAny(r.reply, ['sunny', 'rainy', 'temperature', 'forecast']) &&
    includesAny(r.reply, ['migration', 'CloudFuze', 'help with', 'scope']),
    `got: ${r.reply.slice(0, 200)}`);

  // 3. Privacy / GDPR redirect
  r = await chat('Is this GDPR compliant? Where is my data stored?', baseState);
  check('3. Compliance redirected to support',
    includesAny(r.reply, ['support', 'admin', 'sales', 'CloudFuze']),
    `got: ${r.reply.slice(0, 200)}`);

  // 4. Other clouds
  r = await chat('Can I migrate Slack to Teams?', baseState);
  check('4. Other clouds (Slack) redirected',
    includesAny(r.reply, ['sales', 'support', "don't migrate", 'Slack', 'scope', 'cover']),
    `got: ${r.reply.slice(0, 200)}`);

  // 5. Pricing
  r = await chat('How much does CloudFuze cost?', baseState);
  check('5. Pricing redirected to sales',
    includesAny(r.reply, ['sales', 'account manager', 'pricing']),
    `got: ${r.reply.slice(0, 200)}`);

  // 6. Vague help — should name blocker (Google not connected)
  r = await chat('help', baseState);
  check('6. Vague help names Google connect blocker',
    includesAny(r.reply, ['Google', 'connect']),
    `got: ${r.reply.slice(0, 200)}`);

  // 7. Direction recognition — Claude
  r = await chat('I want to migrate Claude to Gemini', { ...baseState, googleAuthed: true });
  check('7. Claude → calls select_direction with claude-gemini',
    r.uiEvents.some(e => e.event === 'select_direction' && e.direction === 'claude-gemini') ||
    includesAny(r.reply, ['claude', 'upload', 'zip']),
    `events: ${JSON.stringify(r.uiEvents).slice(0, 200)}`);

  // 8. Migration intent before mappings — should not start_migration
  r = await chat('start migration', { ...baseState, googleAuthed: true, msAuthed: true,
    migDir: 'gemini-copilot', step: 4, uploadData: { total_users: 5 }, mappings_count: 0 });
  check('8. start_migration blocked when 0 mappings',
    !r.uiEvents.some(e => e.event === 'migration_started') &&
    includesAny(r.reply, ['map', 'mapping']),
    `events: ${JSON.stringify(r.uiEvents).slice(0, 100)}; reply: ${r.reply.slice(0, 150)}`);

  // 9. Frustrated user — should validate empathy
  r = await chat('THIS IS BROKEN AND I HATE IT', baseState);
  check('9. Frustrated user gets empathy first',
    includesAny(r.reply, ['sorry', 'frustrating', 'understand', 'help']),
    `got: ${r.reply.slice(0, 200)}`);

  // 10. Greeting variant — "hi"
  r = await chat('hi', baseState);
  check('10. Casual greeting handled (not robotic)',
    r.reply.length > 0 && !r.reply.startsWith('Sure') && !r.reply.startsWith('Certainly'),
    `got: ${r.reply.slice(0, 200)}`);

  // 11. Confirmation gate — start_migration when ready
  r = await chat('start dry run', { ...baseState, googleAuthed: true, msAuthed: true,
    migDir: 'gemini-copilot', step: 4, uploadData: { total_users: 5 }, mappings_count: 5 });
  check('11. start_migration produces confirmation prompt',
    r.chips.includes('Yes, proceed') || includesAny(r.reply, ['proceed', 'sure', 'ready']),
    `chips: ${JSON.stringify(r.chips)}; reply: ${r.reply.slice(0, 150)}`);

  // 12. Cancel migration question
  r = await chat('Can I cancel the migration?', baseState);
  check('12. Cancel migration response present',
    includesAny(r.reply, ['cancel', 'stop', 'support']),
    `got: ${r.reply.slice(0, 200)}`);

  console.log(`\n${passed} passed · ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error('TEST FAILED:', e); process.exit(2); });
