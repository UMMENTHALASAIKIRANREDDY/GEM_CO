/**
 * Client credentials token for Microsoft Graph (application permission flow).
 */

const TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export async function getGraphAccessToken({ tenantId, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: "client_credentials",
  });

  const res = await fetch(TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error_description || data.error || res.statusText;
    throw new Error(`Token request failed (${res.status}): ${msg}`);
  }

  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }

  return data.access_token;
}
