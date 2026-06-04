/**
 * Direction-agnostic checks: folder name, date range, mapping integrity.
 * No network calls — runs in milliseconds.
 */

import { passingCheck, warningCheck, blockerCheck } from '../reportBuilder.js';

const FORBIDDEN_CHARS = /[/\\:*?"<>|]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCommonConfigAndMapping({ config = {}, pairs = [] }) {
  const checks = [];

  // ── Folder/Gem/section name ────────────────────────────────────────────
  const name = (config.folderName || config.gemName || config.sectionName || '').trim();
  if (!name) {
    checks.push(blockerCheck(
      'config.folder_name.empty',
      'Folder/section name',
      'No folder/section name provided.',
      'Enter a name in Migration Options (e.g. "CopilotChats").'
    ));
  } else if (FORBIDDEN_CHARS.test(name)) {
    checks.push(blockerCheck(
      'config.folder_name.illegal',
      'Folder/section name',
      `Name "${name}" contains illegal characters (one of: / \\ : * ? " < > |).`,
      'Remove the illegal characters from the name.'
    ));
  } else {
    checks.push(passingCheck('config.folder_name.ok', 'Folder/section name', { name }));
  }

  // ── Date range ─────────────────────────────────────────────────────────
  const { fromDate, toDate } = config;
  if (fromDate && toDate) {
    const f = Date.parse(fromDate);
    const t = Date.parse(toDate);
    if (isNaN(f) || isNaN(t)) {
      checks.push(blockerCheck(
        'config.dates.invalid',
        'Date range',
        `Date strings could not be parsed (from="${fromDate}", to="${toDate}").`,
        'Use a valid ISO date (YYYY-MM-DD).'
      ));
    } else if (f > t) {
      checks.push(blockerCheck(
        'config.dates.inverted',
        'Date range',
        `"From" date (${fromDate}) is after "to" date (${toDate}).`,
        'Swap the dates or clear them to migrate all data.'
      ));
    } else {
      checks.push(passingCheck('config.dates.ok', 'Date range', { fromDate, toDate }));
    }
  } else {
    checks.push(passingCheck('config.dates.unset', 'Date range', { fromDate: null, toDate: null }));
  }

  // ── Mapping integrity ──────────────────────────────────────────────────
  if (!Array.isArray(pairs) || pairs.length === 0) {
    checks.push(blockerCheck(
      'mapping.empty',
      'User mapping',
      'No user pairs selected for migration.',
      'In the Map Users step, select at least one user with a destination.'
    ));
    return checks;
  }

  // Helper — accept either destEmail (most directions) or destUserEmail (c2g pipe shape)
  const destOf = (p) => (p.destEmail || p.destUserEmail || '').trim();
  const sourceOf = (p) => (p.sourceEmail || p.sourceUuid || '').trim();

  // Look for empty destinations
  const emptyDest = pairs.filter(p => !destOf(p));
  if (emptyDest.length > 0) {
    checks.push(blockerCheck(
      'mapping.empty_dest',
      'Empty destinations',
      `${emptyDest.length} selected user(s) have no destination mapping.`,
      'Either assign a destination email or uncheck those rows.',
      { count: emptyDest.length, sources: emptyDest.map(sourceOf).slice(0, 10) }
    ));
  }

  // Duplicate destinations
  const destCounts = new Map();
  for (const p of pairs) {
    const d = destOf(p).toLowerCase();
    if (!d) continue;
    destCounts.set(d, (destCounts.get(d) || 0) + 1);
  }
  const dupes = [...destCounts.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    checks.push(blockerCheck(
      'mapping.duplicate_dest',
      'Duplicate destination emails',
      `${dupes.length} destination email(s) used more than once: ${dupes.map(([d]) => d).slice(0, 5).join(', ')}.`,
      'Each destination user can only receive content from one source.',
      { dupes: dupes.map(([d, n]) => ({ email: d, count: n })) }
    ));
  }

  // Same source/dest
  const sameAddress = pairs.filter(p => {
    const s = sourceOf(p).toLowerCase();
    const d = destOf(p).toLowerCase();
    return s && d && s === d;
  });
  if (sameAddress.length > 0) {
    checks.push(warningCheck(
      'mapping.same_email',
      'Same source and destination email',
      `${sameAddress.length} user(s) have identical source and destination email — this is unusual.`,
      'Verify that this is intentional (e.g. same-tenant test migration).',
      { count: sameAddress.length }
    ));
  }

  // Invalid email format (skip Claude UUIDs which aren't emails)
  const badEmails = pairs.filter(p => {
    const s = sourceOf(p);
    const d = destOf(p);
    // sourceEmail may be a Claude UUID; only validate it if it looks like it could be an email
    const sBad = s && s.includes('@') && !EMAIL_RE.test(s);
    const dBad = d && !EMAIL_RE.test(d);
    return sBad || dBad;
  });
  if (badEmails.length > 0) {
    checks.push(blockerCheck(
      'mapping.bad_email_format',
      'Invalid email format',
      `${badEmails.length} mapping(s) have malformed emails.`,
      'Fix the email addresses in the mapping table.',
      { count: badEmails.length }
    ));
  }

  if (checks.every(c => c.severity === 'ok')) {
    // Add a single positive summary so the UI shows green for the section
    checks.push(passingCheck('mapping.ok', 'User mapping', { pairCount: pairs.length }));
  }

  return checks;
}
