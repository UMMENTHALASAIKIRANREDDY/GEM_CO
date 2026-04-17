import { useMemo, useState } from "react";

const MODE_DESC = {
  "copilot-gemini": "Each user's Copilot conversations will be exported as DOCX files and uploaded to a CopilotChats folder in the destination user's Google Drive.",
  "gemini-copilot": "Each user's Gemini conversations will be migrated to OneNote pages and associated Drive files will be transferred to OneDrive.",
};

export default function MigratePanel({
  mapping,
  onMigrationComplete,
  onSwitchTab,
  onError,
  setMigrating: setParentMigrating,
  migrationMode,
  addLog,
}) {
  const [selected, setSelected] = useState(new Set());
  const [migrating, setMigrating] = useState(false);

  const validPairs = useMemo(
    () => mapping.filter((p) => p.sourceUserId && p.destEmail),
    [mapping]
  );

  const toggleAll = () => {
    if (selected.size === validPairs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(validPairs.map((p) => p.sourceUserId)));
    }
  };

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const startMigration = async () => {
    if (selected.size === 0) return;
    setMigrating(true);
    setParentMigrating(true);
    onError(null);
    onSwitchTab("reports");

    const endpoint = "/api/migrate";

    try {
      const pairs = validPairs.filter((p) => selected.has(p.sourceUserId));
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs, mode: migrationMode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onMigrationComplete(j.results || []);
    } catch (err) {
      onError(err.message || String(err));
    } finally {
      setMigrating(false);
      setParentMigrating(false);
    }
  };

  const srcLabel = migrationMode === "gemini-copilot" ? "Google User" : "Microsoft User";
  const srcEmailLabel = migrationMode === "gemini-copilot" ? "Google Email" : "Microsoft Email";
  const destLabel = migrationMode === "gemini-copilot" ? "Microsoft Destination" : "Google Destination";

  return (
    <section className="panel" aria-labelledby="migrate-heading">
      <div className="panel-head">
        <h2 id="migrate-heading">Migrate</h2>
        <p className="panel-desc">
          Select mapped user pairs and start migration.{" "}
          {MODE_DESC[migrationMode] || ""}
        </p>
      </div>

      {validPairs.length === 0 && (
        <div className="callout callout-warn">
          No valid user pairs found. Go to the <strong>Map</strong> tab and
          assign destination emails to source users first.
        </div>
      )}

      {validPairs.length > 0 && (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="btn btn-primary"
              onClick={startMigration}
              disabled={migrating || selected.size === 0}
            >
              {migrating
                ? "Migrating…"
                : `Start Migration (${selected.size} user${selected.size === 1 ? "" : "s"})`}
            </button>
            <span className="muted toolbar-hint">
              {selected.size} of {validPairs.length} selected
            </span>
          </div>

          <div className="table-wrap">
            <table className="table-compact">
              <thead>
                <tr>
                  <th className="th-check">
                    <input
                      type="checkbox"
                      checked={selected.size === validPairs.length}
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th>{srcLabel}</th>
                  <th>{srcEmailLabel}</th>
                  <th>{destLabel}</th>
                </tr>
              </thead>
              <tbody>
                {validPairs.map((p) => (
                  <tr key={p.sourceUserId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(p.sourceUserId)}
                        onChange={() => toggle(p.sourceUserId)}
                      />
                    </td>
                    <td>{p.sourceDisplayName || "—"}</td>
                    <td className="mono">{p.sourceEmail || "—"}</td>
                    <td className="mono">{p.destEmail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
