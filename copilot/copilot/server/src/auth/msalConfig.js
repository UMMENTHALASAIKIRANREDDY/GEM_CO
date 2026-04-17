import { ConfidentialClientApplication } from "@azure/msal-node";

// AiEnterpriseInteraction.Read.All is application-only — it cannot appear in a
// delegated OAuth scope list. Use .default so Microsoft sends all permissions
// that have already been admin-consented on the app registration in Entra.
const SCOPES = ["https://graph.microsoft.com/.default"];

/**
 * Build MSAL ConfidentialClientApplication for a given tenant.
 * @param {string} tenantId
 * @returns {ConfidentialClientApplication}
 */
export function buildMsalApp(tenantId) {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set for the OAuth login flow."
    );
  }
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
}

/**
 * Build the redirect URI for source or destination.
 * @param {"source"|"dest"} role
 */
export function getRedirectUri(role) {
  const base = process.env.OAUTH_REDIRECT_BASE || "http://localhost:3000";
  return `${base}/auth/${role}/callback`;
}

export { SCOPES };
