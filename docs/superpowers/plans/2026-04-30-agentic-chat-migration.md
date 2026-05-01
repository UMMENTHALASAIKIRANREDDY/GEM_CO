# Agentic Chat Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the right-panel chat a full migration control surface — agent can navigate, auto-map, start/retry migrations, set config, and react to left-panel events, while left-panel usage still works independently.

**Architecture:** New action tools added to the backend `/api/chat` route return structured `action` fields. The frontend `sendToAgent` response handler executes those actions by calling existing React state setters and migration functions. Targeted notification calls in auth/upload/mapping handlers fire single proactive agent messages when the user acts in the left panel.

**Tech Stack:** Node.js/Express (backend tools), React hooks inline in `ui/index.html` (frontend), Azure OpenAI / OpenAI GPT-4o (LLM).

---

## File Map

- **Modify:** `src/modules/g2c/routes.js` — add 7 new tools to `AGENT_TOOLS` array (lines 37–99), add cases to tool switch (lines 1055–1094), update system prompt (line 1034), return new action fields
- **Modify:** `ui/index.html` — handle new actions in `sendToAgent` response handler, add `triggerAutoMap()` function, add `applyAgentConfig()` function, add notification calls in auth/upload/mapping event handlers, extend `handleAgentQuickReply` for direction and action chips

---

## Task 1: Add New Agent Tools to Backend

**Files:**
- Modify: `src/modules/g2c/routes.js:37-99` (AGENT_TOOLS array)
- Modify: `src/modules/g2c/routes.js:1034` (system prompt restriction line)

- [ ] **Step 1: Add 7 new tool definitions to AGENT_TOOLS array**

Open `src/modules/g2c/routes.js`. After line 98 (closing `]` of AGENT_TOOLS), replace the closing bracket to insert new tools. The full addition after the existing `show_post_migration_guide` entry (before the closing `];`):

```js
  {
    type: 'function',
    function: {
      name: 'navigate_to_step',
      description: 'Navigate the left panel to a specific step number. Use when user asks to go somewhere ("take me to mapping", "go back to upload").',
      parameters: {
        type: 'object',
        properties: { step: { type: 'number', description: 'Step index: 0=Connect, 1=Direction, 2=Upload/Import, 3=Map Users, 4=Options, 5=Migration' } },
        required: ['step']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'select_direction',
      description: 'Set the migration direction and advance the left panel to step 2. Use when user says which direction they want.',
      parameters: {
        type: 'object',
        properties: { migDir: { type: 'string', enum: ['gemini-copilot', 'copilot-gemini', 'claude-gemini'], description: 'Migration direction' } },
        required: ['migDir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'start_migration',
      description: 'Start migration. Always call pre_flight_check first. Confirm with user before dryRun=false if no dry run has been done.',
      parameters: {
        type: 'object',
        properties: { dryRun: { type: 'boolean', description: 'true = dry run (safe preview), false = live migration (writes data)' } },
        required: ['dryRun']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed',
      description: 'Retry failed items from the last migration batch. Only call if migration is done and errors > 0.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'auto_map_users',
      description: 'Automatically map source users to destination users by email match. Works for all directions.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_migration_config',
      description: 'Set migration options. Call when user specifies folder name, date range, or dry/live preference.',
      parameters: {
        type: 'object',
        properties: {
          folderName: { type: 'string', description: 'Destination folder name in Google Drive or OneNote' },
          fromDate: { type: 'string', description: 'Start date filter ISO string or empty string for no filter' },
          toDate: { type: 'string', description: 'End date filter ISO string or empty string for no filter' },
          dryRun: { type: 'boolean', description: 'Set dry run toggle' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pre_flight_check',
      description: 'Validate state before starting migration. Always call this before start_migration. Returns list of blockers and warnings.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
```

- [ ] **Step 2: Update system prompt — remove restriction, add action guidance**

Find line 1034 in `src/modules/g2c/routes.js`:
```js
Never suggest navigating to a step, starting a migration, or retrying — the user controls those buttons.`;
```

Replace with:
```js
You CAN act on behalf of the user via tools. Always run pre_flight_check before start_migration. Confirm before going live (dryRun: false). When intent is ambiguous, ask with chips. Generate contextual quickReplies on every response.`;
```

- [ ] **Step 3: Add tool switch cases for all 7 new tools**

In the switch block (lines 1055–1094), add after the `show_status_card` case and before `default`:

```js
case 'navigate_to_step': {
  const s = typeof args.step === 'number' ? args.step : parseInt(args.step, 10);
  actionToExecute = 'navigate_to_step';
  actionPayload = { step: s };
  result = JSON.stringify({ execute: 'navigate_to_step', step: s });
  break;
}
case 'select_direction': {
  actionToExecute = 'select_direction';
  actionPayload = { migDir: args.migDir };
  result = JSON.stringify({ execute: 'select_direction', migDir: args.migDir });
  break;
}
case 'start_migration': {
  actionToExecute = args.dryRun ? 'start_migration_dry' : 'start_migration_live';
  actionPayload = { dryRun: args.dryRun };
  result = JSON.stringify({ execute: 'start_migration', dryRun: args.dryRun });
  break;
}
case 'retry_failed': {
  actionToExecute = 'retry_failed';
  result = JSON.stringify({ execute: 'retry_failed' });
  break;
}
case 'auto_map_users': {
  actionToExecute = 'auto_map_users';
  result = JSON.stringify({ execute: 'auto_map_users' });
  break;
}
case 'set_migration_config': {
  actionToExecute = 'set_config';
  actionPayload = { config: args };
  result = JSON.stringify({ execute: 'set_config', config: args });
  break;
}
case 'pre_flight_check': {
  const blockers = [];
  const warnings = [];
  if (migDir === 'claude-gemini' || migDir === 'gemini-copilot') {
    if (!googleAuthed) blockers.push('Google Workspace not connected');
  }
  if (migDir === 'gemini-copilot' || migDir === 'copilot-gemini') {
    if (!msAuthed) blockers.push('Microsoft 365 not connected');
  }
  if (!migDir) blockers.push('No migration direction selected');
  if ((migDir === 'claude-gemini' || migDir === 'gemini-copilot') && !uploadData) {
    blockers.push('No file uploaded yet');
  }
  if (mappings_count === 0) blockers.push('No users mapped');
  if (live) blockers.push('Migration already running');
  if (selected_users_count < mappings_count) warnings.push(`${mappings_count - selected_users_count} users have no destination mapping — they will be skipped`);
  result = JSON.stringify({ blockers, warnings, ready: blockers.length === 0 });
  break;
}
```

- [ ] **Step 4: Declare `actionPayload` variable and include in response**

Near line 1045, find:
```js
let actionToExecute = null;
```
Change to:
```js
let actionToExecute = null;
let actionPayload = {};
```

Near line 1104, find:
```js
if (actionToExecute) payload.action = actionToExecute;
```
Change to:
```js
if (actionToExecute) { payload.action = actionToExecute; Object.assign(payload, actionPayload); }
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/g2c/routes.js
git commit -m "feat(agent): add 7 action tools — navigate, select_direction, start_migration, retry, auto_map, set_config, pre_flight_check"
```

---

## Task 2: Handle New Actions in Frontend sendToAgent

**Files:**
- Modify: `ui/index.html` — `sendToAgent` response handler (~line 2920)

- [ ] **Step 1: Add `triggerAutoMap` function**

Find the `runAnotherBatch` function (~line 2664). Before it, add:

```js
const triggerAutoMap=useCallback(()=>{
  if(migDir==='gemini-copilot'){
    // G2C auto-map: match googleUsers email to msUsers email
    const newMappings={...mappings};
    (uploadData?.users||[]).forEach(u=>{
      const match=msUsers.find(m=>m.email?.toLowerCase()===u.email?.toLowerCase());
      if(match&&!newMappings[u.email])newMappings[u.email]=match.email;
    });
    setMappings(newMappings);
    const mapped=Object.values(newMappings).filter(Boolean).length;
    const total=(uploadData?.users||[]).length;
    addAgentMsg('bot',`Auto-mapped **${mapped}** of **${total}** users by email match.${mapped<total?` **${total-mapped}** have no match — fill them in on the left.`:' All users mapped!'}`);
  } else if(migDir==='copilot-gemini'){
    const newMappings={...c2gMappings};
    msUsers.forEach(u=>{
      const match=googleUsers.find(g=>g.email?.toLowerCase()===u.email?.toLowerCase());
      if(match&&!newMappings[u.email])newMappings[u.email]=match.email;
    });
    setC2gMappings(newMappings);
    const mapped=Object.values(newMappings).filter(Boolean).length;
    const total=msUsers.length;
    addAgentMsg('bot',`Auto-mapped **${mapped}** of **${total}** users.${mapped<total?` **${total-mapped}** unmatched — fill in on the left.`:' All mapped!'}`);
  } else if(migDir==='claude-gemini'){
    const newMappings={...cl2gMappings};
    (cl2gUploadData?.users||[]).forEach(u=>{
      const match=googleUsers.find(g=>g.email?.toLowerCase()===u.email_address?.toLowerCase());
      if(match&&!newMappings[u.uuid])newMappings[u.uuid]=match.email;
    });
    setCl2gMappings(newMappings);
    const mapped=Object.values(newMappings).filter(Boolean).length;
    const total=(cl2gUploadData?.users||[]).length;
    addAgentMsg('bot',`Auto-mapped **${mapped}** of **${total}** users.${mapped<total?` **${total-mapped}** unmatched — fill in on the left.`:' All mapped!'}`);
  }
},[migDir,mappings,uploadData,msUsers,googleUsers,c2gMappings,cl2gMappings,cl2gUploadData,setMappings,setC2gMappings,setCl2gMappings,addAgentMsg]);
```

- [ ] **Step 2: Add `applyAgentConfig` function**

After `triggerAutoMap`, add:

```js
const applyAgentConfig=useCallback((cfg={})=>{
  if(cfg.folderName!==undefined){
    if(migDir==='copilot-gemini')setC2gConfig(p=>({...p,folderName:cfg.folderName}));
    else if(migDir==='claude-gemini')setCl2gConfig(p=>({...p,folderName:cfg.folderName}));
    else setConfig(p=>({...p,folderName:cfg.folderName}));
  }
  if(cfg.fromDate!==undefined||cfg.toDate!==undefined){
    if(migDir==='copilot-gemini')setC2gOptions(p=>({...p,fromDate:cfg.fromDate??p.fromDate,toDate:cfg.toDate??p.toDate}));
    else if(migDir==='claude-gemini')setCl2gOptions(p=>({...p,fromDate:cfg.fromDate??p.fromDate,toDate:cfg.toDate??p.toDate}));
    else setOptions(p=>({...p,fromDate:cfg.fromDate??p.fromDate,toDate:cfg.toDate??p.toDate}));
  }
  if(cfg.dryRun!==undefined){
    if(migDir==='copilot-gemini')setC2gOptions(p=>({...p,dryRun:cfg.dryRun}));
    else if(migDir==='claude-gemini')setCl2gOptions(p=>({...p,dryRun:cfg.dryRun}));
    else setOptions(p=>({...p,dryRun:cfg.dryRun}));
  }
},[migDir,setConfig,setOptions,setC2gConfig,setC2gOptions,setCl2gConfig,setCl2gOptions]);
```

- [ ] **Step 3: Extend sendToAgent response handler with new action cases**

Find in `sendToAgent` (~line 2920):
```js
if(data.navigate!=null&&!live&&!c2gLive&&!migDone)setStep(data.navigate);
if(data.action==='start_migration_dry'){setOptions(p=>({...p,dryRun:true}));setTimeout(()=>runMigration(false),200);}
else if(data.action==='start_migration_live'){setOptions(p=>({...p,dryRun:false}));setTimeout(()=>runMigration(true),200);}
else if(data.action==='retry_failed')retryFailed();
else if(data.action==='show_reports')setShowReports(true);
else if(data.action==='show_mapping')setLeftMode('mapping');
```

Replace with:
```js
if(data.action==='navigate_to_step'&&data.step!=null)setStep(data.step);
else if(data.action==='select_direction'&&data.migDir){setMigDir(data.migDir);setStep(2);}
else if(data.action==='start_migration_dry'){
  if(migDir==='copilot-gemini'){setC2gOptions(p=>({...p,dryRun:true}));setTimeout(()=>runC2GMigration(false),200);}
  else if(migDir==='claude-gemini'){setCl2gOptions(p=>({...p,dryRun:true}));setTimeout(()=>runCL2GMigration(false),200);}
  else{setOptions(p=>({...p,dryRun:true}));setTimeout(()=>runMigration(false),200);}
}
else if(data.action==='start_migration_live'){
  if(migDir==='copilot-gemini')setTimeout(()=>runC2GMigration(true),200);
  else if(migDir==='claude-gemini')setTimeout(()=>runCL2GMigration(true),200);
  else{setOptions(p=>({...p,dryRun:false}));setTimeout(()=>runMigration(true),200);}
}
else if(data.action==='retry_failed')retryFailed();
else if(data.action==='auto_map_users')triggerAutoMap();
else if(data.action==='set_config')applyAgentConfig(data.config||{});
else if(data.action==='show_reports')setShowReports(true);
else if(data.action==='show_mapping')setLeftMode('mapping');
```

- [ ] **Step 4: Update sendToAgent useCallback deps**

Find the closing deps array of `sendToAgent`:
```js
},[agentInput,agentMsgs,logs,step,live,migDone,stats,lastRunWasDry,currentBatchId,uploadData,googleAuthed,msAuthed,mappings,selectedUsers,options,config,agentMode,addAgentMsg]);
```

Replace with:
```js
},[agentInput,agentMsgs,logs,step,live,migDone,stats,lastRunWasDry,currentBatchId,uploadData,googleAuthed,msAuthed,mappings,selectedUsers,options,config,agentMode,migDir,runMigration,runC2GMigration,runCL2GMigration,retryFailed,triggerAutoMap,applyAgentConfig,addAgentMsg,setMigDir,setStep,setC2gOptions,setCl2gOptions,setOptions,setShowReports,setLeftMode]);
```

- [ ] **Step 5: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): handle navigate/direction/start/auto-map/config actions from chat"
```

---

## Task 3: Left Panel → Agent Notifications

**Files:**
- Modify: `ui/index.html` — auth handlers, upload handlers, mapping handlers

- [ ] **Step 1: Add notification after Google auth success**

Find `handleChatSignInGoogle` (~line 2955). Inside the success callback after `setGoogleAuthed(true)`:

```js
// After: setGoogleAuthed(true);setChatGLoading(false);
if(agentMode==='guide'){
  const msg=msAuthed
    ?`Google Workspace connected! Both accounts ready. Choose a direction to get started.`
    :migDir==='claude-gemini'
      ?`Google connected! You're all set for Claude → Gemini. Ready to upload your Claude ZIP?`
      :`Google connected! Now connect Microsoft 365 to unlock Gemini↔Copilot migration — or choose Claude → Gemini which only needs Google.`;
  addAgentMsg('bot',msg,{quickReplies:msAuthed?['Gemini → Copilot','Copilot → Gemini','Claude → Gemini']:['Connect Microsoft 365','Claude → Gemini — Google only']});
}
```

- [ ] **Step 2: Add notification after MS auth success**

Find `handleChatSignInMs` (~line 2971). Inside the success callback after `setMsAuthed(true)`:

```js
// After: setMsAuthed(true);setChatMLoading(false);
if(agentMode==='guide'){
  const msg=googleAuthed
    ?`Microsoft 365 connected! Both accounts ready — choose your migration direction.`
    :`Microsoft 365 connected! Now connect Google Workspace to complete setup.`;
  addAgentMsg('bot',msg,{quickReplies:googleAuthed?['Gemini → Copilot','Copilot → Gemini']:['Connect Google Workspace']});
}
```

- [ ] **Step 3: Add notification after CL2G upload complete**

Find in the CL2G upload handler where `setCl2gUploadData` is called. This is in `handleChatUpload` or the upload step component. Search for `setCl2gUploadData(` in `ui/index.html`.

After the `setCl2gUploadData(data)` call:
```js
if(agentMode==='guide'){
  const n=data.users?.length||0;
  addAgentMsg('bot',`ZIP uploaded — **${n} user${n!==1?'s':''}** found. Want me to auto-map them by email?`,
    {quickReplies:['Yes, auto-map','I\'ll map manually','What is auto-map?']});
}
```

- [ ] **Step 4: Add notification after G2C upload complete**

Find where `setUploadData(` is called after a successful G2C upload. After that call:
```js
if(agentMode==='guide'){
  const n=data.users?.length||data.total_users||0;
  addAgentMsg('bot',`Vault data loaded — **${n} user${n!==1?'s':''}** found. Want me to auto-map them by email?`,
    {quickReplies:['Yes, auto-map','I\'ll map manually']});
}
```

- [ ] **Step 5: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): targeted notifications on auth and upload events"
```

---

## Task 4: Extend handleAgentQuickReply for Direction + Action Chips

**Files:**
- Modify: `ui/index.html` — `handleAgentQuickReply` (~line 2929)

- [ ] **Step 1: Add direction chip handlers**

Find `handleAgentQuickReply`. Add at the top of the if-else chain:

```js
if(qr==='Gemini → Copilot'||qr==='gemini-copilot'){setMigDir('gemini-copilot');setStep(2);addAgentMsg('user',qr);}
else if(qr==='Copilot → Gemini'||qr==='copilot-gemini'){setMigDir('copilot-gemini');setStep(2);addAgentMsg('user',qr);}
else if(qr==='Claude → Gemini'||qr==='claude-gemini'||qr==='Claude → Gemini — Google only'){setMigDir('claude-gemini');setStep(2);addAgentMsg('user',qr);}
else if(qr==='Connect Google Workspace'){addAgentMsg('user',qr);handleChatSignInGoogle();}
else if(qr==='Connect Microsoft 365'){addAgentMsg('user',qr);handleChatSignInMs();}
else if(qr==='Yes, auto-map'){addAgentMsg('user',qr);triggerAutoMap();}
else if(qr==='Skip unmapped users'){sendToAgent('Skip the unmapped users and proceed');}
else if(qr==='Fill them in'){setStep(migDir==='copilot-gemini'?2:3);addAgentMsg('bot','Open the mapping table on the left and fill in the missing destination emails.');}
else if(qr==='Start dry run'){
  addAgentMsg('user','Start dry run');
  if(migDir==='copilot-gemini'){setC2gOptions(p=>({...p,dryRun:true}));setTimeout(()=>runC2GMigration(false),200);}
  else if(migDir==='claude-gemini'){setCl2gOptions(p=>({...p,dryRun:true}));setTimeout(()=>runCL2GMigration(false),200);}
  else{setOptions(p=>({...p,dryRun:true}));setTimeout(()=>runMigration(false),200);}
}
else if(qr==='Go live now'||qr==='Go straight to live'){
  addAgentMsg('user',qr);
  if(migDir==='copilot-gemini')setTimeout(()=>runC2GMigration(true),200);
  else if(migDir==='claude-gemini')setTimeout(()=>runCL2GMigration(true),200);
  else{setOptions(p=>({...p,dryRun:false}));setTimeout(()=>runMigration(true),200);}
}
```

- [ ] **Step 2: Update handleAgentQuickReply deps array**

Find the closing `},[...])` of `handleAgentQuickReply`. Ensure it includes:
```js
},[sendToAgent,retryFailed,runAnotherBatch,runMigration,runC2GMigration,runCL2GMigration,triggerAutoMap,addAgentMsg,setOptions,setStep,setMigDir,migDir,setC2gOptions,setCl2gOptions,handleChatSignInGoogle,handleChatSignInMs]);
```

- [ ] **Step 3: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): direction and action chips in handleAgentQuickReply"
```

---

## Task 5: Pass Full State to Backend for Context-Aware Chips

**Files:**
- Modify: `ui/index.html` — `sendToAgent` payload (~line 2912)

- [ ] **Step 1: Extend migrationState payload**

Find the `body:JSON.stringify(...)` in `sendToAgent`. Extend `migrationState`:

```js
migrationState:{
  step, migDir, live, migDone, stats, lastRunWasDry, currentBatchId, agentMode,
  googleAuthed, msAuthed,
  uploadData: uploadData?{id:uploadData.id,total_users:uploadData.total_users,total_conversations:uploadData.total_conversations}:null,
  mappings_count: Object.keys(mappings).length,
  selected_users_count: selectedUsers.size,
  options:{dryRun:options.dryRun,hasFilePath:!!config.filePath},
  // New fields
  c2g_mappings_count: Object.keys(c2gMappings).length,
  cl2g_upload_users: cl2gUploadData?.users?.length||0,
  cl2g_mappings_count: Object.keys(cl2gMappings).length,
  c2g_done: c2gDone,
  cl2g_done: cl2gDone,
  c2g_live: c2gLive,
  cl2g_live: cl2gLive,
}
```

- [ ] **Step 2: Destructure new fields in backend**

In `src/modules/g2c/routes.js` at the destructuring block (~line 990):

```js
const {
  step = 0, migDir = null, live = false, migDone = false, stats = {}, lastRunWasDry = false,
  agentMode = 'guide', uploadData = null, googleAuthed = false, msAuthed = false,
  mappings_count = 0, selected_users_count = 0, options = {},
  c2g_mappings_count = 0, cl2g_upload_users = 0, cl2g_mappings_count = 0,
  c2g_done = false, cl2g_done = false, c2g_live = false, cl2g_live = false
} = migrationState;
```

- [ ] **Step 3: Use new fields in pre_flight_check and system prompt**

In the `pre_flight_check` case, use direction-aware mapping counts:

```js
case 'pre_flight_check': {
  const blockers = [];
  const warnings = [];
  const isRunning = live || c2g_live || cl2g_live;
  if (isRunning) { blockers.push('Migration already running'); break; }
  if (!migDir) { blockers.push('No migration direction selected'); break; }
  if (migDir === 'claude-gemini' || migDir === 'gemini-copilot') {
    if (!googleAuthed) blockers.push('Google Workspace not connected');
  }
  if (migDir === 'gemini-copilot' || migDir === 'copilot-gemini') {
    if (!msAuthed) blockers.push('Microsoft 365 not connected');
  }
  if ((migDir === 'claude-gemini' || migDir === 'gemini-copilot') && !uploadData) {
    blockers.push('No file uploaded yet');
  }
  const effectiveMappings = migDir === 'copilot-gemini' ? c2g_mappings_count
    : migDir === 'claude-gemini' ? cl2g_mappings_count
    : mappings_count;
  if (effectiveMappings === 0) blockers.push('No users mapped');
  result = JSON.stringify({ blockers, warnings, ready: blockers.length === 0 });
  break;
}
```

- [ ] **Step 4: Add direction-aware context to system prompt**

In the system prompt string, add after the existing stats line:

```js
- C2G mapped users: ${c2g_mappings_count}
- CL2G upload users: ${cl2g_upload_users}, mapped: ${cl2g_mappings_count}
- C2G done: ${c2g_done}, CL2G done: ${cl2g_done}
```

- [ ] **Step 5: Commit**

```bash
git add src/modules/g2c/routes.js ui/index.html
git commit -m "feat(agent): pass full direction-aware state to backend for pre-flight and chip generation"
```

---

## Task 6: Verify Full Chat-Driven Migration Flow

No code changes — manual test checklist.

- [ ] **Step 1: Test chat-only CL2G flow**

Start server: `node server.js`
Open `http://localhost:4000`, sign in.

In chat, type: *"I want to migrate Claude to Google Drive"*
Expected: agent selects `claude-gemini`, left panel jumps to step 2.

- [ ] **Step 2: Test auto-map via chat**

Upload a Claude ZIP in the left panel.
Expected: agent fires notification "X users found. Want me to auto-map?"
Tap `Yes, auto-map` chip.
Expected: mapping table in left panel fills in, agent reports match count.

- [ ] **Step 3: Test start migration via chat**

Type: *"start a dry run"*
Expected: agent runs `pre_flight_check`, then `start_migration(dryRun: true)`, left panel shows progress.

- [ ] **Step 4: Test left-panel-driven flow still works**

Click through entire migration manually without using chat.
Expected: agent updates guide messages on each step, no interference with left panel.

- [ ] **Step 5: Test running mode silence**

Start a migration. During run, type a question in chat.
Expected: agent answers the question, does not navigate or interfere.

- [ ] **Step 6: Test pre-flight blocking**

Type *"start migration"* with no users mapped.
Expected: agent says "No users mapped" and explains next step.

- [ ] **Step 7: Final commit**

```bash
git add .
git commit -m "test: verify agentic chat migration end-to-end"
```
