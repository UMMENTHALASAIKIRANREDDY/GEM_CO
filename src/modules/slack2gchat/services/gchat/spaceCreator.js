import { createAdminChatClient, withRetry } from './chatClient.js';

/**
 * Create a Google Chat space in import mode.
 * Returns the space resource name (e.g. "spaces/ABCDEF").
 *
 * @param {object} channel - normalized Slack channel object
 * @param {string[]} memberEmails - Google emails of members (for DMs)
 */
export async function createImportSpace(channel, memberEmails = []) {
  const chat = createAdminChatClient();

  let spaceType;
  if (channel.slackType === 'dm' && memberEmails.length === 2) {
    spaceType = 'DIRECT_MESSAGE';
  } else if (channel.slackType === 'group_dm') {
    spaceType = 'GROUP_CHAT';
  } else {
    spaceType = 'SPACE';
  }

  const displayName = channel.slackType === 'channel'
    ? `#${channel.slackName}`
    : undefined; // DMs and group chats don't have display names

  const spaceBody = {
    spaceType,
    importMode: true,
    ...(displayName ? { displayName } : {}),
  };

  const response = await withRetry(() =>
    chat.spaces.create({ requestBody: spaceBody })
  );

  return response?.data?.name; // "spaces/ABCDEF"
}

/**
 * Complete import mode for a space — makes it visible to members.
 */
export async function completeSpaceImport(spaceName) {
  const chat = createAdminChatClient();
  await withRetry(() =>
    chat.spaces.completeImport({
      name: spaceName,
      requestBody: {},
    })
  );
}
