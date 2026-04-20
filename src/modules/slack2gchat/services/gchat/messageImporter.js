import { createChatClient, withRetry } from './chatClient.js';
import crypto from 'crypto';

/**
 * Convert a Slack message to a Google Chat message body.
 * Handles: text, threads, attachments (noted as unavailable).
 */
function slackMsgToGchat(msg, slackUserId, userMapLookup) {
  let text = msg.text || '';

  // Replace Slack user mentions <@UXXXXX> with display name
  text = text.replace(/<@([A-Z0-9]+)>/g, (_, uid) => {
    const email = userMapLookup.get(uid);
    return email ? `@${email.split('@')[0]}` : `@user_${uid}`;
  });

  // Replace Slack channel mentions <#CXXXXX|name>
  text = text.replace(/<#[A-Z0-9]+\|([^>]+)>/g, (_, name) => `#${name}`);

  // Strip other Slack formatting tokens
  text = text.replace(/<([^>]+)>/g, (_, inner) => {
    if (inner.startsWith('http')) return inner.split('|')[0];
    return inner.split('|').pop() || inner;
  });

  // Note attachments that can't be migrated
  if (msg.files?.length || msg.attachments?.length) {
    const fileNames = (msg.files || []).map(f => f.name || 'file').join(', ');
    if (fileNames) text += `\n\n[Attachment: ${fileNames} (original file unavailable — Slack export only)]`;
  }

  if (!text.trim()) text = '[empty message]';

  return text;
}

/**
 * Import a single Slack message into a Google Chat space.
 * Impersonates the sender if they have a Google email mapping.
 * Falls back to admin account with attribution in message text.
 *
 * @param {string} spaceName - Google Chat space name ("spaces/ABCDEF")
 * @param {object} msg - Slack message object
 * @param {Map} userMapLookup - slackUserId → googleEmail
 * @param {string} adminEmail - fallback sender email
 * @param {Map} threadMap - slackThreadTs → gchat threadName (for replies)
 */
export async function importMessage(spaceName, msg, userMapLookup, adminEmail, threadMap) {
  const senderEmail = userMapLookup.get(msg.user || msg.bot_id) || adminEmail;
  const chat = createChatClient(senderEmail);

  let text = slackMsgToGchat(msg, msg.user, userMapLookup);

  // If falling back to admin, add attribution
  if (senderEmail === adminEmail && msg.user) {
    const originalUser = userMapLookup.get(msg.user) || `slack:${msg.user}`;
    text = `[Originally from ${originalUser}]\n${text}`;
  }

  // Deterministic message ID to make retries idempotent
  const messageId = `slack_${crypto
    .createHash('md5')
    .update(`${spaceName}_${msg.ts}`)
    .digest('hex')
    .slice(0, 16)}`;

  const createTime = new Date(parseFloat(msg.ts) * 1000).toISOString();

  const requestBody = {
    text,
    createTime,
  };

  // Thread reply
  if (msg.thread_ts && msg.thread_ts !== msg.ts) {
    const parentThreadName = threadMap.get(msg.thread_ts);
    if (parentThreadName) {
      requestBody.thread = { name: parentThreadName };
    } else {
      requestBody.thread = { threadKey: `slack_thread_${msg.thread_ts}` };
    }
  }

  try {
    const response = await withRetry(() =>
      chat.spaces.messages.create({
        parent: spaceName,
        messageId,
        messageReplyOption: msg.thread_ts && msg.thread_ts !== msg.ts
          ? 'REPLY_MESSAGE_OR_FAIL'
          : 'MESSAGE_REPLY_OPTION_UNSPECIFIED',
        requestBody,
      })
    );

    // Track thread name for future replies
    if (msg.thread_ts === msg.ts && response?.data?.thread?.name) {
      threadMap.set(msg.ts, response.data.thread.name);
    }

    return { success: true, messageName: response?.data?.name };
  } catch (err) {
    // ALREADY_EXISTS — treat as success (idempotent retry)
    if (err?.response?.data?.error?.status === 'ALREADY_EXISTS') {
      return { success: true, alreadyExisted: true };
    }
    return { success: false, error: err.message };
  }
}
