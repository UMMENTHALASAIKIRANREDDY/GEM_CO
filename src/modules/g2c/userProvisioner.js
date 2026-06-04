import { getValidToken } from '../../core/auth/microsoft.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:userProvisioner');
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Service plan GUIDs that indicate OneNote/SharePoint access
const ONENOTE_PLANS = new Set([
  '2bdbaf8f-738f-4ac7-a6a4-d7d2f7a55b7e', // ONENOTE
  'b76fb638-6ba6-402a-b9f9-83d28acb3d86', // SHAREPOINTSTANDARD
  'fe71d6c3-a2ea-4499-9778-da042bf08063', // SHAREPOINTWAC
]);

/**
 * Provision OneDrive + check/assign M365 license for a target user.
 * Uses the signed-in admin's delegated token.
 *
 * @param {string} appUserId - internal app user id
 * @param {string} targetEmail - user to provision (e.g. ron@filefuze.co)
 * @returns {Promise<{provisioned: boolean, licensed: boolean, licenseAssigned: boolean, details: string[]}>}
 */
export async function provisionUser(appUserId, targetEmail) {
  const token = await getValidToken(appUserId);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const result = { provisioned: false, licensed: false, licenseAssigned: false, details: [] };

  // 1. Force SharePoint personal site + OneNote provisioning by writing a file to OneDrive root.
  //    A simple GET /drive only checks existence; a PUT write forces full SP site + OneNote init.
  try {
    const writeHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' };
    const r = await fetch(
      `${GRAPH}/users/${targetEmail}/drive/root:/cloudfuze-provision.txt:/content`,
      { method: 'PUT', headers: writeHeaders, body: 'provisioned' }
    );
    if (r.ok) {
      result.provisioned = true;
      result.details.push(`OneDrive + SharePoint personal site provisioned for ${targetEmail}`);
      logger.info(`userProvisioner: OneDrive write-provision OK for ${targetEmail}`);
      // Clean up the trigger file
      const deleteToken = await getValidToken(appUserId);
      fetch(`${GRAPH}/users/${targetEmail}/drive/root:/cloudfuze-provision.txt:`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${deleteToken}` }
      }).catch(() => {});
    } else {
      const body = await r.text();
      result.details.push(`OneDrive provision attempt: ${r.status} — ${body.slice(0, 200)}`);
      logger.warn(`userProvisioner: OneDrive write-provision ${r.status} for ${targetEmail}`);
    }
  } catch (e) {
    result.details.push(`OneDrive provision error: ${e.message}`);
    logger.warn(`userProvisioner: OneDrive error for ${targetEmail}: ${e.message}`);
  }

  // 1b. Wait briefly for SharePoint personal site to initialize before OneNote calls
  if (result.provisioned) await new Promise(r => setTimeout(r, 3000));

  // 2. Check existing licenses
  try {
    const r = await fetch(`${GRAPH}/users/${targetEmail}/licenseDetails`, { headers });
    if (r.ok) {
      const data = await r.json();
      const plans = (data.value || []).flatMap(lic => (lic.servicePlans || []).map(p => p.servicePlanId));
      const hasOneNote = plans.some(id => ONENOTE_PLANS.has(id));
      result.licensed = hasOneNote;
      result.details.push(`License check: ${hasOneNote ? 'OneNote-capable license found' : 'no OneNote license'} (${(data.value || []).length} license(s) total)`);
      logger.info(`userProvisioner: license check for ${targetEmail} — hasOneNote=${hasOneNote}`);
    } else {
      const body = await r.text();
      result.details.push(`License check failed: ${r.status} — ${body.slice(0, 200)}`);
      logger.warn(`userProvisioner: license check ${r.status} for ${targetEmail}`);
    }
  } catch (e) {
    result.details.push(`License check error: ${e.message}`);
  }

  // 3. If no OneNote license, find an available SKU and assign it
  if (!result.licensed) {
    try {
      const skuRes = await fetch(`${GRAPH}/subscribedSkus`, { headers });
      if (!skuRes.ok) throw new Error(`subscribedSkus ${skuRes.status}`);
      const skuData = await skuRes.json();

      // Find a SKU with available units that includes a OneNote plan
      const sku = (skuData.value || []).find(s => {
        const available = (s.prepaidUnits?.enabled || 0) - (s.consumedUnits || 0);
        if (available <= 0) return false;
        return (s.servicePlans || []).some(p => ONENOTE_PLANS.has(p.servicePlanId));
      });

      if (!sku) {
        result.details.push('No available M365 license with OneNote found in tenant pool');
        logger.warn(`userProvisioner: no assignable OneNote SKU for ${targetEmail}`);
      } else {
        const assignRes = await fetch(`${GRAPH}/users/${targetEmail}/assignLicense`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            addLicenses: [{ skuId: sku.skuId }],
            removeLicenses: []
          })
        });
        if (assignRes.ok) {
          result.licenseAssigned = true;
          result.licensed = true;
          result.details.push(`Assigned license "${sku.skuPartNumber}" (${sku.skuId}) to ${targetEmail}`);
          logger.info(`userProvisioner: assigned ${sku.skuPartNumber} to ${targetEmail}`);
        } else {
          const body = await assignRes.text();
          result.details.push(`License assign failed: ${assignRes.status} — ${body.slice(0, 200)}`);
          logger.warn(`userProvisioner: assign ${assignRes.status} for ${targetEmail}: ${body.slice(0, 200)}`);
        }
      }
    } catch (e) {
      result.details.push(`License assign error: ${e.message}`);
      logger.warn(`userProvisioner: license assign error for ${targetEmail}: ${e.message}`);
    }
  }

  return result;
}

/**
 * Provision all users in a list, returning per-user results.
 */
export async function provisionUsers(appUserId, emails) {
  const results = {};
  for (const email of emails) {
    results[email] = await provisionUser(appUserId, email);
  }
  return results;
}
