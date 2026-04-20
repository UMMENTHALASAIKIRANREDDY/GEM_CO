import { createAdminChatClient, withRetry } from './chatClient.js';

/**
 * Add members to a space after import mode is completed.
 * Membership must be added AFTER completeImport.
 */
export async function addSpaceMembers(spaceName, googleEmails) {
  const chat = createAdminChatClient();
  const results = { added: 0, failed: 0, errors: [] };

  for (const email of googleEmails) {
    try {
      await withRetry(() =>
        chat.spaces.members.create({
          parent: spaceName,
          requestBody: {
            member: {
              name: `users/${email}`,
              type: 'HUMAN',
            },
          },
        })
      );
      results.added++;
    } catch (err) {
      // ALREADY_EXISTS is fine
      if (err?.response?.data?.error?.status === 'ALREADY_EXISTS') {
        results.added++;
        continue;
      }
      results.failed++;
      results.errors.push({ email, error: err.message });
    }
  }

  return results;
}
