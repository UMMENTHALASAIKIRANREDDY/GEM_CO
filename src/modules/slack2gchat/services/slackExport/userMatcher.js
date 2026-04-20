import fs from 'fs';
import { parse as parseCsv } from 'csv-parse/sync';

/**
 * Build user match suggestions using three strategies:
 * 1. Exact email match (Slack profile email → Google email)
 * 2. Display name fuzzy match against Google Workspace users
 * 3. Unmatched — needs manual mapping
 */
export function buildUserMatches(slackUsers, googleUsers = []) {
  const googleByEmail = new Map(googleUsers.map(u => [u.email?.toLowerCase(), u]));
  const googleByName = new Map(googleUsers.map(u => [
    (u.name || u.email || '').toLowerCase().replace(/\s+/g, ''), u
  ]));

  return slackUsers.map(u => {
    if (u.isBot) {
      return { ...u, googleEmail: null, matchMethod: 'bot', verified: false };
    }

    // Strategy 1: exact email
    if (u.slackEmail) {
      const match = googleByEmail.get(u.slackEmail.toLowerCase());
      if (match) {
        return { ...u, googleEmail: match.email, matchMethod: 'email', verified: true };
      }
    }

    // Strategy 2: display name
    const nameKey = (u.slackRealName || u.displayName || '').toLowerCase().replace(/\s+/g, '');
    if (nameKey) {
      const match = googleByName.get(nameKey);
      if (match) {
        return { ...u, googleEmail: match.email, matchMethod: 'name', verified: false };
      }
    }

    return { ...u, googleEmail: u.slackEmail || null, matchMethod: 'unmatched', verified: false };
  });
}

/**
 * Parse a user mapping CSV.
 * Expected columns: slack_email (or slack_user_id), google_email
 */
export function parseUserMappingCsv(csvBuffer) {
  const rows = parseCsv(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const mapping = {};
  for (const row of rows) {
    const slackKey = (row.slack_email || row.slack_user_id || '').trim().toLowerCase();
    const googleEmail = (row.google_email || '').trim().toLowerCase();
    if (slackKey && googleEmail) {
      mapping[slackKey] = googleEmail;
    }
  }
  return mapping;
}
