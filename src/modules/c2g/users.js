/**
 * List all users in the directory (object IDs) via Microsoft Graph.
 * Requires application permission: User.Read.All (admin consent).
 * @see https://learn.microsoft.com/graph/api/user-list
 */

function buildUsersUrl(apiVersion, { select, filter, top }) {
  const v = apiVersion === "beta" ? "beta" : "v1.0";
  const u = new URL(`https://graph.microsoft.com/${v}/users`);
  u.searchParams.set(
    "$select",
    select || "id,displayName,userPrincipalName,accountEnabled"
  );
  u.searchParams.set("$top", String(Math.min(999, Math.max(1, top || 999))));
  if (filter && String(filter).trim()) {
    u.searchParams.set("$filter", String(filter).trim());
  }
  return u.toString();
}

/**
 * @returns {Promise<Array<{ id: string, displayName?: string, userPrincipalName?: string, accountEnabled?: boolean }>>}
 */
export async function fetchAllDirectoryUsers({
  accessToken,
  apiVersion,
  usersFilter,
  pageSize,
}) {
  let url = buildUsersUrl(apiVersion, {
    filter: usersFilter,
    top: pageSize || 999,
  });
  const rows = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        data.error?.message ||
        data.error_description ||
        data.error ||
        res.statusText;
      throw new Error(`Graph users list failed (${res.status}): ${msg}`);
    }

    const batch = Array.isArray(data.value) ? data.value : [];
    for (const u of batch) {
      if (u?.id) {
        rows.push({
          id: u.id,
          displayName: u.displayName ?? null,
          userPrincipalName: u.userPrincipalName ?? null,
          accountEnabled: u.accountEnabled,
        });
      }
    }

    const next = data["@odata.nextLink"];
    url = typeof next === "string" && next.length > 0 ? next : null;
  }

  return rows;
}
