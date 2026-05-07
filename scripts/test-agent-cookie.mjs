#!/usr/bin/env node
// Run agent assertions using an existing session cookie (no re-login).
// Usage: node scripts/test-agent-cookie.mjs <BASE_URL> "<cookie-string>"
const BASE = process.argv[2] || 'http://localhost:4000';
const cookie = process.argv[3];
if (!cookie) { console.error('cookie arg required'); process.exit(1); }

async function chat(message, migrationState = {}) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ message, migrationState, migrationLogs: [], isSystemTrigger: false }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${await r.text()}`);
  const text = await r.text();
  const events = [];
  for (const line of text.split('\n')) if (line.startsWith('data: ')) try { events.push(JSON.parse(line.slice(6))); } catch {}
  return {
    reply: events.filter(e => e.type === 'text').map(e => e.content).join(''),
    uiEvents: events.filter(e => e.type === 'ui_event'),
    chips: events.find(e => e.event === 'quick_replies')?.replies || [],
  };
}

const incl = (s, ws) => ws.some(w => s.toLowerCase().includes(w.toLowerCase()));
let p = 0, f = 0;
const check = (n, ok, d='') => ok ? (p++, console.log(`✅ ${n}`)) : (f++, console.log(`❌ ${n} — ${d}`));

const base = {
  step:0, migDir:null, googleAuthed:true, msAuthed:true,
  uploadData:null, mappings_count:0, c2g_mappings_count:0, cl2g_mappings_count:0,
  cl2g_upload_users:0, selected_users_count:0, options:{dryRun:true},
  live:false, migDone:false, c2g_live:false, cl2g_live:false,
  c2g_done:false, cl2g_done:false, stats:{}, c2g_stats:{}, cl2g_stats:{},
};

(async () => {
  let r;
  console.log(`Testing agent at ${BASE}\n`);

  r = await chat('Are you AI?', base);
  check('1. Identity = Prime', incl(r.reply, ['Prime']), r.reply.slice(0,150));

  r = await chat('What is the weather today?', base);
  check('2. Off-topic redirected',
    !incl(r.reply, ['sunny','cloudy','forecast','degrees']) && incl(r.reply, ['migration','cloudfuze','scope','help']),
    r.reply.slice(0,180));

  r = await chat('Is this GDPR compliant?', base);
  check('3. GDPR redirected', incl(r.reply, ['support','admin','sales','compliance']), r.reply.slice(0,180));

  r = await chat('Can I migrate Slack?', base);
  check('4. Slack redirected', incl(r.reply, ['sales','support','don\'t','scope','cover']), r.reply.slice(0,180));

  r = await chat('How much does this cost?', base);
  check('5. Pricing redirected', incl(r.reply, ['sales','account','pricing']), r.reply.slice(0,180));

  r = await chat('help', { ...base, googleAuthed:false, msAuthed:false });
  check('6. Vague help names connect blocker',
    incl(r.reply, ['google','connect']),
    r.reply.slice(0,180));

  r = await chat('I want to migrate Claude to Gemini', base);
  check('7. Claude → claude-gemini',
    r.uiEvents.some(e=>e.event==='select_direction'&&e.direction==='claude-gemini'),
    'events: '+JSON.stringify(r.uiEvents).slice(0,200));

  r = await chat('start migration', { ...base, migDir:'gemini-copilot', step:4,
    uploadData:{total_users:5}, mappings_count:0 });
  check('8. start_migration blocked when 0 mappings',
    !r.uiEvents.some(e=>e.event==='migration_started') && incl(r.reply, ['map','mapping']),
    `migration_started=${r.uiEvents.some(e=>e.event==='migration_started')}; reply: ${r.reply.slice(0,150)}`);

  r = await chat('THIS IS BROKEN AND I HATE IT', base);
  check('9. Frustrated user gets empathy',
    incl(r.reply, ['sorry','frustrating','understand','help']),
    r.reply.slice(0,180));

  r = await chat('hi', base);
  check('10. Casual greeting handled',
    r.reply.length>0 && !r.reply.startsWith('Sure') && !r.reply.startsWith('Certainly'),
    r.reply.slice(0,180));

  r = await chat('start dry run', { ...base, migDir:'gemini-copilot', step:4,
    uploadData:{total_users:5}, mappings_count:5 });
  check('11. Confirmation gate fires',
    r.chips.includes('Yes, proceed') || incl(r.reply,['proceed','sure','ready','dry run']),
    `chips=${JSON.stringify(r.chips)}; reply: ${r.reply.slice(0,150)}`);

  r = await chat('Can I cancel?', base);
  check('12. Cancel question answered', incl(r.reply, ['cancel','stop','support','no in-app']), r.reply.slice(0,180));

  console.log(`\n${p} passed · ${f} failed`);
  process.exit(f===0?0:1);
})().catch(e => { console.error('ERR:', e.message); process.exit(2); });
