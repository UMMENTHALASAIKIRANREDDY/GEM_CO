// src/agent/agentLoop.js
import { callAI } from './callAI.js';
import { AGENT_TOOLS, DESTRUCTIVE_TOOLS, CONFIRMATION_MESSAGES } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { loadHistory, saveHistory } from './conversationHistory.js';
import { executeTool } from './toolExecutor.js';
import { getLogger } from '../utils/logger.js';
import { auditLog } from './auditLogger.js';

const logger = getLogger('agent:loop');
const MAX_ITERATIONS = 8;

function defaultChips(migrationState) {
  const { step = 0, migDir, googleAuthed = false, msAuthed = false,
    mappings_count = 0, c2g_mappings_count = 0, cl2g_mappings_count = 0,
    cl2g_upload_users = 0, uploadData = null,
    migDone = false, c2g_done = false, cl2g_done = false,
    lastRunWasDry = false, c2gLastDry = false, cl2gLastDry = false,
    stats = {}, c2g_stats = {}, cl2g_stats = {} } = migrationState ?? {};

  const dryRunDone = migDir === 'copilot-gemini' ? (c2g_done && c2gLastDry)
    : migDir === 'claude-gemini' ? (cl2g_done && cl2gLastDry)
    : (migDone && lastRunWasDry);
  const activeErrors = (migDir === 'copilot-gemini' ? c2g_stats : migDir === 'claude-gemini' ? cl2g_stats : stats).errors ?? 0;

  // No direction yet — guide toward picking one
  if (!migDir) {
    if (!googleAuthed && !msAuthed) return [
      'Migrate Google Workspace → Microsoft 365',
      'Migrate Claude AI → Google Workspace',
      'Help me choose the right migration',
    ];
    if (googleAuthed && !msAuthed) return [
      'Migrate Claude AI → Google Workspace',
      'Connect Microsoft 365 to unlock more migrations',
    ];
    if (googleAuthed && msAuthed) return [
      'Migrate Google Workspace → Microsoft 365',
      'Migrate Microsoft 365 → Google Workspace',
      'Migrate Claude AI → Google Workspace',
    ];
    return ['Help me pick the right migration path'];
  }

  // Auth missing — guide to connect what's needed
  const needsGoogle = ['gemini-copilot', 'copilot-gemini', 'claude-gemini'].includes(migDir);
  const needsMs = ['gemini-copilot', 'copilot-gemini'].includes(migDir);
  const missingGoogle = needsGoogle && !googleAuthed;
  const missingMs = needsMs && !msAuthed;
  if (missingGoogle && missingMs) return [
    'Connect Google Workspace first',
    'Connect Microsoft 365 first',
    'Tell me what each connection does',
  ];
  if (missingGoogle) return [
    'Connect Google Workspace to continue',
    'Explain why Google Workspace is needed',
  ];
  if (missingMs) return [
    'Connect Microsoft 365 to continue',
    'Explain why Microsoft 365 is needed',
  ];

  // Direction-specific chips — action-forward, no generic questions
  if (migDir === 'gemini-copilot') {
    if (step <= 1) return [
      'Take me to the Import Data step',
      'What data gets migrated?',
    ];
    if (step === 2) return uploadData
      ? [`${uploadData.total_users} users imported — map them now`, 'Show me what was imported']
      : ['How do I export my Google Workspace data?', 'I have a Vault ZIP ready to upload'];
    if (step === 3) return mappings_count === 0
      ? ['Auto-map all users by email now', 'Why do I need to map users?']
      : [`${mappings_count} users mapped — take me to Options`, 'Add more mappings manually'];
    if (step === 4) return dryRunDone
      ? ['Run the live migration now', 'What happened in the dry run?']
      : ['Run a dry run first — safe preview', 'I understand the risk — go live now'];
    if (migDone) return dryRunDone
      ? activeErrors > 0
        ? ['Retry failed users, then go live', 'Skip errors and run live migration', 'Download dry run report']
        : ['Everything looks good — start live migration', 'Download dry run report']
      : activeErrors > 0
        ? ['Retry the failed items now', 'Download report with error details']
        : ['Download the migration report', 'Migrate another set of users'];
  }

  if (migDir === 'copilot-gemini') {
    if (step <= 1) return ['Take me to Map Users', 'What data gets migrated?'];
    if (step === 2) return c2g_mappings_count === 0
      ? ['Auto-map all users by email now', 'Why do I need to map users?']
      : [`${c2g_mappings_count} users mapped — take me to Options`, 'Add more mappings manually'];
    if (step === 3) return dryRunDone
      ? ['Run the live migration now', 'What happened in the dry run?']
      : ['Run a dry run first — safe preview', 'I understand the risk — go live now'];
    if (c2g_done) return dryRunDone
      ? activeErrors > 0
        ? ['Retry failed users, then go live', 'Skip errors and run live migration', 'Download dry run report']
        : ['Everything looks good — start live migration', 'Download dry run report']
      : activeErrors > 0
        ? ['Retry the failed items now', 'Download report with error details']
        : ['Download the migration report', 'Migrate another set of users'];
  }

  if (migDir === 'claude-gemini') {
    if (step <= 1) return [
      'Take me to the Upload step',
      'How do I export my Claude conversations?',
    ];
    if (step === 2) return cl2g_upload_users > 0
      ? [`${cl2g_upload_users} users loaded — map them now`, 'Show me the conversation count']
      : ['Show me how to export from Claude.ai step by step', 'I have the ZIP — take me to the upload area'];
    if (step === 3) return cl2g_mappings_count === 0
      ? ['Auto-map all users by email now', 'Why do I need to map users?']
      : [`${cl2g_mappings_count} users mapped — take me to Options`, 'Add more mappings manually'];
    if (step === 4) return dryRunDone
      ? ['Run the live migration now', 'What happened in the dry run?']
      : ['Run a dry run first — safe preview', 'I understand the risk — go live now'];
    if (cl2g_done) return dryRunDone
      ? activeErrors > 0
        ? ['Retry failed users, then go live', 'Skip errors and run live migration', 'Download dry run report']
        : ['Everything looks good — start live migration', 'Download dry run report']
      : activeErrors > 0
        ? ['Retry the failed items now', 'Download report with error details']
        : ['Download the migration report', 'Migrate another set of users'];
  }

  return ['Show me the current migration status', 'What do I need to do next?'];
}

function buildStepContextInstruction(state) {
  const { step = 0, migDir, googleAuthed = false, msAuthed = false,
    uploadData = null, mappings_count = 0, c2g_mappings_count = 0,
    cl2g_upload_users = 0, cl2g_mappings_count = 0,
    migDone = false, c2g_done = false, cl2g_done = false,
    lastRunWasDry = false, c2gLastDry = false, cl2gLastDry = false } = state ?? {};

  const dryRunDone = (migDir === 'copilot-gemini' ? c2g_done && c2gLastDry
    : migDir === 'claude-gemini' ? cl2g_done && cl2gLastDry
    : migDone && lastRunWasDry);

  const needsGoogle = migDir && (migDir === 'gemini-copilot' || migDir === 'copilot-gemini' || migDir === 'claude-gemini');
  const needsMs = migDir && (migDir === 'gemini-copilot' || migDir === 'copilot-gemini');
  const missingGoogle = needsGoogle && !googleAuthed;
  const missingMs = needsMs && !msAuthed;

  // Auth missing — agent must redirect immediately
  if (migDir && step >= 2 && (missingGoogle || missingMs)) {
    const missing = [missingGoogle && 'Google Workspace', missingMs && 'Microsoft 365'].filter(Boolean).join(' and ');
    return `\n\n[AUTO CONTEXT — AUTH GATE] User is at step ${step} with direction "${migDir}" but ${missing} is NOT connected. You MUST: (1) call navigate_to_step with step=0, (2) tell them which account(s) to connect and why. Be direct: "You need to connect X first." Do not proceed with the current step.`;
  }

  if (!migDir) {
    return `\n\n[AUTO CONTEXT] User hasn't selected a direction yet. Google: ${googleAuthed ? 'connected' : 'not connected'}. MS365: ${msAuthed ? 'connected' : 'not connected'}. Tell them what options are available based on their connected accounts. Be brief and specific.`;
  }

  if (step === 0) return `\n\n[AUTO CONTEXT] User is on Connect Clouds. Direction: ${migDir}. Google: ${googleAuthed ? '✓' : '✗'}. MS365: ${msAuthed ? '✓' : '✗'}. Tell them exactly which button to click next. 1 sentence max.`;
  if (step === 1) return `\n\n[AUTO CONTEXT] User is choosing direction. Direction "${migDir}" is already selected. Tell them to confirm or change it. 1 sentence.`;

  if (migDir === 'gemini-copilot') {
    if (step === 2) {
      if (!uploadData) return `\n\n[BLOCKER] User is at Import Data but has NOT uploaded anything yet. Explain clearly: "Before mapping users or starting migration, you need to import your Google Workspace data. You can either select users directly from Google Workspace (left tab) or upload a Google Vault export ZIP file (right tab). Without this, there's nothing to migrate." Then tell them which option is easier.`;
      return `\n\n[AUTO CONTEXT] Import Data done — ${uploadData.total_users} users loaded. Tell them the import is complete and they can now proceed to map users. 1 sentence.`;
    }
    if (step === 3) {
      if (mappings_count === 0) return `\n\n[BLOCKER] User is at Map Users but 0 users are mapped. Explain: "You need to match each Google Workspace user to their Microsoft 365 account. Without mappings, migration can't start — the system won't know where to send each person's data. I can auto-map everyone by email right now, or you can set them manually." Offer auto-map as the fast option.`;
      return `\n\n[AUTO CONTEXT] Map Users — ${mappings_count} users mapped. Tell them mappings look good and they can proceed to Options. 1 sentence.`;
    }
    if (step === 4) return `\n\n[AUTO CONTEXT] Options step. ${dryRunDone ? 'Dry run already done — primary action is live migration now.' : 'First time here — explain dry run briefly: it previews what will happen without writing any data. Recommend it before going live.'}`;
  }
  if (migDir === 'copilot-gemini') {
    if (step === 2) {
      if (c2g_mappings_count === 0) return `\n\n[BLOCKER] User is at Map Users (Copilot→Gemini) but 0 users mapped. Explain: "You need to match each Microsoft 365 user to their Google Workspace destination. Without this, the migration engine doesn't know which Google account to write data into. Auto-map will match them by email instantly." Offer auto-map.`;
      return `\n\n[AUTO CONTEXT] Map Users (C2G) — ${c2g_mappings_count} users mapped. Tell them to proceed to Options. 1 sentence.`;
    }
    if (step === 3) return `\n\n[AUTO CONTEXT] Options (C2G). ${dryRunDone ? 'Dry run done — offer live migration.' : 'Recommend dry run first — safe preview with no data written.'}`;
  }
  if (migDir === 'claude-gemini') {
    if (step === 2) {
      if (cl2g_upload_users === 0) return `\n\n[BLOCKER] User is at Upload ZIP but hasn't uploaded anything. Explain: "To migrate your Claude AI conversations, you first need to export them from Claude.ai. Go to claude.ai → Settings → Account → Export Data, download the ZIP file, then upload it here. This ZIP contains all your conversation history." Give them the steps clearly.`;
      return `\n\n[AUTO CONTEXT] ZIP uploaded — ${cl2g_upload_users} users found. Tell them upload is done, now they need to map users. 1 sentence.`;
    }
    if (step === 3) {
      if (cl2g_mappings_count === 0) return `\n\n[BLOCKER] User is at Map Users (CL2G) but 0 mapped. Explain: "Each Claude user in your export needs to be matched to a Google Workspace account. This tells the system which Google Drive to put the conversations into. Auto-map will match by email automatically." Offer auto-map.`;
      return `\n\n[AUTO CONTEXT] Map Users (CL2G) — ${cl2g_mappings_count} mapped. Tell them to proceed to Options. 1 sentence.`;
    }
    if (step === 4) return `\n\n[AUTO CONTEXT] Options (CL2G). ${dryRunDone ? 'Dry run done — offer live migration.' : 'Recommend dry run — safe preview first.'}`;
  }

  return `\n\n[AUTO CONTEXT] User just navigated to step ${step} (${migDir}). Tell them exactly what to do next. 1-2 sentences, no questions.`;
}

export async function runAgentLoop(req, res, { message, migrationState: _migrationState, migrationLogs, isSystemTrigger, db }) {
  let migrationState = _migrationState;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const appUserId = req.session?.appUser?._id || req.session?.appUser?.email || req.session?.appUserId;
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const streamText = (content) => res.write(`data: ${JSON.stringify({ type: 'text', content })}\n\n`);
  const streamEvent = (event, payload = {}) => res.write(`data: ${JSON.stringify({ type: 'ui_event', event, ...payload })}\n\n`);
  const streamQuickReplies = (replies) => streamEvent('quick_replies', { replies });
  const streamDone = () => { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); res.end(); };

  const toolCtx = { streamEvent, session: req.session, migrationState, migrationLogs, db };

  try {
    // Handle pending confirmation — user replied "Yes, proceed" or "Cancel"
    if (req.session.pendingAction) {
      if (message === 'Yes, proceed' || message === 'Yes') {
        const { tool, args } = req.session.pendingAction;
        req.session.pendingAction = null;
        req.session.pendingConfirmed = true;
        const result = await executeTool(tool, args, toolCtx);
        const replyMsg = await callAI([
          { role: 'system', content: buildSystemPrompt(migrationState, migrationLogs) },
          { role: 'user', content: `I confirmed. Tool ${tool} completed with result: ${JSON.stringify(result)}. Tell me what happened in a natural, friendly way.` },
        ], null);
        streamText(replyMsg.content ?? 'Done!');
        streamQuickReplies(defaultChips(migrationState));
        await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
        await saveHistory(db, appUserId, 'assistant', replyMsg.content ?? 'Done!', migrationState?.migDir);
        return streamDone();
      }

      if (message === 'Cancel') {
        req.session.pendingAction = null;
        streamText("No problem — cancelled. What would you like to do instead?");
        streamQuickReplies(defaultChips(migrationState));
        await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
        await saveHistory(db, appUserId, 'assistant', 'Cancelled.', migrationState?.migDir);
        return streamDone();
      }

      // Non-confirmation message while pending — clear the pending action and continue normally
      req.session.pendingAction = null;
    }

    const history = await loadHistory(db, appUserId);
    const isReturningUser = history.length > 0;
    await auditLog(sessionId, 'session_start', {
      appUserId,
      message: isSystemTrigger ? '__step_context__' : message,
      isSystemTrigger,
      step: migrationState?.step,
      migDir: migrationState?.migDir,
      googleAuthed: migrationState?.googleAuthed,
      msAuthed: migrationState?.msAuthed,
      historyLength: history.length,
    });
    const systemPrompt = buildSystemPrompt(migrationState, migrationLogs, { isReturningUser });

    const stepContextInstruction = isSystemTrigger
      ? buildStepContextInstruction(migrationState)
      : '';

    // Greeting only fires on __step_context__ when this is truly the first message (no history)
    const isFirstMessage = message === '__step_context__' && !isReturningUser;
    const isReturnGreet  = message === '__step_context__' && isReturningUser && history.length === 0;

    const greetingInstruction = isFirstMessage
      ? `\n\n[GREETING — FIRST VISIT] Welcome ${migrationState.appUserName ?? 'the user'} by name. Introduce yourself as GEM, CloudFuze's migration assistant. In 3-4 sentences: (1) greet them by first name, (2) say what GEM can do — migrate Google Workspace, Microsoft 365 Copilot, and Claude AI conversations, (3) tell them the first step is connecting their cloud accounts on the left panel. Professional, warm, not robotic.`
      : isReturnGreet
        ? `\n\n[GREETING — RETURNING USER] Welcome ${migrationState.appUserName ?? 'back'} back by name. 1 sentence warm greeting, then immediately tell them where they left off based on current state. Be specific. No generic intros.`
        : '';

    const messages = [
      { role: 'system', content: systemPrompt + stepContextInstruction + greetingInstruction },
      ...(isSystemTrigger ? [] : history),
      { role: 'user', content: (isFirstMessage || isReturnGreet) ? 'Greet me.' : isSystemTrigger ? 'What should I do on this step?' : message },
    ];

    // System trigger gets safe navigation tools so agent can redirect user (e.g. back to connect clouds)
    const SAFE_TOOLS = AGENT_TOOLS.filter(t => ['navigate_to_step', 'select_direction', 'show_widget', 'show_migration_actions'].includes(t.function?.name));

    logger.info(`[agentLoop] user=${appUserId} msg="${message?.slice(0, 80)}" step=${migrationState?.step} migDir=${migrationState?.migDir}`);

    let iterations = 0;
    let toolCallsMade = 0;
    let finalReply = null;

    while (iterations++ < MAX_ITERATIONS) {
      const aiMsg = await callAI(messages, isSystemTrigger ? SAFE_TOOLS : AGENT_TOOLS);

      // Text-only response — loop ends
      if (aiMsg.content && (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0)) {
        finalReply = aiMsg.content;
        await auditLog(sessionId, 'llm_response', {
          appUserId,
          iteration: iterations,
          content: finalReply?.slice(0, 500),
          toolCalls: aiMsg.tool_calls?.map(t => t.function?.name) ?? [],
        });
        req.session.pendingConfirmed = false;
        break;
      }

      // Tool call
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        const call = aiMsg.tool_calls[0];
        const toolName = call.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(call.function.arguments || '{}'); } catch (_) {}

        toolCallsMade++;
        logger.info(`[agentLoop] iteration=${iterations} tool_call=${toolName}`);
        await auditLog(sessionId, 'tool_call', {
          appUserId,
          iteration: iterations,
          toolName,
          toolArgs,
        });

        // Gate destructive tools on confirmation
        if (DESTRUCTIVE_TOOLS.includes(toolName) && !req.session.pendingConfirmed) {
          const conf = CONFIRMATION_MESSAGES[toolName];
          const confirmText = toolName === 'start_migration'
            ? (toolArgs.dryRun ? conf.dry : conf.live)
            : conf.default;
          req.session.pendingAction = { tool: toolName, args: toolArgs };
          await auditLog(sessionId, 'confirmation_gate', {
            appUserId,
            toolName,
            toolArgs,
            confirmText: confirmText.slice(0, 200),
          });
          streamText(confirmText);
          streamQuickReplies(['Yes, proceed', 'Cancel']);
          await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
          await saveHistory(db, appUserId, 'assistant', confirmText, migrationState?.migDir);
          await auditLog(sessionId, 'session_end', { appUserId, finalReplyLength: confirmText.length, toolCallCount: toolCallsMade });
          return streamDone();
        }

        req.session.pendingConfirmed = false;

        const result = await executeTool(toolName, toolArgs, toolCtx);
        logger.info(`[agentLoop] tool_result=${toolName} → ${JSON.stringify(result).slice(0, 200)}`);
        await auditLog(sessionId, 'tool_result', {
          appUserId,
          toolName,
          result,
        });

        // Keep migrationState in sync so defaultChips() uses current direction/step
        if (toolName === 'select_direction' && result.selected && toolArgs.migDir) {
          migrationState = { ...migrationState, migDir: toolArgs.migDir };
        }
        if (toolName === 'navigate_to_step' && result.navigated && toolArgs.step != null) {
          migrationState = { ...migrationState, step: toolArgs.step };
        }

        // Feed result back to AI
        messages.push({ role: 'assistant', tool_calls: aiMsg.tool_calls });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        continue;
      }

      // AI returned neither content nor tool_calls
      finalReply = aiMsg.content || "I couldn't generate a response. Please try again.";
      break;
    }

    if (!finalReply) {
      finalReply = "I've been working through this but ran into a limit. Could you rephrase?";
    }

    streamText(finalReply);
    streamQuickReplies(defaultChips(migrationState));

    if (!isSystemTrigger) {
      await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
      await saveHistory(db, appUserId, 'assistant', finalReply, migrationState?.migDir);
    }

    await auditLog(sessionId, 'session_end', {
      appUserId,
      finalReplyLength: finalReply?.length ?? 0,
      toolCallCount: toolCallsMade,
    });

  } catch (err) {
    logger.error(`[agentLoop] error: ${err.message}`);
    await auditLog(sessionId, 'error', { appUserId, error: err.message });
    streamText(`I ran into a problem: ${err.message}. Please try again.`);
  }

  streamDone();
}
