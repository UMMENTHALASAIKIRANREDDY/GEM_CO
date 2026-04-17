import { useEffect, useMemo, useRef, useState } from "react";

export default function MapPanel({
  msUsers,
  googleUsers,
  loadingMsUsers,
  loadingGoogleUsers,
  mapping,
  onMappingChange,
  onError,
  migrationMode,
  addLog,
}) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);

  const msUserList = msUsers?.users ?? [];
  const gUserList = googleUsers?.users ?? [];

  // Only auto-map if mapping is completely empty (never been set)
  useEffect(() => {
    if (mapping.length > 0) return;
    if (msUserList.length > 0 && gUserList.length > 0) {
      const auto = buildAutoMapping(msUserList, gUserList);
      onMappingChange(auto);
    } else if (msUserList.length > 0 && gUserList.length === 0) {
      const auto = msUserList.map((ms) => ({
        sourceUserId: ms.id,
        sourceEmail: ms.userPrincipalName || "",
        sourceDisplayName: ms.displayName || "",
        destEmail: "",
      }));
      onMappingChange(auto);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msUserList.length, gUserList.length]);

  function buildAutoMapping(msList, gList) {
    const gEmailMap = new Map();
    for (const g of gList) {
      gEmailMap.set((g.email || "").toLowerCase(), g);
    }

    const usedGoogleEmails = new Set();
    const pairs = [];

    for (const ms of msList) {
      const msEmail = (ms.userPrincipalName || "").toLowerCase();
      const match = gEmailMap.get(msEmail);
      if (match) {
        usedGoogleEmails.add(match.email.toLowerCase());
        pairs.push({
          sourceUserId: ms.id,
          sourceEmail: ms.userPrincipalName || "",
          sourceDisplayName: ms.displayName || "",
          destEmail: match.email,
          destName: match.name || match.email,
        });
      } else {
        pairs.push({
          sourceUserId: ms.id,
          sourceEmail: ms.userPrincipalName || "",
          sourceDisplayName: ms.displayName || "",
          destEmail: "",
          destName: "",
        });
      }
    }

    for (const g of gList) {
      if (!usedGoogleEmails.has((g.email || "").toLowerCase())) {
        pairs.push({
          sourceUserId: "",
          sourceEmail: "",
          sourceDisplayName: "",
          destEmail: g.email,
          destName: g.name || g.email,
        });
      }
    }

    return pairs;
  }

  // Sorted: mapped first, then unmapped
  const sortedMapping = useMemo(() => {
    return [...mapping].sort((a, b) => {
      const aMapped = Boolean(a.sourceEmail && a.destEmail);
      const bMapped = Boolean(b.sourceEmail && b.destEmail);
      if (aMapped === bMapped) return 0;
      return aMapped ? -1 : 1;
    });
  }, [mapping]);

  const downloadCsv = () => {
    const header = "sourceEmail,destEmail\n";
    const rows = sortedMapping
      .filter((p) => p.sourceEmail || p.destEmail)
      .map((p) => `${p.sourceEmail},${p.destEmail}`)
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "user-mapping.csv";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  };

  const uploadCsv = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/mapping/csv", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onMappingChange(j.pairs || []);

      await fetch("/api/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: j.pairs || [] }),
      });

      const mapped = (j.pairs || []).filter((p) => p.sourceEmail && p.destEmail).length;
      setUploadMsg(`CSV uploaded — ${mapped} of ${(j.pairs || []).length} pairs mapped.`);
      addLog?.(`CSV mapping uploaded — ${mapped} of ${(j.pairs || []).length} pairs mapped`, "success");
      setTimeout(() => setUploadMsg(null), 5000);
    } catch (err) {
      onError(err.message || String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const mappedCount = useMemo(
    () => mapping.filter((p) => p.sourceEmail && p.destEmail).length,
    [mapping]
  );
  const unmappedCount = mapping.length - mappedCount;

  const isLoading = loadingMsUsers || loadingGoogleUsers;

  const srcHeader = migrationMode === "gemini-copilot" ? "Google Users" : "Source Users";
  const destHeader = migrationMode === "gemini-copilot" ? "Microsoft Users" : "Destination Users";

  return (
    <section className="panel" aria-labelledby="map-heading">
      <div className="panel-head">
        <h2 id="map-heading">User Mapping</h2>
        <p className="panel-desc">
          Users are auto-matched by email. Mapped users appear at the top.
          Download the CSV to manually edit mappings, then upload to apply
          changes.
        </p>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={downloadCsv}
          disabled={mapping.length === 0}
        >
          Download CSV
        </button>
        <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
          {uploading ? "Uploading…" : "Upload CSV"}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="sr-only"
            onChange={uploadCsv}
          />
        </label>
        {mapping.length > 0 && (
          <span className="muted toolbar-hint">
            {mappedCount} mapped · {unmappedCount} unmapped
          </span>
        )}
      </div>

      {uploadMsg && (
        <div className="callout callout-success">{uploadMsg}</div>
      )}

      {isLoading && (
        <div className="migrate-progress">
          <div className="migrate-progress-bar" />
          <p className="muted">Loading users…</p>
        </div>
      )}

      {!isLoading && mapping.length === 0 && (
        <p className="muted" style={{ marginTop: "1rem" }}>
          Connect both Microsoft and Google on the Connect tab to see user
          mappings.
        </p>
      )}

      {sortedMapping.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="map-th-icon"></th>
                <th>{srcHeader}</th>
                <th className="map-th-icon"></th>
                <th>{destHeader}</th>
                <th>Mapping Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedMapping.map((pair, idx) => {
                const isMapped = Boolean(pair.sourceEmail && pair.destEmail);
                return (
                  <tr key={idx} className={isMapped ? "" : "map-row-unmapped"}>
                    <td className="map-icon-cell">
                      {pair.sourceEmail && (
                        <span className="map-icon map-icon-ms" title="Microsoft">
                          <svg width="16" height="16" viewBox="0 0 23 23"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>
                        </span>
                      )}
                    </td>
                    <td className={pair.sourceEmail ? "" : "muted"}>
                      {pair.sourceEmail || "–"}
                    </td>
                    <td className="map-icon-cell">
                      {pair.destEmail && (
                        <span className="map-icon map-icon-google" title="Google">
                          <svg width="16" height="16" viewBox="0 0 48 48"><path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.99 23.99 0 0 0 0 24c0 3.77.9 7.35 2.56 10.52l7.97-5.93z"/><path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 5.93C6.51 42.62 14.62 48 24 48z"/></svg>
                        </span>
                      )}
                    </td>
                    <td className={pair.destEmail ? "" : "muted"}>
                      {pair.destEmail || "–"}
                    </td>
                    <td>
                      <span
                        className={`map-status ${isMapped ? "map-status-mapped" : "map-status-unmapped"}`}
                      >
                        {isMapped ? "Mapped" : "Unmapped"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
