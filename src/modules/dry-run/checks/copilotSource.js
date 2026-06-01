/**
 * Microsoft Copilot source checks. Used by C2G, C2C.
 *
 * Requires an app-only Graph token. Caller passes it in.
 */

import { passingCheck, warningCheck, blockerCheck } from '../reportBuilder.js';

async function graphGet(accessToken, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const COPILOT_PLANS = new Set([
  'M365_COPILOT_BUSINESS', 'M365_COPILOT', 'COPILOT_FOR_M365', 'Microsoft_365_Copilot',
]);

export async function checkCopilotSourceUser(accessToken, sourceEmail, { tenantLabel = 'source' } = {}) {
  if (!sourceEmail) {
    return [blockerCheck('source.copilot.user.missing', 'Source user', 'No source email provided.')];
  }
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sourceEmail)}?$select=id,displayName,accountEnabled`;
  try {
    const { ok, status, data } = await graphGet(accessToken, url);
    if (!ok || !data?.id) {
      return [blockerCheck(
        'source.copilot.user.missing',
        `Source user ${sourceEmail}`,
        `Not found in ${tenantLabel} tenant: ${data?.error?.message || `HTTP ${status}`}`,
        `Verify the email is correct and exists in the source tenant.`
      )];
    }
    if (data.accountEnabled === false) {
      return [blockerCheck(
        'source.copilot.user.disabled',
        `Source user ${sourceEmail} disabled`,
        `User is disabled in ${tenantLabel} tenant.`,
        `Enable the user or remove them from the mapping.`
      )];
    }
    return [passingCheck('source.copilot.user.exists', `Source user ${sourceEmail}`, { id: data.id })];
  } catch (e) {
    return [blockerCheck(
      'source.copilot.user.lookup_failed',
      `Source user ${sourceEmail}`,
      e.message,
      `Verify the source app-only token has User.Read.All permission.`
    )];
  }
}

export async function checkCopilotLicense(accessToken, sourceEmail) {
  if (!sourceEmail) return [];
  try {
    const { ok, data } = await graphGet(accessToken,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sourceEmail)}/licenseDetails`);
    if (!ok || !Array.isArray(data?.value)) {
      return [warningCheck('source.copilot.license.unknown', 'Copilot license', 'Could not read license details.')];
    }
    const plans = data.value.flatMap(l => l.servicePlans || []);
    const hasCopilot = plans.some(p =>
      COPILOT_PLANS.has(p.servicePlanName) && p.provisioningStatus === 'Success'
    );
    if (!hasCopilot) {
      return [blockerCheck(
        'source.copilot.license.missing',
        'Microsoft 365 Copilot license',
        `${sourceEmail} has no active M365 Copilot license.`,
        `Assign a M365 Copilot license in Microsoft Admin Center, or remove this user from the migration.`
      )];
    }
    return [passingCheck('source.copilot.license.ok', 'Microsoft 365 Copilot license')];
  } catch (e) {
    return [warningCheck('source.copilot.license.lookup_failed', 'Copilot license', e.message)];
  }
}

/**
 * Check that the user has at least 1 conversation in interactionHistory.
 * Just samples the API — does a top=1 query for efficiency.
 */
export async function checkCopilotInteractionsExist(accessToken, sourceEmail) {
  if (!sourceEmail) return [];
  try {
    const url = `https://graph.microsoft.com/beta/copilot/users/${encodeURIComponent(sourceEmail)}/interactionHistory/getAllEnterpriseInteractions?$top=1`;
    const { ok, status, data } = await graphGet(accessToken, url);
    if (!ok) {
      // 403 is the typical "no Copilot license" or "API not consented" response
      const msg = data?.error?.message || `HTTP ${status}`;
      if (/license/i.test(msg)) {
        return [blockerCheck(
          'source.copilot.interactions.no_license',
          'Copilot interaction history',
          msg,
          `Assign Copilot license to ${sourceEmail}.`
        )];
      }
      return [warningCheck(
        'source.copilot.interactions.unreadable',
        'Copilot interaction history',
        msg,
        `Verify the source app has Copilot.InteractionHistory.Read.All admin consent.`
      )];
    }
    const count = (data?.value || []).length;
    if (count === 0) {
      return [warningCheck(
        'source.copilot.interactions.empty',
        'Copilot interaction history',
        `${sourceEmail} has 0 Copilot conversations to migrate — this user will be a no-op.`,
        `Either remove this user from the migration, or proceed (no harm).`
      )];
    }
    return [passingCheck('source.copilot.interactions.ok', 'Copilot interaction history', { sampleCount: count })];
  } catch (e) {
    return [warningCheck('source.copilot.interactions.lookup_failed', 'Copilot history', e.message)];
  }
}
