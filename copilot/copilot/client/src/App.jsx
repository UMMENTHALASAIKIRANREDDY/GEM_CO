import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import AuthPanel from "./components/AuthPanel.jsx";
import CombinationPanel from "./components/CombinationPanel.jsx";
import MapPanel from "./components/MapPanel.jsx";
import MigratePanel from "./components/MigratePanel.jsx";
import ReportsPanel from "./components/ReportsPanel.jsx";
import MigrationLog from "./components/MigrationLog.jsx";
import SplitPane from "./components/SplitPane.jsx";

const STEP_ICONS = {
  connect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
  ),
  combo: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
  ),
  map: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  migrate: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  ),
  reports: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
  ),
};

function getStepsForMode() {
  return [
    { id: "connect", label: "Connect", icon: STEP_ICONS.connect },
    { id: "combo", label: "Select Combination", icon: STEP_ICONS.combo },
    { id: "map", label: "Map", icon: STEP_ICONS.map },
    { id: "migrate", label: "Migrate", icon: STEP_ICONS.migrate },
    { id: "reports", label: "Reports", icon: STEP_ICONS.reports },
  ];
}

const MODE_LABELS = {
  "copilot-gemini": "Copilot → Gemini",
  "gemini-copilot": "Gemini → Copilot",
};

export default function App() {
  const [migrationMode, setMigrationMode] = useState(null);
  const [settings, setSettings] = useState(null);
  const [authStatus, setAuthStatus] = useState(null);
  const [usersPayload, setUsersPayload] = useState(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [googleUsersPayload, setGoogleUsersPayload] = useState(null);
  const [loadingGoogleUsers, setLoadingGoogleUsers] = useState(false);
  const [mapping, setMapping] = useState([]);
  const [migrationResults, setMigrationResults] = useState([]);
  const [migrating, setMigrating] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("connect");

  // Migration log state
  const [logEntries, setLogEntries] = useState([]);
  const prevAuth = useRef({ sourceLoggedIn: false, googleLoggedIn: false });

  const addLog = useCallback((message, status = "info", detail = "") => {
    setLogEntries((prev) => [
      ...prev,
      { message, status, detail, timestamp: Date.now() },
    ]);
  }, []);

  const steps = getStepsForMode(migrationMode);

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch("/api/settings");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setSettings(j);
    } catch {
      setSettings(null);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const r = await fetch("/api/users");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      setUsersPayload(j);
      const count = j.users?.length ?? 0;
      addLog(`Loaded ${count} Microsoft user${count !== 1 ? "s" : ""}`, "success");
    } catch {
      setUsersPayload(null);
    } finally {
      setLoadingUsers(false);
    }
  }, [addLog]);

  const loadGoogleUsers = useCallback(async () => {
    setLoadingGoogleUsers(true);
    try {
      const r = await fetch("/api/google/users");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      setGoogleUsersPayload(j);
      const count = j.users?.length ?? 0;
      addLog(`Loaded ${count} Google user${count !== 1 ? "s" : ""}`, "success");
    } catch {
      setGoogleUsersPayload(null);
    } finally {
      setLoadingGoogleUsers(false);
    }
  }, [addLog]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (authStatus?.sourceLoggedIn && !usersPayload && !loadingUsers) {
      loadUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.sourceLoggedIn]);

  useEffect(() => {
    if (authStatus?.googleLoggedIn && !googleUsersPayload && !loadingGoogleUsers) {
      loadGoogleUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.googleLoggedIn]);

  // Log cloud connection/disconnection events
  useEffect(() => {
    if (!authStatus) return;
    const prev = prevAuth.current;

    if (authStatus.sourceLoggedIn && !prev.sourceLoggedIn) {
      addLog(
        `Microsoft 365 connected`,
        "success",
        authStatus.sourceUser || ""
      );
    } else if (!authStatus.sourceLoggedIn && prev.sourceLoggedIn) {
      addLog("Microsoft 365 disconnected", "warning");
    }

    if (authStatus.googleLoggedIn && !prev.googleLoggedIn) {
      addLog(
        `Google Workspace connected`,
        "success",
        authStatus.googleUser || ""
      );
    } else if (!authStatus.googleLoggedIn && prev.googleLoggedIn) {
      addLog("Google Workspace disconnected", "warning");
    }

    prevAuth.current = {
      sourceLoggedIn: !!authStatus.sourceLoggedIn,
      googleLoggedIn: !!authStatus.googleLoggedIn,
    };
  }, [authStatus, addLog]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get("auth") === "success" ||
      params.get("auth") === "google_success"
    ) {
      window.history.replaceState({}, "", "/");
      setTab("connect");
    }
  }, []);

  useEffect(() => {
    setError(null);
  }, [tab]);

  const handleModeChange = (mode) => {
    setMigrationMode(mode);
    setMapping([]);
    setMigrationResults([]);
    addLog(`Migration mode selected: ${MODE_LABELS[mode]}`, "info");
  };

  const handleMappingChange = (newMapping) => {
    setMapping(newMapping);
    const mapped = newMapping.filter((p) => p.sourceEmail && p.destEmail).length;
    addLog(`User mappings ready — ${mapped} users selected`, "info");
  };

  const handleMigrationComplete = (results) => {
    setMigrationResults(results);
    const succeeded = results.filter((r) => r.filesUploaded > 0 && r.errors.length === 0).length;
    const failed = results.filter((r) => r.filesUploaded === 0).length;
    const totalFiles = results.reduce((s, r) => s + r.filesUploaded, 0);

    if (failed === 0) {
      addLog(`Migration complete! ${totalFiles} files uploaded for ${results.length} user(s)`, "success");
    } else {
      addLog(`Migration finished — ${succeeded} succeeded, ${failed} failed`, succeeded > 0 ? "warning" : "error");
    }

    results.forEach((r) => {
      const status = r.filesUploaded > 0 && r.errors.length === 0 ? "success"
        : r.filesUploaded > 0 ? "warning" : "error";
      addLog(
        `${r.sourceDisplayName || r.sourceUserId}: ${r.filesUploaded} files, ${r.conversationsCount} conversations`,
        status,
        r.destUserEmail
      );
    });
  };

  const handleMigratingChange = (isMigrating) => {
    setMigrating(isMigrating);
    if (isMigrating) {
      addLog("Migration started — processing user data…", "info");
    }
  };

  const handleError = (err) => {
    setError(err);
    if (err) {
      addLog(err, "error");
    }
  };

  const titleText = migrationMode
    ? `${MODE_LABELS[migrationMode]} Migration`
    : "Cloud Migration Platform";

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-brand">
          <img src="/cloudfuze-logo.png" alt="CloudFuze" className="app-logo" />
          <h1>{titleText}</h1>
        </div>
        <div className="app-header-status">
          {migrationMode && (
            <span className="header-badge header-badge-ok" style={{ background: "rgba(255,255,255,0.18)" }}>
              {MODE_LABELS[migrationMode]}
            </span>
          )}
          {authStatus?.sourceLoggedIn && (
            <span className="header-badge header-badge-ok">
              Microsoft: {authStatus.sourceUser || "Connected"}
            </span>
          )}
          {authStatus?.googleLoggedIn && (
            <span className="header-badge header-badge-ok">
              Google: {authStatus.googleUser || "Connected"}
            </span>
          )}
        </div>
      </header>

      <nav className="stepper" aria-label="Primary">
        {steps.map(({ id, label, icon }, idx) => {
          const activeIdx = steps.findIndex((s) => s.id === tab);
          const state =
            idx < activeIdx ? "done" : idx === activeIdx ? "active" : "upcoming";
          return (
            <div key={id} className="stepper-item-wrap">
              {idx > 0 && (
                <div
                  className={`stepper-line ${state === "upcoming" ? "" : "stepper-line-done"}`}
                />
              )}
              <button
                type="button"
                className={`stepper-item stepper-${state}`}
                onClick={() => setTab(id)}
              >
                <span className="stepper-icon">{icon}</span>
                <span className="stepper-label">{label}</span>
              </button>
            </div>
          );
        })}
      </nav>

      <SplitPane
        defaultSplit={50}
        minLeft={30}
        minRight={25}
        left={
          <div className="app-body">
            {(() => {
              const stepIds = steps.map((s) => s.id);
              const curIdx = stepIds.indexOf(tab);
              const prevId = curIdx > 0 ? stepIds[curIdx - 1] : null;
              const nextId = curIdx < stepIds.length - 1 ? stepIds[curIdx + 1] : null;
              const canGoNext = tab !== "combo" || migrationMode;
              return (
                <div className="step-nav">
                  {prevId && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setTab(prevId)}
                    >
                      &larr; Back
                    </button>
                  )}
                  {nextId && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setTab(nextId)}
                      disabled={!canGoNext}
                      title={!canGoNext ? "Select a combination first" : ""}
                    >
                      Next &rarr;
                    </button>
                  )}
                </div>
              );
            })()}

            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            {tab === "connect" && (
              <AuthPanel
                authStatus={authStatus}
                onAuthStatusChange={setAuthStatus}
              />
            )}

            {tab === "combo" && (
              <CombinationPanel
                authStatus={authStatus}
                migrationMode={migrationMode}
                onModeChange={handleModeChange}
              />
            )}

            {tab === "map" && (
              <MapPanel
                msUsers={usersPayload}
                googleUsers={googleUsersPayload}
                loadingMsUsers={loadingUsers}
                loadingGoogleUsers={loadingGoogleUsers}
                mapping={mapping}
                onMappingChange={handleMappingChange}
                onError={handleError}
                migrationMode={migrationMode}
                addLog={addLog}
              />
            )}

            {tab === "migrate" && (
              <MigratePanel
                mapping={mapping}
                onMigrationComplete={handleMigrationComplete}
                onSwitchTab={setTab}
                onError={handleError}
                setMigrating={handleMigratingChange}
                migrationMode={migrationMode}
                addLog={addLog}
              />
            )}

            {tab === "reports" && (
              <ReportsPanel results={migrationResults} migrating={migrating} />
            )}
          </div>
        }
        right={
          <MigrationLog entries={logEntries} migrating={migrating} />
        }
      />
    </div>
  );
}
