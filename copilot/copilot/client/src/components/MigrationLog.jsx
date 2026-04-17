import { useEffect, useRef } from "react";

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <polyline points="20 6 9 17 4 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CompletionCheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="#fff" strokeWidth="2" />
      <polyline points="8 12 11 15 16 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusIcon({ status }) {
  if (status === "success") return <CheckIcon />;
  if (status === "warning") return <WarnIcon />;
  if (status === "error") return <ErrorIcon />;
  return <InfoIcon />;
}

function CatIcon() {
  return (
    <span className="mlog-cat">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="7" width="18" height="14" rx="2" stroke="#fff" strokeWidth="2" />
        <path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" stroke="#fff" strokeWidth="2" />
        <circle cx="12" cy="14" r="2" fill="#fff" />
      </svg>
    </span>
  );
}

export default function MigrationLog({ entries, migrating }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  const statusLabel = migrating ? "Running" : entries.length > 0 ? "Ready" : "Waiting";
  const statusClass = migrating ? "mlog-st-running" : entries.length > 0 ? "mlog-st-ready" : "mlog-st-waiting";

  const isCompletionEntry = (msg) => {
    const lower = (msg || "").toLowerCase();
    return lower.includes("migration complete") || lower.includes("reports saved");
  };

  return (
    <aside className="mlog-panel" aria-label="Migration Log">
      <div className="mlog-header">
        <h3 className="mlog-title">Migration Log</h3>
        <span className={`mlog-hdr-status ${statusClass}`}>
          <span className="mlog-hdr-dot" />
          {statusLabel}
        </span>
      </div>

      <div className="mlog-list">
        {entries.length === 0 && (
          <div className="mlog-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <p className="mlog-empty-title">No activity yet</p>
            <p className="mlog-empty-sub">Events will appear here as you connect clouds, import data, map users, and run migrations.</p>
          </div>
        )}

        {entries.map((entry, i) => {
          const completion = isCompletionEntry(entry.message);

          if (completion) {
            return (
              <div key={i} className="mlog-row">
                <CatIcon />
                <div className="mlog-pill mlog-pill-completion">
                  <CompletionCheckIcon />
                  <span className="mlog-pill-time">{formatTime(entry.timestamp)}</span>
                  <span className="mlog-pill-dashes">------</span>
                  <span className="mlog-pill-msg">{entry.message}</span>
                  <span className="mlog-pill-dashes">------</span>
                </div>
              </div>
            );
          }

          const pillClass = entry.status === "success" ? "mlog-pill-success"
            : entry.status === "error" ? "mlog-pill-error"
            : entry.status === "warning" ? "mlog-pill-warn"
            : "mlog-pill-info";

          return (
            <div key={i} className="mlog-row">
              <CatIcon />
              <div className={`mlog-pill ${pillClass}`}>
                <span className="mlog-pill-icon">
                  <StatusIcon status={entry.status} />
                </span>
                <span className="mlog-pill-time">{formatTime(entry.timestamp)}</span>
                <span className="mlog-pill-msg">{entry.message}</span>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
