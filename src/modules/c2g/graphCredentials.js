/**
 * Source Entra app credentials for reading Copilot interactions.
 */

/**
 * @returns {{ tenantId: string, clientId: string, clientSecret: string } | null}
 */
export function tryResolveSourceCredentials() {
  const tenantId =
    process.env.SOURCE_AZURE_TENANT_ID?.trim() ||
    process.env.AZURE_TENANT_ID?.trim();
  const clientId =
    process.env.SOURCE_AZURE_CLIENT_ID?.trim() ||
    process.env.AZURE_CLIENT_ID?.trim();
  const clientSecret =
    process.env.SOURCE_AZURE_CLIENT_SECRET?.trim() ||
    process.env.AZURE_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) {
    return null;
  }
  return { tenantId, clientId, clientSecret };
}

export function requireSourceCredentials() {
  const c = tryResolveSourceCredentials();
  if (!c) {
    throw new Error(
      "Missing app credentials: set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET."
    );
  }
  return c;
}

/**
 * Public summary for /api/settings (no secrets).
 */
export function readTenantSummaryForApi() {
  const source = tryResolveSourceCredentials();
  return {
    sourceConfigured: Boolean(source),
    sourceTenantId: source?.tenantId ?? null,
  };
}
