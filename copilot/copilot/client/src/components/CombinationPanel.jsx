const ALL_COMBOS = [
  { id: "copilot-gemini", source: "microsoft", dest: "google", label: "Microsoft Copilot → Google Gemini", desc: "Export Copilot chats as DOCX and upload to Google Drive" },
  { id: "gemini-copilot", source: "google", dest: "microsoft", label: "Google Gemini → Microsoft Copilot", desc: "Vault export Gemini conversations to OneNote pages" },
];

export default function CombinationPanel({ authStatus, migrationMode, onModeChange }) {
  const msConnected = !!authStatus?.sourceLoggedIn;
  const googleConnected = !!authStatus?.googleLoggedIn;

  const availableCombos = ALL_COMBOS.filter((c) => {
    if (c.source === "microsoft" && !msConnected) return false;
    if (c.source === "google" && !googleConnected) return false;
    if (c.dest === "microsoft" && !msConnected) return false;
    if (c.dest === "google" && !googleConnected) return false;
    return true;
  });

  const noClouds = !msConnected && !googleConnected;

  return (
    <section className="panel" aria-labelledby="combo-heading">
      <div className="panel-head">
        <h2 id="combo-heading">Select Combination</h2>
        <p className="panel-desc">
          Choose a migration direction based on your connected clouds.
        </p>
      </div>

      {noClouds && (
        <div className="callout callout-warn">
          No clouds connected yet. Go to the <strong>Connect</strong> tab first to add your cloud accounts.
        </div>
      )}

      {!noClouds && availableCombos.length === 0 && (
        <div className="callout callout-warn">
          Connect at least one source and one destination cloud to see available combinations.
        </div>
      )}

      {availableCombos.length > 0 && (
        <div className="combo-grid">
          {availableCombos.map((combo) => {
            const isActive = migrationMode === combo.id;
            return (
              <div
                key={combo.id}
                className={`combo-card ${isActive ? "combo-card-active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => onModeChange(combo.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onModeChange(combo.id); }}
              >
                <div className="combo-card-icons">
                  {combo.source === "microsoft" && <img src="/copilot-icon.png" alt="" width="28" height="28" />}
                  {combo.source === "google" && <img src="/gemini-icon.svg" alt="" width="28" height="28" />}
                  <span className="combo-card-arrow">→</span>
                  {combo.dest === "google" && <img src="/gemini-icon.svg" alt="" width="28" height="28" />}
                  {combo.dest === "microsoft" && <img src="/copilot-icon.png" alt="" width="28" height="28" />}
                </div>
                <div className="combo-card-info">
                  <div className="combo-card-label">{combo.label}</div>
                  <div className="combo-card-desc">{combo.desc}</div>
                </div>
                {isActive && (
                  <span className="combo-card-check">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0129AC" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {migrationMode && (
        <div className="callout callout-success" style={{ marginTop: "1.25rem" }}>
          Selected: <strong>{ALL_COMBOS.find((c) => c.id === migrationMode)?.label}</strong>. Proceed to the next step.
        </div>
      )}
    </section>
  );
}
