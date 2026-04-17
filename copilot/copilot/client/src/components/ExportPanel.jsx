import { useMemo, useState } from "react";
import { downloadJson } from "../utils/downloadJson.js";

export default function ExportPanel({
  settings,
  usersPayload,
  loadingUsers,
  onLoadUsers,
  onError,
}) {
  const [loadingExport, setLoadingExport] = useState(false);
  const [loadingExportDocx, setLoadingExportDocx] = useState(false);
  const [loadingUserId, setLoadingUserId] = useState(null);
  const [loadingDocxUserId, setLoadingDocxUserId] = useState(null);
  const [query, setQuery] = useState("");

  const users = usersPayload?.users ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const dn = (u.displayName || "").toLowerCase();
      const upn = (u.userPrincipalName || "").toLowerCase();
      const id = (u.id || "").toLowerCase();
      return dn.includes(q) || upn.includes(q) || id.includes(q);
    });
  }, [users, query]);

  const downloadAll = async () => {
    onError(null);
    setLoadingExport(true);
    try {
      const r = await fetch("/api/export/all");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      downloadJson(
        `copilot-export-all-${new Date().toISOString().slice(0, 10)}.json`,
        j
      );
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingExport(false);
    }
  };

  const downloadUser = async (userId) => {
    onError(null);
    setLoadingUserId(userId);
    try {
      const q =
        settings?.copilotChatOnly === false ? "?copilotChatOnly=false" : "";
      const r = await fetch(
        `/api/users/${encodeURIComponent(userId)}/copilot${q}`
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error || j.message || `HTTP ${r.status}`);
      }
      const safe = userId.replace(/[^a-z0-9-]/gi, "_").slice(0, 36);
      downloadJson(`copilot-${safe}.json`, j);
      if (j.error) {
        onError(
          `File saved; Graph returned an issue for this user (see "error" in the JSON): ${j.error}`
        );
      }
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingUserId(null);
    }
  };

  const downloadUserDocx = async (userId, displayName) => {
    onError(null);
    setLoadingDocxUserId(userId);
    try {
      const q =
        settings?.copilotChatOnly === false ? "&copilotChatOnly=false" : "";
      const dn = encodeURIComponent(displayName || userId);
      const r = await fetch(
        `/api/users/${encodeURIComponent(userId)}/copilot/docx?displayName=${dn}${q}`
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || j.message || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const safe = userId.replace(/[^a-z0-9-]/gi, "_").slice(0, 36);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `copilot-${safe}.docx`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 500);
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingDocxUserId(null);
    }
  };

  const downloadAllDocx = async () => {
    onError(null);
    setLoadingExportDocx(true);
    try {
      const r = await fetch("/api/export/all/docx");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || j.message || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const dateStr = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `copilot-export-all-${dateStr}.docx`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 500);
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingExportDocx(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="export-heading">
      <div className="panel-head">
        <h2 id="export-heading">Export Copilot Chats</h2>
        <p className="panel-desc">
          Load directory users, then download their Copilot chat interactions
          as <strong>JSON</strong> (raw data) or <strong>DOCX</strong>{" "}
          (formatted Word document with conversations grouped neatly).
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onLoadUsers}
          disabled={loadingUsers}
        >
          {loadingUsers ? "Loading users…" : "Load all users"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={downloadAll}
          disabled={loadingExport}
        >
          {loadingExport
            ? "Building full export…"
            : "Download JSON — all users"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={downloadAllDocx}
          disabled={loadingExportDocx}
        >
          {loadingExportDocx
            ? "Building DOCX…"
            : "Download DOCX — all users"}
        </button>
        <span className="muted toolbar-hint">
          Full export can take several minutes for large tenants.
        </span>
      </div>

      {usersPayload && (
        <p className="meta-line">
          <strong>{usersPayload.count}</strong> user(s) · loaded at{" "}
          {usersPayload.generatedAt}
        </p>
      )}

      {users.length > 0 && (
        <div className="search-row">
          <label className="search-label" htmlFor="user-filter">
            Filter table
          </label>
          <input
            id="user-filter"
            type="search"
            className="input-search"
            placeholder="Search by name, UPN, or object id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <span className="muted search-count">
            Showing {filtered.length} of {users.length}
          </span>
        </div>
      )}

      {users.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Display name</th>
                <th>User principal name</th>
                <th>Object id</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName ?? "—"}</td>
                  <td className="mono">{u.userPrincipalName ?? "—"}</td>
                  <td className="mono">{u.id}</td>
                  <td>
                    {u.accountEnabled === undefined
                      ? "—"
                      : String(u.accountEnabled)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={loadingUserId === u.id}
                      onClick={() => downloadUser(u.id)}
                    >
                      {loadingUserId === u.id ? "…" : "JSON"}
                    </button>
                    {" "}
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={loadingDocxUserId === u.id}
                      onClick={() => downloadUserDocx(u.id, u.displayName)}
                    >
                      {loadingDocxUserId === u.id ? "…" : "DOCX"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loadingUsers && usersPayload && users.length === 0 && (
        <p className="muted">No users returned.</p>
      )}

      {!loadingUsers && usersPayload && filtered.length === 0 && users.length > 0 && (
        <p className="muted">No users match your filter.</p>
      )}
    </section>
  );
}
