/**
 * Microsoft Graph: getAllEnterpriseInteractions for a user.
 * @see https://learn.microsoft.com/graph/api/aiinteractionhistory-getallenterpriseinteractions
 */

function buildBaseUrl(apiVersion, userId) {
  const v = apiVersion === "beta" ? "beta" : "v1.0";
  return `https://graph.microsoft.com/${v}/copilot/users/${encodeURIComponent(userId)}/interactionHistory/getAllEnterpriseInteractions`;
}

const DEFAULT_SELECT = "id,sessionId,appClass,interactionType,createdDateTime,body,attachments,links";
const DEFAULT_EXPAND = "";

function appendQueryParams(url, { top, filter, select, expand }) {
  const u = new URL(url);
  if (top != null && top > 0) {
    u.searchParams.set("$top", String(top));
  }
  if (filter && String(filter).trim()) {
    u.searchParams.set("$filter", String(filter).trim());
  }
  if (select && String(select).trim()) {
    u.searchParams.set("$select", String(select).trim());
  }
  if (expand && String(expand).trim()) {
    u.searchParams.set("$expand", String(expand).trim());
  }
  return u.toString();
}

export async function fetchAllEnterpriseInteractions({
  accessToken,
  apiVersion,
  userId,
  top,
  filter,
  select,
  expand,
}) {
  let url = appendQueryParams(buildBaseUrl(apiVersion, userId), {
    top, filter,
    select: select || DEFAULT_SELECT,
    expand: expand !== undefined ? expand : DEFAULT_EXPAND,
  });
  const items = [];

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
      throw new Error(`Graph request failed (${res.status}): ${msg}`);
    }

    const batch = Array.isArray(data.value) ? data.value : [];
    items.push(...batch);

    const next = data["@odata.nextLink"];
    url = typeof next === "string" && next.length > 0 ? next : null;
  }

  return items;
}
