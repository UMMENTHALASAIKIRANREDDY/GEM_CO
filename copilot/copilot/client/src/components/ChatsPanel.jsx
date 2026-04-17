import { useMemo, useRef, useState } from "react";

export default function ChatsPanel({ usersPayload, loadingUsers, onError, migrationMode, addLog }) {
  const [expandedUserId, setExpandedUserId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [expandedConvIdx, setExpandedConvIdx] = useState(null);
  const [query, setQuery] = useState("");

  // ChatGPT / Gemini import state
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const users = usersPayload?.users ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const dn = (u.displayName || "").toLowerCase();
      const upn = (u.userPrincipalName || "").toLowerCase();
      return dn.includes(q) || upn.includes(q);
    });
  }, [users, query]);

  const handleUserClick = async (userId) => {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      setConversations([]);
      setExpandedConvIdx(null);
      return;
    }

    setExpandedUserId(userId);
    setConversations([]);
    setExpandedConvIdx(null);
    setLoadingPreview(true);
    onError(null);
    try {
      const r = await fetch(
        `/api/users/${encodeURIComponent(userId)}/copilot/preview`
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setConversations(j.conversations || []);
    } catch (e) {
      onError(e.message || String(e));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setImportResult(null);
    onError(null);

    const endpoint = migrationMode === "chatgpt-gemini"
      ? "/api/chatgpt/upload"
      : "/api/gemini/upload";

    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(endpoint, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setImportResult(j);
      addLog?.(`Imported — ${j.userCount || 1} users, ${j.conversationCount || 0} conversations`, "success");
    } catch (err) {
      onError(err.message || String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Gemini import view
  if (migrationMode === "gemini-copilot") {
    return (
      <section className="panel" aria-labelledby="import-heading">
        <div className="panel-head">
          <h2 id="import-heading">Import Gemini Data</h2>
          <p className="panel-desc">
            Upload a Google Vault export ZIP file containing Gemini
            conversation data, or use the automated Vault export feature (if
            configured) to pull conversations directly.
          </p>
        </div>

        <div className="toolbar">
          <label className="btn btn-primary" style={{ cursor: "pointer" }}>
            {uploading ? "Uploading…" : "Upload Vault Export ZIP"}
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              className="sr-only"
              onChange={handleFileUpload}
              disabled={uploading}
            />
          </label>
        </div>

        {importResult && (
          <div className="callout callout-success">
            Successfully imported {importResult.conversationCount || 0} conversations
            from {importResult.userCount || 0} user(s).
          </div>
        )}
      </section>
    );
  }

  // Default: Copilot chats preview
  return (
    <section className="panel" aria-labelledby="chats-heading">
      <div className="panel-head">
        <h2 id="chats-heading">Microsoft Copilot Chats</h2>
        <p className="panel-desc">
          Click on a user to view their Copilot chat conversations grouped by
          session.
        </p>
      </div>

      {loadingUsers && <p className="muted">Loading Microsoft users…</p>}

      {!loadingUsers && users.length === 0 && (
        <p className="muted">
          No Microsoft users found. Connect Microsoft on the Connect tab first.
        </p>
      )}

      {users.length > 0 && (
        <div className="search-row">
          <input
            type="search"
            className="input-search"
            placeholder="Search users…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <span className="muted search-count">
            {filtered.length} of {users.length} users
          </span>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="chats-user-list">
          {filtered.map((u) => {
            const isExpanded = expandedUserId === u.id;
            return (
              <div key={u.id} className="chats-user-item">
                <div
                  className={`chats-user-row ${isExpanded ? "chats-user-row-active" : ""}`}
                  onClick={() => handleUserClick(u.id)}
                >
                  <span className="chats-user-icon">
                    <svg width="16" height="16" viewBox="0 0 23 23"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>
                  </span>
                  <span className="chats-user-name">
                    {u.displayName || u.userPrincipalName}
                  </span>
                  <span className="chats-user-email mono">
                    {u.userPrincipalName}
                  </span>
                  <span className="chats-user-arrow">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                </div>

                {isExpanded && (
                  <div className="chats-user-convos">
                    {loadingPreview && (
                      <p className="muted" style={{ padding: "0.5rem 1rem" }}>
                        Loading conversations…
                      </p>
                    )}

                    {!loadingPreview && conversations.length === 0 && (
                      <p
                        className="muted"
                        style={{ padding: "0.5rem 1rem" }}
                      >
                        No Copilot conversations found.
                      </p>
                    )}

                    {conversations.map((c) => (
                      <div
                        key={c.index}
                        className={`chat-card ${expandedConvIdx === c.index ? "chat-card-expanded" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedConvIdx(
                            expandedConvIdx === c.index ? null : c.index
                          );
                        }}
                      >
                        <div className="chat-card-header">
                          <span className="chat-card-idx">#{c.index}</span>
                          <span className="chat-card-title">{c.title}</span>
                          <span className="chat-card-meta">
                            {c.messageCount} msg
                            {c.messageCount !== 1 ? "s" : ""}
                          </span>
                          <span className="chat-card-date">
                            {c.date
                              ? new Date(c.date).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })
                              : ""}
                          </span>
                        </div>
                        {expandedConvIdx === c.index && (
                          <div className="chat-card-details">
                            <div className="chat-detail-row">
                              <span className="chat-detail-label">
                                Session ID
                              </span>
                              <span className="mono">{c.sessionId}</span>
                            </div>
                            <div className="chat-detail-row">
                              <span className="chat-detail-label">
                                First message
                              </span>
                              <span>
                                {c.date
                                  ? new Date(c.date).toLocaleString()
                                  : "—"}
                              </span>
                            </div>
                            <div className="chat-detail-row">
                              <span className="chat-detail-label">
                                Last message
                              </span>
                              <span>
                                {c.lastDate
                                  ? new Date(c.lastDate).toLocaleString()
                                  : "—"}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
