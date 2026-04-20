import { google } from 'googleapis';
import fs from 'fs';

const SCOPES = [
  'https://www.googleapis.com/auth/chat.import',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.memberships',
  'https://www.googleapis.com/auth/chat.messages',
];

/**
 * Create a Google Chat API client impersonating a specific user.
 * Requires a service account with domain-wide delegation.
 *
 * @param {string} subjectEmail - Google Workspace user to impersonate
 */
export function createChatClient(subjectEmail) {
  const keyPath = process.env.S2G_GCHAT_SA_KEY_PATH || process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './service_account.json';
  const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

  const auth = new google.auth.JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: SCOPES,
    subject: subjectEmail,
  });

  return google.chat({ version: 'v1', auth });
}

/**
 * Create an admin-level Chat client (no impersonation — for operations
 * that don't require acting as a specific user).
 */
export function createAdminChatClient() {
  const adminSubject = process.env.S2G_GCHAT_ADMIN_SUBJECT;
  if (!adminSubject) throw new Error('S2G_GCHAT_ADMIN_SUBJECT not set in .env');
  return createChatClient(adminSubject);
}

/**
 * Retry a Google API call with exponential backoff on 429 / 5xx.
 */
export async function withRetry(fn, maxRetries = 5, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.response?.status || err?.code;
      const retryAfter = parseInt(err?.response?.headers?.['retry-after'] || '0', 10);

      if (attempt === maxRetries) break;

      if (code === 429 || code === 503 || code === 500) {
        const delay = retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // ALREADY_EXISTS is not an error — treat as success
      if (err?.response?.data?.error?.status === 'ALREADY_EXISTS') return null;

      throw err;
    }
  }
  throw lastErr;
}
