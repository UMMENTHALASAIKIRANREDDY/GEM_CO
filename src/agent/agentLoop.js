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
  const { step = 0, migDir } = migrationState ?? {};
  if (!migDir) return ['What can you help with?', 'Show me the options'];
  if (step <= 1) return ['What do I do next?'];
  if (step === 2) return ['How do I import data?', 'What do I do next?'];
  if (step === 3) return ['Auto-map my users', 'What do I do next?'];
  if (step === 4) return ['Run a dry run', 'Go live'];
  return ['Check status', 'Any errors?', 'What do I do next?'];
}

export async function runAgentLoop(req, res, { message, migrationState, migrationLogs, isSystemTrigger, db }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const appUserId = req.session?.appUser?.id || req.session?.appUser?.email || req.session?.appUserId;

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
      ? '\n\n[AUTO CONTEXT] The user just navigated to this step. Write 1-2 sentences: what they see right now on the left panel, and exactly what to do next. Be specific to their actual state. Do not ask questions. End with a clear action.'
      : '';

    const messages = [
      { role: 'system', content: systemPrompt + stepContextInstruction },
      ...(isSystemTrigger ? [] : history),
      { role: 'user', content: isSystemTrigger ? 'What should I do on this step?' : message },
    ];

    logger.info(`[agentLoop] user=${appUserId} msg="${message?.slice(0, 80)}" step=${migrationState?.step} migDir=${migrationState?.migDir}`);

    let iterations = 0;
    let finalReply = null;

    while (iterations++ < MAX_ITERATIONS) {
      const aiMsg = await callAI(messages, isSystemTrigger ? null : AGENT_TOOLS);

      // Text-only response — loop ends
      if (aiMsg.content && (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0)) {
        finalReply = aiMsg.content;
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

    await saveHistory(db, appUserId, 'user', message, migrationState?.migDir);
    await saveHistory(db, appUserId, 'assistant', finalReply, migrationState?.migDir);

  } catch (err) {
    logger.error(`[agentLoop] error: ${err.message}`);
    streamText(`I ran into a problem: ${err.message}. Please try again.`);
  }

  streamDone();
}
