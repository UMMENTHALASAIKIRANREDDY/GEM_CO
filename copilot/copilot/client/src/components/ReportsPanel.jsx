import { useMemo, useState } from "react";

export default function ReportsPanel({ results, migrating }) {
  const [expandedIdx, setExpandedIdx] = useState(null);

  const summary = useMemo(() => {
    const total = results.length;
    const succeeded = results.filter(
      (r) => r.filesUploaded > 0 && r.errors.length === 0
    ).length;
    const partial = results.filter(
      (r) => r.filesUploaded > 0 && r.errors.length > 0
    ).length;
    const failed = results.filter((r) => r.filesUploaded === 0).length;
    const totalConversations = results.reduce(
      (s, r) => s + r.conversationsCount,
      0
    );
    const totalFiles = results.reduce((s, r) => s + r.filesUploaded, 0);
    return { total, succeeded, partial, failed, totalConversations, totalFiles };
  }, [results]);

  if (migrating) {
    return (
      <section className="panel" aria-labelledby="reports-heading">
        <div className="panel-head">
          <h2 id="reports-heading">Migration Reports</h2>
          <p className="panel-desc">
            Migration is currently running. Please wait while files are being
            generated and uploaded.
          </p>
        </div>
        <div className="migrate-progress">
          <div className="migrate-progress-bar" />
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            Migration in progress — this may take several minutes for large
            datasets. Do not close this page.
          </p>
        </div>
      </section>
    );
  }

  if (results.length === 0) {
    return (
      <section className="panel" aria-labelledby="reports-heading">
        <div className="panel-head">
          <h2 id="reports-heading">Migration Reports</h2>
        </div>
        <p className="muted" style={{ marginTop: "1rem" }}>
          No migration results yet. Go to the <strong>Migrate</strong> tab to
          start a migration.
        </p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="reports-heading">
      <div className="panel-head">
        <h2 id="reports-heading">Migration Reports</h2>
      </div>

      <div className="callout callout-success" style={{ marginTop: "0.5rem" }}>
        Migration completed successfully.
      </div>

      <div className="settings-grid" style={{ marginTop: "1rem" }}>
        <div className="stat-card">
          <span className="stat-label">Total Pairs</span>
          <span className="stat-value">{summary.total}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Succeeded</span>
          <span className="stat-ok">{summary.succeeded}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Partial</span>
          <span className="stat-value">{summary.partial}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Failed</span>
          <span className="stat-bad">{summary.failed}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Conversations</span>
          <span className="stat-value">{summary.totalConversations}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Files Uploaded</span>
          <span className="stat-value">{summary.totalFiles}</span>
        </div>
      </div>

      <div className="table-wrap" style={{ marginTop: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>Microsoft User</th>
              <th>Destination</th>
              <th>Conversations</th>
              <th>Files</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, idx) => {
              const hasErrors = r.errors.length > 0;
              const status =
                r.filesUploaded > 0 && !hasErrors
                  ? "success"
                  : r.filesUploaded > 0 && hasErrors
                    ? "partial"
                    : "failed";
              return (
                <tr
                  key={idx}
                  className="report-row"
                  onClick={() =>
                    setExpandedIdx(expandedIdx === idx ? null : idx)
                  }
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    {r.sourceDisplayName}
                    <br />
                    <span className="mono muted" style={{ fontSize: "0.72rem" }}>
                      {r.sourceUserId}
                    </span>
                  </td>
                  <td className="mono">{r.destUserEmail}</td>
                  <td>{r.conversationsCount}</td>
                  <td>{r.filesUploaded}</td>
                  <td>
                    <span
                      className={`cloud-badge ${
                        status === "success"
                          ? "cloud-badge-ok"
                          : status === "partial"
                            ? "badge-pending"
                            : "badge-fail"
                      }`}
                    >
                      {status}
                    </span>
                    {expandedIdx === idx && hasErrors && (
                      <div className="report-errors">
                        {r.errors.map((err, ei) => (
                          <p key={ei} className="report-error-line">
                            {err}
                          </p>
                        ))}
                      </div>
                    )}
                    {expandedIdx === idx &&
                      r.files &&
                      r.files.length > 0 && (
                        <div className="report-files">
                          <p
                            className="muted"
                            style={{
                              fontSize: "0.75rem",
                              marginTop: "0.5rem",
                            }}
                          >
                            Uploaded files:
                          </p>
                          {r.files.map((f, fi) => (
                            <p key={fi} style={{ fontSize: "0.78rem" }}>
                              {f.webViewLink ? (
                                <a
                                  href={f.webViewLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {f.name}
                                </a>
                              ) : (
                                f.name
                              )}
                              {f.title && (
                                <span className="muted"> — {f.title}</span>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
