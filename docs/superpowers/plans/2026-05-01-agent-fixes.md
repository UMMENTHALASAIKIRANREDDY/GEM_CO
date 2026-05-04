# Agent Chat Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 critical agent bugs: block destructive tools on system triggers, require confirmation before every action, correct step-aware chips/widgets, pass exact left-panel UI state to agent.

**Architecture:** Backend (`routes.js`) gets a `uiContext` string from frontend describing exactly what's on screen. System triggers block destructive tools. `generateSuggestedChips` becomes step+direction aware. Widget injection only fires at correct steps. Frontend sends a `pendingAction` confirmation flow instead of executing immediately.

**Tech Stack:** Node.js/Express, React (inline JSX), OpenAI GPT-4o

---

## Bug Summary

1. **CRITICAL: System trigger (`__step_context__`) fired `start_migration_live`** — agent called destructive tool during auto-context message. Must block all side-effect tools on system triggers.
2. **No confirmation before actions** — agent auto-maps, starts migration, goes live without asking user. Every destructive action needs a "Shall I proceed?" + chips before executing.
3. **`migration_actions` widget shows at wrong steps** — shows at step 2 (Import Data) where migration can't start. Must be step 4+ only.
4. **Chips are state-based not step-based** — "Start Dry Run" chips appear at step 2 where user hasn't mapped anyone yet.
5. **Agent doesn't know what's on screen** — gets `step=2, migDir=gemini-copilot` but doesn't know if user sees "User's List" or "Upload ZIP" tab, how many rows are in the mapping table, what buttons are enabled.

---

## Files Changed

- `src/modules/g2c/routes.js` — Fix 1 (block tools), Fix 3 (widget injection), Fix 4 (chips), Fix 5 (use uiContext)
- `ui/index.html` — Fix 2 (confirmation flow), Fix 3 (widget step gates), Fix 5 (send uiContext)

---

## Task 1: Block destructive tools on system triggers

**File:** `src/modules/g2c/routes.js`

When `isStepContext` is true, pass `null` instead of `AGENT_TOOLS` to `callAI` so the LLM cannot call any tools — it can only return text.

- [ ] **Step 1: Change callAI call for system triggers**

Find line 1181:
```js
let response = await callAI(messages, AGENT_TOOLS);
```

Replace with:
```js
// System triggers (step context) must never call destructive tools — text only
let response = await callAI(messages, isStepContext ? null : AGENT_TOOLS);
```

- [ ] **Step 2: Commit**
```bash
git add src/modules/g2c/routes.js
git commit -m "fix: block all tool calls on system context triggers"
```

**Verify:** Navigate between steps — no `[Agent] start_migration_live` or `[Agent] auto_map_users` logs should appear from context triggers.

---

## Task 2: Add `uiContext` — tell agent exactly what user sees

**File:** `ui/index.html` — in `sendToAgent`, inside the `migrationState` object (~line 2986)

Compute a `uiContext` string that describes exactly what's on the left panel right now.

- [ ] **Step 1: Add `uiContext` computation before the fetch call**

Add this just before the `migrationState` object definition in `sendToAgent`:

```js
// Compute exact left-panel description for agent context
const uiContext = (() => {
  if(step===0){
    const g=googleAuthed?'✓ Google connected':'✗ Google not connected';
    const m=msAuthed?'✓ Microsoft 365 connected':'✗ Microsoft 365 not connected';
    return `Left panel: Connect Clouds. ${g}. ${m}. User needs to connect accounts then click Next.`;
  }
  if(step===1){
    const opts=[];
    if(googleAuthed&&msAuthed)opts.push('Gemini→Copilot','Copilot→Gemini','Claude→Gemini');
    else if(googleAuthed)opts.push('Claude→Gemini (available)','Gemini→Copilot (needs MS)','Copilot→Gemini (needs MS)');
    else if(msAuthed)opts.push('Gemini→Copilot (needs Google)','Copilot→Gemini (needs Google)');
    else opts.push('All directions locked — need to connect accounts first');
    return `Left panel: Choose Direction. Options: ${opts.join(', ')}.`;
  }
  if(step===2&&migDir==='gemini-copilot'){
    const u=uploadData?`${uploadData.total_users} users loaded`:'no data uploaded';
    return `Left panel: Import Data (Gemini→Copilot). Two tabs: "User's List" and "Upload ZIP". Upload status: ${u}. User needs to select users or upload a Vault ZIP.`;
  }
  if(step===2&&migDir==='copilot-gemini'){
    const n=Object.keys(c2gMappings).length;
    return `Left panel: Map Users (Copilot→Gemini). ${n} users mapped so far. Auto-map button visible. User needs to map MS users to Google Drive destinations.`;
  }
  if(step===2&&migDir==='claude-gemini'){
    const u=cl2gUploadData?.users?.length||0;
    return `Left panel: Upload ZIP (Claude→Gemini). ${u>0?`${u} users loaded from ZIP`:'No ZIP uploaded yet'}. Drag-drop area visible. User needs to upload Claude export ZIP.`;
  }
  if(step===3&&migDir==='gemini-copilot'){
    const n=Object.keys(mappings).length;
    return `Left panel: Map Users (Gemini→Copilot). ${n}/${selectedUsers.size||n} users mapped. Auto-map button visible. User needs to map Google users to Microsoft 365 destinations.`;
  }
  if(step===3&&migDir==='claude-gemini'){
    const n=Object.keys(cl2gMappings).length;
    return `Left panel: Map Users (Claude→Gemini). ${n} users mapped. Auto-map button visible.`;
  }
  if(step===3&&migDir==='copilot-gemini'){
    return `Left panel: Options (Copilot→Gemini). Folder name, date range, dry run toggle visible. Start Migration button visible.`;
  }
  if(step===4&&migDir==='gemini-copilot'){
    return `Left panel: Options (Gemini→Copilot). Folder: "${config.filePath||'GeminiChats'}". Dry run: ${options.dryRun?'ON':'OFF'}. Start Migration button visible.`;
  }
  if(step===4&&migDir==='claude-gemini'){
    return `Left panel: Options (Claude→Gemini). Folder: "${cl2gConfig?.filePath||'ClaudeChats'}". Dry run: ${cl2gOptions?.dryRun?'ON':'OFF'}. Start Migration button visible.`;
  }
  if(step>=4&&(live||c2gLive||cl2gLive)){
    return `Left panel: Migration in progress. Live log stream visible. Stop not available — must wait for completion.`;
  }
  if(step>=5||(migDone||c2gDone||cl2gDone)){
    const s=stats||{};
    return `Left panel: Migration complete. Stats: ${s.users||0} users, ${s.pages||0} files, ${s.errors||0} errors. "Start Another" and report buttons visible.`;
  }
  return `Left panel: Step ${step}, direction ${migDir||'not selected'}.`;
})();
```

- [ ] **Step 2: Add `uiContext` to `migrationState` object**

Inside the `migrationState` object (after `cl2g_live:cl2gLive`), add:
```js
uiContext,
```

- [ ] **Step 3: Read `uiContext` in backend**

In `src/modules/g2c/routes.js`, in the destructuring of `migrationState` (~line 1085), add:
```js
const {
  step = 0, migDir = null, live = false, migDone = false, stats = {}, lastRunWasDry = false,
  agentMode = 'guide', uploadData = null, googleAuthed = false, msAuthed = false,
  mappings_count = 0, selected_users_count = 0, options = {},
  c2g_mappings_count = 0, cl2g_upload_users = 0, cl2g_mappings_count = 0,
  c2g_done = false, cl2g_done = false, c2g_live = false, cl2g_live = false,
  uiContext = ''   // ← add this
} = migrationState;
```

- [ ] **Step 4: Add `uiContext` to system prompt**

In the system prompt (`## What the user sees right now` section), replace:
```js
## What the user sees right now
${currentPanelContext}
```
With:
```js
## What the user sees right now
${uiContext || currentPanelContext}
```

- [ ] **Step 5: Commit**
```bash
git add src/modules/g2c/routes.js ui/index.html
git commit -m "feat: send exact left-panel uiContext to agent on every request"
```

---

## Task 3: Confirmation before every destructive action

**File:** `ui/index.html` — `sendToAgent` response handler and `handleAgentQuickReply`

When agent returns `action = 'auto_map_users'` or `action = 'start_migration_dry'` or `action = 'start_migration_live'`, **don't execute immediately**. Instead show a confirmation message with chips. Only execute when user clicks "Yes, proceed".

- [ ] **Step 1: Add pending action state**

Near other `useState` declarations (~line 2464), add:
```js
const [pendingAction,setPendingAction]=useState(null); // {action, payload, label}
```

- [ ] **Step 2: Replace immediate execution with confirmation in `sendToAgent`**

In the `sendToAgent` response handler, replace the direct execution blocks:

**Find** (~line 3004):
```js
if(data.action==='navigate_to_step'&&data.step!=null)setStep(data.step);
else if(data.action==='select_direction'&&data.migDir){setMigDir(data.migDir);setStep(2);}
else if(data.action==='start_migration_dry'){...}
else if(data.action==='start_migration_live'){...}
else if(data.action==='retry_failed')retryFailed();
else if(data.action==='auto_map_users')triggerAutoMap();
else if(data.action==='set_config')applyAgentConfig(data.config||{});
else if(data.action==='show_reports')setShowReports(true);
else if(data.action==='show_mapping')setLeftMode('mapping');
```

**Replace with:**
```js
const SAFE_ACTIONS=['navigate_to_step','select_direction','set_config','show_reports','show_mapping','show_post_migration_guide'];
const CONFIRM_ACTIONS={
  'start_migration_dry':{label:'Start Dry Run',desc:'Run a dry run — no data will be changed.'},
  'start_migration_live':{label:'Go Live',desc:'Start the real migration. Data will be written.'},
  'auto_map_users':{label:'Auto-map users',desc:'Map all users by email match automatically.'},
  'retry_failed':{label:'Retry failed',desc:'Re-run all failed items from the last batch.'},
};
if(data.action==='navigate_to_step'&&data.step!=null){console.log('[Agent] navigate_to_step',data.step);setStep(data.step);}
else if(data.action==='select_direction'&&data.migDir){console.log('[Agent] select_direction',data.migDir);setMigDir(data.migDir);setStep(2);}
else if(data.action==='set_config'){console.log('[Agent] set_config',data.config);applyAgentConfig(data.config||{});}
else if(data.action==='show_reports'){console.log('[Agent] show_reports');setShowReports(true);}
else if(data.action==='show_mapping'){console.log('[Agent] show_mapping');setLeftMode('mapping');}
else if(CONFIRM_ACTIONS[data.action]){
  const c=CONFIRM_ACTIONS[data.action];
  console.log('[Agent] confirm required for',data.action);
  setPendingAction({action:data.action,payload:data});
  // Override the bot message to append confirmation request
  addAgentMsg('bot',`${data.reply||''}\n\n**Confirm:** ${c.desc}`,{
    quickReplies:['Yes, proceed','Cancel'],
    widget:null
  });
  setAgentTyping(false);
  return; // don't fall through to addAgentMsg below
}
```

- [ ] **Step 3: Execute pending action in `handleAgentQuickReply`**

In `handleAgentQuickReply` (~line 3029), add at the TOP before other conditions:
```js
if(qr==='Yes, proceed'&&pendingAction){
  const {action,payload}=pendingAction;
  setPendingAction(null);
  addAgentMsg('user','Yes, proceed');
  console.log('[Agent] confirmed action:',action);
  if(action==='start_migration_dry'){
    if(migDir==='copilot-gemini'){setC2gOptions(p=>({...p,dryRun:true}));setTimeout(()=>runC2GMigration(false),200);}
    else if(migDir==='claude-gemini'){setCl2gOptions(p=>({...p,dryRun:true}));setTimeout(()=>runCL2GMigration(false),200);}
    else{setOptions(p=>({...p,dryRun:true}));setTimeout(()=>runMigration(false),200);}
  } else if(action==='start_migration_live'){
    if(migDir==='copilot-gemini')setTimeout(()=>runC2GMigration(true),200);
    else if(migDir==='claude-gemini')setTimeout(()=>runCL2GMigration(true),200);
    else{setOptions(p=>({...p,dryRun:false}));setTimeout(()=>runMigration(true),200);}
  } else if(action==='auto_map_users'){triggerAutoMap();}
  else if(action==='retry_failed'){retryFailed();}
  return;
}
if(qr==='Cancel'&&pendingAction){
  setPendingAction(null);
  addAgentMsg('user','Cancel');
  addAgentMsg('bot','Cancelled. Let me know when you\'re ready to proceed.',{quickReplies:generateFallbackChips()});
  return;
}
```

- [ ] **Step 4: Add `generateFallbackChips` helper in frontend**

Add this small helper just before `sendToAgent`:
```js
const generateFallbackChips=useCallback(()=>{
  if(!migDir)return['Gemini → Copilot','Copilot → Gemini','Claude → Gemini'];
  const em=migDir==='copilot-gemini'?Object.keys(c2gMappings).length:migDir==='claude-gemini'?Object.keys(cl2gMappings).length:Object.keys(mappings).length;
  if(em>0&&!live&&!c2gLive&&!cl2gLive)return['Start Dry Run','What is a dry run?'];
  if(em===0)return['Auto-map users','Show mapping table'];
  return['Check status','What do I do next?'];
},[migDir,c2gMappings,cl2gMappings,mappings,live,c2gLive,cl2gLive]);
```

- [ ] **Step 5: Commit**
```bash
git add ui/index.html
git commit -m "feat: require confirmation before auto-map, start-migration, retry actions"
```

---

## Task 4: Fix step-aware chips and widget injection

**File:** `src/modules/g2c/routes.js`

`generateSuggestedChips` and widget injection must use `step` to be accurate.

- [ ] **Step 1: Replace `generateSuggestedChips` with step-aware version**

Replace the entire function (lines 37-53):
```js
function generateSuggestedChips({ step=0, migDir, googleAuthed, msAuthed, live, migDone,
  lastRunWasDry, uploadData, mappings_count, c2g_mappings_count, cl2g_mappings_count,
  c2g_done, cl2g_done, c2g_live, cl2g_live }) {
  const isRunning = live || c2g_live || cl2g_live;
  const isDone = migDone || c2g_done || cl2g_done;
  const effectiveMappings = migDir==='copilot-gemini' ? c2g_mappings_count
    : migDir==='claude-gemini' ? cl2g_mappings_count : mappings_count;

  // Step 0: Connect Clouds
  if(step===0||!migDir){
    if(!googleAuthed&&!msAuthed) return ['Connect Google','Connect Microsoft 365','What do I need?'];
    if(!googleAuthed) return ['Connect Google Workspace','What do I need?'];
    if(!msAuthed) return ['Connect Microsoft 365','Skip — do Claude→Gemini'];
    return ['Choose direction','What\'s the difference?'];
  }
  // Step 1: Direction
  if(step===1){
    const opts=['Claude → Gemini'];
    if(googleAuthed&&msAuthed) opts.unshift('Gemini → Copilot','Copilot → Gemini');
    opts.push('What\'s the difference?');
    return opts;
  }
  // Step 2: Upload / Map (depends on direction)
  if(step===2){
    if(migDir==='gemini-copilot') return ['How do I export from Google?','What\'s in the ZIP?','Select users instead'];
    if(migDir==='claude-gemini') return ['How do I export from Claude?','What\'s in the ZIP?'];
    if(migDir==='copilot-gemini') return effectiveMappings>0
      ? ['Auto-map users','What is auto-map?','How mapping works']
      : ['Auto-map users','What is auto-map?'];
  }
  // Step 3: Map Users (G2C / CL2G)
  if(step===3&&migDir!=='copilot-gemini'){
    if(effectiveMappings===0) return ['Auto-map users','What is auto-map?','Skip unmapped users'];
    return ['Auto-map users','All looks good','How many are mapped?'];
  }
  // Step 3 C2G / Step 4 G2C+CL2G: Options
  if((step===3&&migDir==='copilot-gemini')||(step===4)){
    if(isRunning) return ['Check status','How long will this take?'];
    return ['Start Dry Run','What is a dry run?','Go straight to live','Change folder name'];
  }
  // Running
  if(isRunning) return ['Check status','How long will this take?','Any errors so far?'];
  // Done
  if(isDone&&lastRunWasDry) return ['Go Live now','Show me the report','What changed?'];
  if(isDone) return ['What do I do next?','Download report','Start Another'];
  return ['Check status'];
}
```

- [ ] **Step 2: Fix widget injection to be step-gated**

Replace the widget injection block (~line 1309-1320):
```js
// Step-gated widget injection — only show widgets when they make sense for the current step
if (!payload.widget) {
  const needsGoogle = migDir === 'gemini-copilot' || migDir === 'claude-gemini';
  const needsMs = migDir === 'gemini-copilot' || migDir === 'copilot-gemini';
  const authMissing = (needsGoogle && !googleAuthed) || (needsMs && !msAuthed);

  if (step === 0 || authMissing) {
    // Always show auth widget at connect step or when auth is blocking
    payload.widget = { type: 'auth_connect' };
  } else if (!isRunning && !isDone && effectiveMappingsCount > 0) {
    // Only show migration actions widget when user is on options step or later
    const isOptionsStep = (migDir==='copilot-gemini' && step>=3)
      || (migDir==='claude-gemini' && step>=4)
      || (migDir==='gemini-copilot' && step>=4);
    if (isOptionsStep) {
      payload.widget = { type: 'migration_actions' };
    }
  }
}
```

- [ ] **Step 3: Pass `step` into `generateSuggestedChips` call**

At line 1304, the call is:
```js
const payload = { reply, quickReplies: generateSuggestedChips(migrationState) };
```
`migrationState` already contains `step` — but `generateSuggestedChips` wasn't destructuring it before. The new function signature includes `step=0` so this works automatically.

- [ ] **Step 4: Commit**
```bash
git add src/modules/g2c/routes.js
git commit -m "fix: step-aware chips and widget injection — no migration_actions before options step"
```

---

## Task 5: System prompt — remove aggressive action rules, add confirmation guidance

**File:** `src/modules/g2c/routes.js`

The system prompt currently tells the agent to call `start_migration` when user says "start". This causes instant execution. Change it to: always ask confirmation first.

- [ ] **Step 1: Replace Action rules section in system prompt**

Find in the system prompt:
```
## Action rules
- "start" / "go" / "migrate" / "let's go" → pre_flight_check then start_migration
- "auto map" / "map users" → auto_map_users immediately
- direction name mentioned → select_direction immediately
- "dry run" → start_migration dryRun:true (after pre_flight_check)
- "go live" / "live" → confirm once, then start_migration dryRun:false
- "retry" → retry_failed
- ALWAYS pre_flight_check before start_migration
```

Replace with:
```
## Action rules
- Direction name ("Gemini to Copilot", "Claude to Gemini" etc) → call select_direction immediately (safe, no data change)
- "show reports" / "show mapping" → call those tools immediately (safe)
- "navigate to step X" → call navigate_to_step (safe)
- "auto map" / "map users" → call auto_map_users — frontend will ask user to confirm before executing
- "start" / "dry run" / "go" / "migrate" → call pre_flight_check first, then start_migration — frontend will ask user to confirm before executing
- "go live" → call pre_flight_check first, then start_migration dryRun:false — frontend will ask user to confirm
- "retry" → call retry_failed — frontend will ask user to confirm
- NEVER execute start_migration without calling pre_flight_check first
- When intent is ambiguous → ask a clarifying question with chips, do not guess
```

- [ ] **Step 2: Commit**
```bash
git add src/modules/g2c/routes.js
git commit -m "fix: system prompt confirmation-first action rules"
```

---

## Verification

After all tasks, restart server and test:

```powershell
Get-Process -Name node | Stop-Process -Force
Start-Sleep -Seconds 2
Set-Location "C:\Users\LaxmanKadari\OneDrive - CloudFuze, Inc\desktop\GEM_CO"
Start-Process node -ArgumentList "server.js" -WindowStyle Normal
```

**Test checklist:**

1. **System trigger safety** — Navigate left panel steps. Watch browser console: `[Agent] Context trigger` logs should appear. Server logs should show `finish_reason=stop tool_calls=0` for all context triggers. Never `start_migration_live` from context trigger.

2. **uiContext** — In browser console, check `[Agent] POST /api/chat state:` — should include `uiContext: "Left panel: ..."` string.

3. **Step 1 with Google only** — Select Claude→Gemini direction chip. Right panel message should say "Google is all you need for Claude→Gemini — upload your ZIP next" (not "both accounts needed").

4. **Confirmation flow** — Type "auto map" in chat. Agent should reply with confirmation message + "Yes, proceed" / "Cancel" chips. Clicking "Yes, proceed" should trigger auto-map. Clicking "Cancel" should do nothing.

5. **Widget at wrong step** — At step 2 (Import Data), no `migration_actions` widget should appear. At step 4 (Options) with users mapped, `migration_actions` widget should appear.

6. **Chips at step 2** — Should show "How do I export from Claude?" / "What's in the ZIP?" — not "Start Dry Run".
