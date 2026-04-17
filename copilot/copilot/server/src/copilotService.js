import {
  buildCopilotChatOnlyFilter,
  isCopilotChatSurface,
} from "./appClass.js";
import { getGraphAccessToken } from "./auth.js";
import { requireSourceCredentials } from "./graphCredentials.js";
import { fetchAllEnterpriseInteractions } from "./graph.js";
import { fetchAllDirectoryUsers } from "./users.js";

export function readGraphEnvOptions() {
  const apiVersion = process.env.GRAPH_API_VERSION?.trim() || "v1.0";
  const top = Math.min(
    999,
    Math.max(1, parseInt(process.env.GRAPH_TOP || "100", 10) || 100)
  );
  const copilotChatOnly =
    String(process.env.COPILOT_CHAT_ONLY ?? "true").toLowerCase() !== "false";
  const graphFilterExplicit = process.env.GRAPH_FILTER?.trim() || "";
  const filter =
    graphFilterExplicit ||
    (copilotChatOnly ? buildCopilotChatOnlyFilter() : "");
  const usersOdataFilter = process.env.USERS_ODATA_FILTER?.trim() || "";
  const usersPageSize = Math.min(
    999,
    Math.max(1, parseInt(process.env.USERS_PAGE_SIZE || "999", 10) || 999)
  );
  return {
    apiVersion,
    top,
    copilotChatOnly,
    graphFilterExplicit,
    filter,
    usersOdataFilter,
    usersPageSize,
  };
}

/** Copilot read + source directory — uses SOURCE_* or legacy AZURE_* */
export async function createSourceGraphClient() {
  const { tenantId, clientId, clientSecret } = requireSourceCredentials();
  const accessToken = await getGraphAccessToken({
    tenantId,
    clientId,
    clientSecret,
  });
  return { accessToken };
}

/** @deprecated Use createSourceGraphClient */
export async function createGraphClient() {
  return createSourceGraphClient();
}

export async function listDirectoryUsers(accessToken, overrides = {}) {
  const o = { ...readGraphEnvOptions(), ...overrides };
  const usersFilter =
    overrides.usersFilter ??
    (o.usersOdataFilter ? o.usersOdataFilter : undefined);
  return fetchAllDirectoryUsers({
    accessToken,
    apiVersion: o.apiVersion,
    usersFilter,
    pageSize: o.usersPageSize,
  });
}

/**
 * @param {string} userId
 * @param {object} [overrides] - optional { copilotChatOnly, filter, apiVersion, top }
 */
export async function getCopilotInteractionsForUser(accessToken, userId, overrides = {}) {
  const base = readGraphEnvOptions();
  const copilotChatOnly =
    overrides.copilotChatOnly !== undefined
      ? overrides.copilotChatOnly
      : base.copilotChatOnly;
  const filter =
    overrides.filter !== undefined
      ? overrides.filter
      : base.graphFilterExplicit ||
        (copilotChatOnly ? buildCopilotChatOnlyFilter() : "");

  let interactions = await fetchAllEnterpriseInteractions({
    accessToken,
    apiVersion: overrides.apiVersion ?? base.apiVersion,
    userId,
    top: overrides.top ?? base.top,
    filter: filter || undefined,
  });

  if (copilotChatOnly) {
    interactions = interactions.filter((item) =>
      isCopilotChatSurface(item.appClass)
    );
  }

  return interactions;
}
