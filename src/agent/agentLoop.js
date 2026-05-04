// src/agent/agentLoop.js
import { callAI } from './callAI.js';
import { AGENT_TOOLS, DESTRUCTIVE_TOOLS, CONFIRMATION_MESSAGES } from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { loadHistory, saveHistory } from './conversationHistory.js';
import { executeTool } from './toolExecutor.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:loop');
const MAX_ITERATIONS = 8;

function defaultChips(migrationState) {
  const { step = 0, migDir, googleAuthed = false, msAuthed = false,
    mappings_count = 0, c2g_mappings_count = 0, cl2g_mappings_count = 0,
    cl2g_upload_users = 0, uploadData = null, migDone = false, c2g_done = false, cl2g_done = false } = migrationState ?? {};

  // No direction yet
  if (!migDir) {
    if (!googleAuthed && !msAuthed) return ['Google to Microsoft', 'Claude to Google', 'Which should I choose?'];
    if (googleAuthed && !msAuthed) return ['Claude to Google', 'Google to Microsoft', 'What do I need to connect?'];
    return ['Show me the options', 'What can you migrate?'];
  }

  // Auth missing for direction
  const needsGoogle = migDir === 'gemini-copilot' || migDir === 'copilot-gemini' || migDir === 'claude-gemini';
  const needsMs = migDir === 'gemini-copilot' || migDir === 'copilot-gemini';
  const missingGoogle = needsGoogle && !googleAuthed;
  const missingMs = needsMs && !msAuthed;
  if (missingGoogle || missingMs) {
    const missing = [missingGoogle && 'Connect Google Workspace', missingMs && 'Connect Microsoft 365'].filter(Boolean);
    return [...missing, 'Why do I need this?'];
  }

  // Direction-specific chips per step
  if (migDir === 'gemini-copilot') {
    if (step <= 1) return ['Import my data', 'How does this work?'];
    if (step === 2) return uploadData ? ['Map my users', 'How many users are there?'] : ['How do I upload?', 'What is a takeout?'];
    if (step === 3) return mappings_count > 0 ? ['Auto-map my users', 'Review mappings', 'Go to options'] : ['Auto-map my users', 'How do I map users?'];
    if (step === 4) return ['Run a dry run first', 'Go live now', 'What is a dry run?'];
    if (migDone) return ['Download report', 'Start another migration', 'Any errors?'];
  }
  if (migDir === 'copilot-gemini') {
    if (step <= 2) return c2g_mappings_count > 0 ? ['Review my mappings', 'Auto-map users', 'Go to options'] : ['Auto-map my users', 'How do I map users?'];
    if (step === 3) return ['Run a dry run', 'Go live now'];
    if (c2g_done) return ['Download report', 'Start another migration'];
  }
  if (migDir === 'claude-gemini') {
    if (step <= 1) return ['Upload my export', 'How do I export from Claude?'];
    if (step === 2) return cl2g_upload_users > 0 ? ['Map my users', 'How many conversations?'] : ['How do I get my Claude export?', 'Upload my ZIP'];
    if (step === 3) return cl2g_mappings_count > 0 ? ['Auto-map users', 'Go to options'] : ['Auto-map my users', 'How do I map users?'];
    if (step === 4) return ['Run a dry run first', 'Go live now'];
    if (c2g_done) return ['Download report', 'Start another migration'];
  }

  return ['Check status', 'What do I do next?'];
}

function buildStepContextInstruction(state) {
  const { step = 0, migDir, googleAuthed = false, msAuthed = false,
    uploadData = null, mappings_count = 0, c2g_mappings_count = 0,
    cl2g_upload_users = 0, cl2g_mappings_count = 0 } = state ?? {};

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
    if (step === 2) return `\n\n[AUTO CONTEXT] Import Data step. Upload status: ${uploadData ? `${uploadData.total_users} users loaded` : 'nothing uploaded'}. Tell them what to do: ${uploadData ? 'proceed to mapping' : 'upload their Google Takeout ZIP'}. 1-2 sentences.`;
    if (step === 3) return `\n\n[AUTO CONTEXT] Map Users step. ${mappings_count} users mapped. ${mappings_count === 0 ? 'Suggest auto-mapping.' : 'Tell them to review mappings and proceed.'}`;
    if (step === 4) return `\n\n[AUTO CONTEXT] Options step. They can run a dry run (safe preview) or go live. Recommend dry run first if they haven't done one.`;
  }
  if (migDir === 'copilot-gemini') {
    if (step === 2) return `\n\n[AUTO CONTEXT] Map Users step (Copilot→Gemini). ${c2g_mappings_count} users mapped. ${c2g_mappings_count === 0 ? 'Suggest auto-mapping.' : 'Tell them to proceed to options.'}`;
    if (step === 3) return `\n\n[AUTO CONTEXT] Options step (Copilot→Gemini). Recommend dry run first.`;
  }
  if (migDir === 'claude-gemini') {
    if (step === 2) return `\n\n[AUTO CONTEXT] Upload ZIP step (Claude→Gemini). ${cl2g_upload_users > 0 ? `${cl2g_upload_users} users loaded` : 'No ZIP uploaded'}. ${cl2g_upload_users > 0 ? 'Tell them to map users.' : 'Tell them to upload their Claude export ZIP.'}`;
    if (step === 3) return `\n\n[AUTO CONTEXT] Map Users step (Claude→Gemini). ${cl2g_mappings_count} users mapped. ${cl2g_mappings_count === 0 ? 'Suggest auto-mapping.' : 'Tell them to proceed.'}`;
    if (step === 4) return `\n\n[AUTO CONTEXT] Options step (Claude→Gemini). Recommend dry run first.`;
  }

  return `\n\n[AUTO CONTEXT] User just navigated to step ${step} (${migDir}). Tell them exactly what to do next. 1-2 sentences, no questions.`;
}

export async function runAgentLoop(req, res, { message, migrationState, migrationLogs, isSystemTrigger, db }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const appUserId = req.session?.appUser?._id || req.session?.appUser?.email || req.session?.appUserId;

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
    const systemPrompt = buildSystemPrompt(migrationState, migrationLogs);

    const stepContextInstruction = isSystemTrigger
      ? buildStepContextInstruction(migrationState)
      : '';

    const messages = [
      { role: 'system', content: systemPrompt + stepContextInstruction },
      ...(isSystemTrigger ? [] : history),
      { role: 'user', content: isSystemTrigger ? 'What should I do on this step?' : message },
    ];

    // System trigger gets safe navigation tools so agent can redirect user (e.g. back to connect clouds)
    const SAFE_TOOLS = AGENT_TOOLS.filter(t => ['navigate_to_step', 'select_direction', 'show_widget', 'show_migration_actions'].includes(t.function?.name));

    logger.info(`[agentLoop] user=${appUserId} msg="${message?.slice(0, 80)}" step=${migrationState?.step} migDir=${migrationState?.migDir}`);

    let iterations = 0;
    let finalReply = null;

    while (iterations++ < MAX_ITERATIONS) {
      const aiMsg = await callAI(messages, isSystemTrigger ? SAFE_TOOLS : AGENT_TOOLS);

      // Text-only response — loop ends
      if (aiMsg.content && (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0)) {
        finalReply = aiMsg.content;
        req.session.pendingConfirmed = false;
        break;
      }

      // Tool call
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        const call = aiMsg.tool_calls[0];
        const toolName = call.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(call.function.arguments || '{}'); } catch (_) {}

        logger.info(`[agentLoop] iteration=${iterations} tool_call=${toolName}`);

        // Gate destructive tools on confirmation
        if (DESTRUCTIVE_TOOLS.includes(toolName) && !req.session.pendingConfirmed) {
          const conf = CONFIRMATION_MESSAGES[toolName];
          const confirmText = toolName === 'start_migration'
            ? (toolArgs.dryRun ? conf.dry : conf.live)
            : conf.default;
          req.session.pendingAction = { tool: toolName, args: toolArgs };
          streamText(confirmText);
          streamQuickReplies(['Yes, proceed', 'Cancel']);
          await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
          await saveHistory(db, appUserId, 'assistant', confirmText, migrationState?.migDir);
          return streamDone();
        }

        req.session.pendingConfirmed = false;

        const result = await executeTool(toolName, toolArgs, toolCtx);
        logger.info(`[agentLoop] tool_result=${toolName} → ${JSON.stringify(result).slice(0, 200)}`);

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

  } catch (err) {
    logger.error(`[agentLoop] error: ${err.message}`);
    streamText(`I ran into a problem: ${err.message}. Please try again.`);
  }

  streamDone();
}
