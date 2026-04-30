# Agent Chat Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken auto-trigger agent with a page-aware guide that tells users what to do on each step, answers questions, and gives post-migration setup instructions without ever controlling the left panel.

**Architecture:** Add `agentMode` state (`guide`|`running`|`done`) to the App component. A single `useEffect` fires a static guide message when mode is `guide` and step/direction changes. Remove all scattered auto-trigger useEffects and the `navigate_to_step`/`start_migration`/`retry_failed` tools. Add `show_post_migration_guide` tool on the backend that returns direction-specific setup steps.

**Tech Stack:** React (inline JSX in index.html), Node.js/Express backend in `src/modules/g2c/routes.js`, SSE for migration events.

---

## Files

- **Modify:** `ui/index.html` — remove auto-triggers, add agentMode state, STEP_GUIDE table, single guide useEffect, PostMigrationWidget component
- **Modify:** `src/modules/g2c/routes.js` — remove 3 tools, add show_post_migration_guide tool + handler, update system prompt

---

### Task 1: Remove auto-trigger useEffects from ui/index.html

**Files:**
- Modify: `ui/index.html` lines ~2486–2549

- [ ] **Step 1: Remove the step-change auto-trigger useEffect**

Find and delete this entire block (lines ~2486–2517):
```js
// ── Bidirectional sync: Steps panel events → Agent ──────────────────────────
const prevStepRef=useRef(null);
useEffect(()=>{
  if(!wsLoaded)return;
  if(prevStepRef.current===null){prevStepRef.current=step;return;}
  if(prevStepRef.current===step)return;
  prevStepRef.current=step;
  const gc=[...];
  const c2g=[...];
  const triggers=migDir==='copilot-gemini'?c2g:gc;
  const msg=triggers[step];
  if(msg)sendToAgent(msg,true);
},[step,wsLoaded,migDir,uploadData,mappings,options]);
```

- [ ] **Step 2: Remove Google auth auto-trigger useEffect**

Find and delete this block (lines ~2519–2527):
```js
// Google auth → agent
const prevGoogleRef=useRef(null);
useEffect(()=>{
  if(!wsLoaded)return;
  if(prevGoogleRef.current===null){prevGoogleRef.current=googleAuthed;return;}
  if(prevGoogleRef.current===googleAuthed)return;
  prevGoogleRef.current=googleAuthed;
  if(googleAuthed)sendToAgent(`Google Workspace connected...`,true);
},[googleAuthed,wsLoaded]);
```

- [ ] **Step 3: Remove Microsoft auth auto-trigger useEffect**

Find and delete this block (lines ~2529–2538):
```js
// Microsoft auth → agent
const prevMsRef=useRef(null);
useEffect(()=>{
  if(!wsLoaded)return;
  if(prevMsRef.current===null){prevMsRef.current=msAuthed;return;}
  if(prevMsRef.current===msAuthed)return;
  prevMsRef.current=msAuthed;
  if(msAuthed&&googleAuthed)sendToAgent('Both clouds are connected...',true);
  else if(msAuthed)sendToAgent('Microsoft 365 connected...',true);
},[msAuthed,wsLoaded]);
```

- [ ] **Step 4: Remove data-loaded auto-trigger useEffect**

Find and delete this block (lines ~2540–2549):
```js
// Data loaded → agent
const prevUploadRef=useRef(null);
useEffect(()=>{
  if(!wsLoaded)return;
  const id=uploadData?.id||null;
  if(prevUploadRef.current===null){prevUploadRef.current=id;return;}
  if(prevUploadRef.current===id)return;
  prevUploadRef.current=id;
  if(uploadData)sendToAgent(`Data loaded: ...`,true);
},[uploadData,wsLoaded]);
```

- [ ] **Step 5: Remove SSE milestone hardcoded messages**

In the `runMigration` function, find and delete these two milestone blocks:
```js
if(d.type==='info'&&d.message.includes('Processing:')&&!gcMilestones.firstUser){
  gcMilestones.firstUser=true;
  setTimeout(()=>addAgentMsg('bot','First user being processed — migration is underway.'),200);
}
if((d.type==='error'||d.type==='warn')&&!gcMilestones.firstError){
  gcMilestones.firstError=true;
  setTimeout(()=>addAgentMsg('bot','Hit an issue with one item — migration continues with the rest. I\'ll summarize at the end.'),200);
}
```

Also delete `const gcMilestones={firstUser:false,firstError:false};` on the line above the SSE handler.

- [ ] **Step 6: Remove SSE milestone messages from runC2GMigration**

In `runC2GMigration`, find and delete the equivalent milestone blocks (lines ~2725–2730):
```js
if(d.type==='info'&&d.message.includes('Processing:')&&!c2gMilestones.firstUser){
  c2gMilestones.firstUser=true;
  setTimeout(()=>addAgentMsg('bot','First user being processed — migration is underway.'),200);
}
if((d.type==='error'||d.type==='warn')&&!c2gMilestones.firstError){
  c2gMilestones.firstError=true;
  setTimeout(()=>addAgentMsg('bot','Hit an issue with one item...'),200);
}
```
Also delete `const c2gMilestones={firstUser:false,firstError:false};`.

- [ ] **Step 7: Remove initial greeting useEffect that calls sendToAgent with LLM**

Find and delete (lines ~2987–2994):
```js
useEffect(()=>{
  if(!wsLoaded||greetedRef.current)return;
  greetedRef.current=true;
  if(agentMsgs.length===0){
    sendToAgentRef.current('The user just opened CloudFuze GEM. Greet them briefly...',true);
  }
},[wsLoaded]);
```

- [ ] **Step 8: Commit**

```bash
git add ui/index.html
git commit -m "refactor(agent): remove all auto-trigger useEffects and SSE milestone messages"
```

---

### Task 2: Add agentMode state and STEP_GUIDE lookup table

**Files:**
- Modify: `ui/index.html` — App component state declarations (~line 2350)

- [ ] **Step 1: Add agentMode state after the agentMsgs state declaration**

Find:
```js
const [agentMsgs,setAgentMsgs]=useState(()=>lsGet(K.agentMsgs,[]));
const [agentTyping,setAgentTyping]=useState(false);
const [agentInput,setAgentInput]=useState('');
```

Replace with:
```js
const [agentMsgs,setAgentMsgs]=useState(()=>lsGet(K.agentMsgs,[]));
const [agentTyping,setAgentTyping]=useState(false);
const [agentInput,setAgentInput]=useState('');
const [agentMode,setAgentMode]=useState('guide'); // 'guide' | 'running' | 'done'
```

- [ ] **Step 2: Add STEP_GUIDE lookup table near the top of the file, after the PHASE_LABELS constant (~line 1040)**

Find:
```js
const PHASE_LABELS=['Connect Clouds','Import Data','Map Users','Configure','Migrate','Complete'];
```

Add after it:
```js
const STEP_GUIDE={
  'any':{
    0:"Connect your cloud accounts. Google Workspace and Microsoft 365 are needed for Gemini↔Copilot migration. Only Google is needed for Claude → Gemini.",
    1:"Choose your migration direction. Gemini→Copilot and Copilot→Gemini require both accounts connected.",
  },
  'gemini-copilot':{
    2:"Import your Gemini data — upload a Vault ZIP or export directly from Google Drive.",
    3:"Map each Google user to their Microsoft 365 destination. Use Auto-map to fill matches by email, then review.",
    4:"All set. Start with a dry run first to preview — no data changes until you go live.",
  },
  'copilot-gemini':{
    2:"Map each Microsoft 365 user to their Google Drive destination. Use Auto-map to fill matches by email, then review.",
    3:"Set the folder name and date range. Starting with a dry run is strongly recommended.",
  },
  'claude-gemini':{
    2:"Upload your Claude export ZIP. You can export it from Claude.ai → Settings → Data Export.",
    3:"Map each Claude user to their Google destination email. Auto-map fills by email match.",
    4:"Set the Google Drive folder name where files will land. Start with a dry run to preview first.",
  },
};

function getStepGuide(step, migDir){
  if(step<=1) return STEP_GUIDE['any'][step]||null;
  return (STEP_GUIDE[migDir]||{})[step]||null;
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): add agentMode state and STEP_GUIDE lookup table"
```

---

### Task 3: Add mode transition logic and single guide useEffect

**Files:**
- Modify: `ui/index.html` — after the removed useEffects, and in runMigration/runC2GMigration/runCL2GMigration

- [ ] **Step 1: Add guide useEffect after the removed auto-trigger blocks**

In the App component, after the `sendToAgentRef.current=sendToAgent;` line (~line 2933), add:

```js
// ── Page-aware guide: fires one message per step in guide mode ───────────────
const prevGuideKeyRef=useRef(null);
useEffect(()=>{
  if(!wsLoaded||agentMode!=='guide')return;
  const key=`${step}:${migDir||'none'}`;
  if(prevGuideKeyRef.current===key)return;
  prevGuideKeyRef.current=key;
  const msg=getStepGuide(step,migDir);
  if(msg)addAgentMsg('bot',msg);
},[wsLoaded,agentMode,step,migDir]);
```

- [ ] **Step 2: Set agentMode to 'running' when G2C migration starts**

In `runMigration`, find:
```js
addAgentMsg('bot',isDry?'Dry run started — no changes will be made. I\'ll let you know what happens.':'Migration started! I\'ll check in as we go.');
setLive(true);
```

Replace with:
```js
setAgentMode('running');
setLive(true);
```

- [ ] **Step 3: Set agentMode to 'done' when G2C migration finishes**

In the G2C SSE `done` handler, find:
```js
sseRef.current.close();setLive(false);setMigDone(true);setRetrying(false);setStep(6);
setReportRefreshKey(p=>p+1);
const s={...curStats};
setTimeout(()=>addAgentMsg('bot',
  s.errors>0
    ? `Migration finished with **${s.errors} error${s.errors!==1?'s':''}**. The items below failed — retry to recover them.`
    : `All done! **${s.pages} pages** migrated across **${s.users} user${s.users!==1?'s':''}**. Everything looks clean.`,
  {statusCard:{users:s.users,files:s.pages,errors:s.errors},
   quickReplies:s.errors>0?['Retry Failed','Download Report','Start Another']:['Download Report','Start Another']}
),600);
```

Replace with:
```js
sseRef.current.close();setLive(false);setMigDone(true);setRetrying(false);setStep(6);
setReportRefreshKey(p=>p+1);
setAgentMode('done');
const s={...curStats};
setTimeout(()=>addAgentMsg('bot',
  s.errors>0
    ? `Migration finished with **${s.errors} error${s.errors!==1?'s':''}**. The items below failed — retry to recover them.`
    : `All done! **${s.pages} pages** migrated across **${s.users} user${s.users!==1?'s':''}**. Everything looks clean.`,
  {statusCard:{users:s.users,files:s.pages,errors:s.errors},
   quickReplies:s.errors>0?['Retry Failed','Download Report','Start Another']:['Download Report','What do I do next?','Start Another']}
),600);
```

- [ ] **Step 4: Set agentMode to 'running' when C2G migration starts**

In `runC2GMigration`, find:
```js
addAgentMsg('bot',isDry?'Dry run started — no files will be uploaded. I\'ll show you what would be migrated.':'Copilot → Gemini migration started! I\'ll check in as we go.');
```

Replace with:
```js
setAgentMode('running');
```

- [ ] **Step 5: Set agentMode to 'done' when C2G migration finishes**

In C2G SSE `done` handler, find:
```js
sseRef.current.close();setC2gLive(false);setC2gDone(true);setStep(5);
```

Replace with:
```js
sseRef.current.close();setC2gLive(false);setC2gDone(true);setStep(5);
setAgentMode('done');
const cs={...curStats};
setTimeout(()=>addAgentMsg('bot',
  cs.errors>0
    ? `Migration finished with **${cs.errors} error${cs.errors!==1?'s':''}**. Retry to recover failed items.`
    : `All done! **${cs.files} files** uploaded for **${cs.users} user${cs.users!==1?'s':''}**.`,
  {statusCard:{users:cs.users,files:cs.files,errors:cs.errors},
   quickReplies:cs.errors>0?['Retry Failed','Download Report','Start Another']:['Download Report','What do I do next?','Start Another']}
),600);
```

Note: In C2G you need to capture stats before the done block. Look for where `curStats` is tracked in `runC2GMigration` and use the same pattern (it uses `curStats` object updated via SSE events).

- [ ] **Step 6: Set agentMode to 'running'/'done' for CL2G migration**

In `runCL2GMigration`, find the start message:
```js
addAgentMsg('bot',isDry?'Dry run started — no files will be uploaded...':'Claude → Gemini migration started!...');
```
Replace with: `setAgentMode('running');`

In CL2G SSE `done` handler, find:
```js
setCl2gLive(false);cl2gLiveRef.current=false;setCl2gDone(true);setStep(6);
```
Replace with:
```js
setCl2gLive(false);cl2gLiveRef.current=false;setCl2gDone(true);setStep(6);
setAgentMode('done');
const cls={...curStats};
setTimeout(()=>addAgentMsg('bot',
  cls.errors>0
    ? `Migration finished with **${cls.errors} error${cls.errors!==1?'s':''}**. Retry to recover failed items.`
    : `All done! **${cls.files} files** uploaded for **${cls.users} user${cls.users!==1?'s':''}**.`,
  {statusCard:{users:cls.users,files:cls.files,errors:cls.errors},
   quickReplies:cls.errors>0?['Retry Failed','Download Report','Start Another']:['Download Report','What do I do next?','Start Another']}
),600);
```

- [ ] **Step 7: Reset agentMode to 'guide' on "Start Another" / "New Migration"**

In `runAnotherBatch`, at the start of the function body add:
```js
setAgentMode('guide');
prevGuideKeyRef.current=null;
```

In `handleChangeDirection`, add the same two lines.

Also in the `retryFailed` function (or wherever retry is triggered), add:
```js
setAgentMode('running');
```

- [ ] **Step 8: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): add agentMode transitions and single guide useEffect"
```

---

### Task 4: Remove navigate_to_step, start_migration, retry_failed tools from backend

**Files:**
- Modify: `src/modules/g2c/routes.js` lines 37–126

- [ ] **Step 1: Remove navigate_to_step tool from AGENT_TOOLS array**

In `AGENT_TOOLS`, delete the entire object:
```js
{
  type: 'function',
  function: {
    name: 'navigate_to_step',
    ...
  }
},
```

- [ ] **Step 2: Remove start_migration tool from AGENT_TOOLS array**

Delete:
```js
{
  type: 'function',
  function: {
    name: 'start_migration',
    ...
  }
},
```

- [ ] **Step 3: Remove retry_failed tool from AGENT_TOOLS array**

Delete:
```js
{
  type: 'function',
  function: {
    name: 'retry_failed',
    ...
  }
},
```

- [ ] **Step 4: Remove their case handlers in the tool dispatch switch**

In the tool dispatch switch (~lines 1069–1090), delete:
```js
case 'navigate_to_step': { ... break; }
case 'start_migration': { ... break; }
case 'retry_failed': { ... break; }
```

- [ ] **Step 5: Remove navigate/action references in the response payload**

Find:
```js
if(data.navigate!=null&&!live&&!c2gLive&&!migDone)setStep(data.navigate);
if(data.action==='start_migration_dry'){...}
else if(data.action==='start_migration_live'){...}
else if(data.action==='retry_failed')retryFailed();
```
In `ui/index.html` (~line 2905), delete those lines. Keep only:
```js
else if(data.action==='show_reports')setShowReports(true);
else if(data.action==='show_mapping')setLeftMode('mapping');
```

Also remove `navigateToStep` and `actionToExecute` variables and their references in the backend route (keep only `show_reports` and `show_mapping` actions).

- [ ] **Step 6: Commit**

```bash
git add src/modules/g2c/routes.js ui/index.html
git commit -m "refactor(agent): remove navigate/start_migration/retry_failed tools"
```

---

### Task 5: Add show_post_migration_guide tool to backend

**Files:**
- Modify: `src/modules/g2c/routes.js`

- [ ] **Step 1: Add show_post_migration_guide to AGENT_TOOLS array**

After the `show_status_card` tool object, add:
```js
{
  type: 'function',
  function: {
    name: 'show_post_migration_guide',
    description: 'Show post-migration setup instructions. Call when user asks "what do I do next?", "how do I set up the Gem?", "where is my Copilot agent?", or clicks "What do I do next?"',
    parameters: { type: 'object', properties: {}, required: [] }
  }
}
```

- [ ] **Step 2: Add case handler in the tool dispatch switch**

In the switch, add:
```js
case 'show_post_migration_guide': {
  result = JSON.stringify({ execute: 'show_post_migration_guide', migDir });
  break;
}
```

- [ ] **Step 3: Pass migDir into the switch context**

The `migDir` variable is already in scope from `migrationState` destructuring at the top of the route handler. Confirm it's destructured:
```js
const { step=0, migDir=null, live=false, migDone=false, ... } = migrationState;
```
If `migDir` is not already there, add it.

- [ ] **Step 4: Add show_post_migration_guide to the response payload**

After:
```js
if (actionToExecute) payload.action = actionToExecute;
```
Add handling so when `actionToExecute === 'show_post_migration_guide'` the payload includes the migDir:
```js
if (actionToExecute === 'show_post_migration_guide') {
  payload.action = 'show_post_migration_guide';
  payload.migDir = migDir;
}
```

- [ ] **Step 5: Update system prompt to mention the tool**

In the system prompt string, find:
```
You CAN take real actions via tools: navigate steps, start migration, retry, show reports, show mapping, show_status_card.
```
Replace with:
```
You CAN take real actions via tools: show reports, show mapping, show_status_card, show_post_migration_guide.
When the user asks what to do after migration is complete, call show_post_migration_guide.
Never suggest navigating to a step or starting a migration — the user controls that.
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/g2c/routes.js
git commit -m "feat(agent): add show_post_migration_guide tool to backend"
```

---

### Task 6: Add PostMigrationWidget component and wire frontend action

**Files:**
- Modify: `ui/index.html` — add component near GemSetupInstructions (~line 2007), wire in sendToAgent handler

- [ ] **Step 1: Add PostMigrationWidget component**

After the `GemSetupInstructions` component (after line ~2059), add:

```js
/* Post-migration inline chat widget */
const PostMigrationWidget=({migDir})=>{
  const [copied,setCopied]=useState(false);
  const copy=()=>{navigator.clipboard.writeText(GEM_INSTRUCTIONS).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2500)}).catch(()=>{})};

  if(migDir==='gemini-copilot'){
    return(
      <div style={{borderRadius:10,border:'1px solid #e2e8f0',padding:'14px 16px',marginTop:8,background:'#f8fafc'}}>
        <div style={{fontSize:12,fontWeight:700,color:'#0129AC',marginBottom:10}}>✅ What happens next</div>
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {[
            {n:1,text:'Users open Microsoft Copilot or Teams'},
            {n:2,text:'The CloudFuze agent is already pinned in their sidebar'},
            {n:3,text:'All migrated conversations are accessible — no install needed'},
          ].map(s=>(
            <div key={s.n} style={{display:'flex',gap:10,alignItems:'flex-start'}}>
              <div style={{minWidth:22,height:22,borderRadius:'50%',background:'#0129AC',color:'white',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,flexShrink:0}}>{s.n}</div>
              <div style={{fontSize:12,color:'#1e293b',paddingTop:3}}>{s.text}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // copilot-gemini and claude-gemini both use Gem setup
  const steps=[
    {n:1,icon:'🌐',title:'Open Gemini Gems',desc:'Go to gemini.google.com → click Gems in the left sidebar → New Gem'},
    {n:2,icon:'📁',title:'Add Knowledge from Google Drive',desc:`Under Knowledge, click "Add from Google Drive" → navigate to your migrated folder → select it → Insert`},
    {n:3,icon:'📋',title:'Paste the Gem Instructions',desc:'Copy the instructions below and paste them into the Instructions box'},
    {n:4,icon:'💾',title:'Name & Save the Gem',desc:'Give the Gem a name → click Save'},
  ];
  return(
    <div style={{borderRadius:10,border:'1px solid #BFDBFE',padding:'14px 16px',marginTop:8,background:'#EFF6FF'}}>
      <div style={{fontSize:12,fontWeight:700,color:'#1E3A5F',marginBottom:10}}>💎 Set Up Your Gemini Gem</div>
      <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:12}}>
        {steps.map(s=>(
          <div key={s.n} style={{display:'flex',gap:10,alignItems:'flex-start',background:'white',borderRadius:8,padding:'8px 12px',border:'1px solid #DBEAFE'}}>
            <div style={{minWidth:24,height:24,borderRadius:'50%',background:'#1D4ED8',color:'white',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,flexShrink:0}}>{s.n}</div>
            <div>
              <div style={{fontSize:12,fontWeight:600,color:'#1E3A5F'}}>{s.icon} {s.title}</div>
              <div style={{fontSize:11,color:'#4B5563',lineHeight:1.5}}>{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{background:'white',border:'1px solid #BFDBFE',borderRadius:8,overflow:'hidden'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'6px 10px',background:'#DBEAFE'}}>
          <span style={{fontSize:11,fontWeight:700,color:'#1E40AF'}}>📋 Gem Instructions</span>
          <button onClick={copy} style={{fontSize:11,fontWeight:600,color:copied?'#16a34a':'#1D4ED8',background:copied?'#DCFCE7':'#EFF6FF',border:`1px solid ${copied?'#86EFAC':'#93C5FD'}`,borderRadius:6,padding:'3px 8px',cursor:'pointer',fontFamily:'inherit'}}>
            {copied?'✓ Copied':'Copy'}
          </button>
        </div>
        <pre style={{margin:0,padding:'10px 12px',fontSize:11,lineHeight:1.5,color:'#1E293B',whiteSpace:'pre-wrap',wordBreak:'break-word',fontFamily:'Consolas,monospace',maxHeight:160,overflowY:'auto'}}>{GEM_INSTRUCTIONS}</pre>
      </div>
      <div style={{marginTop:8,padding:'7px 10px',background:'#FEF9C3',border:'1px solid #FDE68A',borderRadius:7,fontSize:11,color:'#713F12'}}>
        <strong>Tip:</strong> Add all migrated files (conversations, memory, projects) to the Gem for best results.
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Wire the show_post_migration_guide action in sendToAgent**

In `sendToAgent`, find:
```js
else if(data.action==='show_mapping')setLeftMode('mapping');
```

Add after it:
```js
else if(data.action==='show_post_migration_guide'){
  addAgentMsg('bot','Here are your next steps:',{widget:{type:'post_migration_guide',migDir:data.migDir||migDir}});
}
```

- [ ] **Step 3: Register post_migration_guide in ChatWidget**

Find the `ChatWidget` component (~line 1091):
```js
const ChatWidget=({type,widgetProps={}})=>{
```

Add the new case inside it. Find where it renders based on type and add:
```js
if(type==='post_migration_guide') return <PostMigrationWidget migDir={widgetProps.migDir}/>;
```

- [ ] **Step 4: Handle "What do I do next?" quick reply**

In `handleAgentQuickReply`, find the `else` at the bottom:
```js
else{sendToAgent(qr);}
```

Add before it:
```js
else if(qr==='What do I do next?'){sendToAgent('What do I do next after the migration is complete?');}
```

- [ ] **Step 5: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): add PostMigrationWidget and wire show_post_migration_guide action"
```

---

### Task 7: Fix initial greeting and handle page-refresh state recovery

**Files:**
- Modify: `ui/index.html`

- [ ] **Step 1: Add static greeting on wsLoaded instead of LLM call**

Where the old LLM greeting useEffect was (~line 2987), add a static greeting:
```js
useEffect(()=>{
  if(!wsLoaded||greetedRef.current)return;
  greetedRef.current=true;
  if(agentMsgs.length===0){
    const msg=getStepGuide(step,migDir)||"Welcome to CloudFuze GEM. Connect your cloud accounts on the left to get started.";
    addAgentMsg('bot',msg);
  }
},[wsLoaded]);
```

- [ ] **Step 2: Restore correct agentMode on page refresh**

In the state recovery useEffect (~line 2552), find where `migDone` and `live` are restored. After setting them, add mode recovery:
```js
// After the existing state restoration:
if(savedDone) setAgentMode('done');
else if(/* live was true */ false) setAgentMode('running'); // live state is not persisted, stays guide
else setAgentMode('guide');
```

Actually: `live` is not persisted (SSE connection lost on refresh), so on refresh if `migDone=true` set mode to `done`, otherwise `guide`:
```js
useEffect(()=>{
  const savedDone=lsGet(K.migDone,false);
  if(savedDone) setAgentMode('done');
},[]);
```
Add this as a one-time effect near the other state-recovery effects.

- [ ] **Step 3: Commit**

```bash
git add ui/index.html
git commit -m "feat(agent): static greeting on load, restore agentMode on refresh"
```

---

### Task 8: Update sendToAgent to pass agentMode to backend

**Files:**
- Modify: `ui/index.html` — sendToAgent function

- [ ] **Step 1: Include agentMode in the migration state payload**

In `sendToAgent`, find the `migrationState` object in the fetch body:
```js
migrationState:{step,migDir,live,migDone,stats,lastRunWasDry,currentBatchId,
  uploadData:...,
  googleAuthed,msAuthed,
  mappings_count:...,
  selected_users_count:...,
  options:{...}}
```

Add `agentMode`:
```js
migrationState:{step,migDir,live,migDone,stats,lastRunWasDry,currentBatchId,agentMode,
  uploadData:...,
  googleAuthed,msAuthed,
  mappings_count:...,
  selected_users_count:...,
  options:{...}}
```

- [ ] **Step 2: Use agentMode in the backend system prompt**

In `src/modules/g2c/routes.js`, in the route handler destructure `agentMode`:
```js
const { step=0, migDir=null, live=false, migDone=false, stats={}, lastRunWasDry=false,
  agentMode='guide', uploadData=null, ... } = migrationState;
```

In the system prompt, add a mode-awareness line:
```js
const systemPrompt = `You are the CloudFuze Migration Agent...

Current migration state:
- Agent mode: ${agentMode} (guide=helping user through steps, running=migration active, done=migration finished)
...
${agentMode==='running'?'Migration is currently running. Answer questions about progress from the logs above. Do not suggest navigating anywhere.':''}
${agentMode==='done'?'Migration is complete. If user asks what to do next, call show_post_migration_guide.':''}
`;
```

- [ ] **Step 3: Commit**

```bash
git add ui/index.html src/modules/g2c/routes.js
git commit -m "feat(agent): pass agentMode to backend, use in system prompt"
```

---

### Task 9: Manual smoke test

- [ ] **Step 1: Start the server**
```bash
npm start
```

- [ ] **Step 2: Test guide mode — Gemini → Copilot flow**
- Open app, confirm agent shows step 0 guide message (connect accounts)
- Click through to step 1 — confirm "Choose your direction" message appears
- Select Gemini → Copilot, confirm step 2 message (import data)
- Go back to step 1 — confirm step 1 message reappears (no loop, no duplicate)
- Go forward to step 2 again — confirm step 2 message reappears

- [ ] **Step 3: Test that agent does NOT navigate left panel**
- Type "go to step 3" in chat — agent should advise, not move the panel
- Type "start migration" in chat — agent should advise, not start it

- [ ] **Step 4: Test running mode**
- Start a dry run — confirm NO auto-messages fire during migration
- Ask "how many users processed?" — agent should answer from logs

- [ ] **Step 5: Test done mode**
- Complete dry run — confirm ONE summary message with stats + quick replies
- Click "What do I do next?" — confirm PostMigrationWidget appears inline

- [ ] **Step 6: Test "Start Another" resets correctly**
- After done, click "Start Another" — confirm guide message for step 1 appears
- Confirm previous chat history still visible above

- [ ] **Step 7: Test Copilot → Gemini flow**
- Select C2G direction — confirm step 2 message is the mapping-focused one (not import data)
- Complete migration — confirm "What do I do next?" shows Gem setup widget

- [ ] **Step 8: Test Claude → Gemini flow**
- Select CL2G — confirm step 2 message is about uploading ZIP
- Complete migration — confirm Gem setup widget appears

- [ ] **Step 9: Final commit**
```bash
git add ui/index.html src/modules/g2c/routes.js
git commit -m "test(agent): smoke tested all 3 migration directions and edge cases"
```
