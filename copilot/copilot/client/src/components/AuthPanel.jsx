import { useEffect, useState } from "react";

export default function AuthPanel({ authStatus, onAuthStatusChange }) {
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    setChecking(true);
    try {
      const r = await fetch("/auth/status");
      if (r.ok) {
        const j = await r.json();
        onAuthStatusChange(j);
      }
    } catch {
      /* ignore */
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!authStatus?.sourceLoggedIn || !authStatus?.googleLoggedIn) refresh();
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.sourceLoggedIn, authStatus?.googleLoggedIn]);

  const openMsLogin = () => { window.location.href = "/auth/source/login"; };
  const msLogout = async () => { await fetch("/auth/source/logout", { method: "POST" }); refresh(); };
  const openGoogleLogin = () => { window.location.href = "/auth/google/login"; };
  const googleLogout = async () => { await fetch("/auth/google/logout", { method: "POST" }); refresh(); };

  const msConnected = !!authStatus?.sourceLoggedIn;
  const googleConnected = !!authStatus?.googleLoggedIn;

  const connectedClouds = [];
  if (msConnected) {
    connectedClouds.push({
      id: "microsoft",
      name: "Microsoft 365",
      icon: "/copilot-icon.png",
      user: authStatus.sourceUser || "",
      onDisconnect: msLogout,
    });
  }
  if (googleConnected) {
    connectedClouds.push({
      id: "google",
      name: "Google Workspace",
      icon: "/gemini-icon.svg",
      user: authStatus.googleUser || "",
      onDisconnect: googleLogout,
    });
  }

  return (
    <section className="auth-panel panel" aria-labelledby="auth-heading">
      <div className="panel-head">
        <h2 id="auth-heading">Connect Cloud Accounts</h2>
        <p className="panel-desc">
          Connect the admin accounts for the platforms you want to migrate between.
        </p>
      </div>

      <div className="cloud-cards">
        {!msConnected && (
          <div
            className="cloud-card"
            role="button"
            tabIndex={0}
            onClick={openMsLogin}
            onKeyDown={(e) => { if (e.key === "Enter") openMsLogin(); }}
          >
            <div className="cloud-card-icon">
              <img src="/copilot-icon.png" alt="Microsoft" width="56" height="56" />
            </div>
            <div className="cloud-card-name">Microsoft 365</div>
            <div className="cloud-card-hint">Click to connect</div>
          </div>
        )}

        {!googleConnected && (
          <div
            className="cloud-card"
            role="button"
            tabIndex={0}
            onClick={openGoogleLogin}
            onKeyDown={(e) => { if (e.key === "Enter") openGoogleLogin(); }}
          >
            <div className="cloud-card-icon">
              <img src="/gemini-icon.svg" alt="Google" width="56" height="56" />
            </div>
            <div className="cloud-card-name">Google Workspace</div>
            <div className="cloud-card-hint">Click to connect</div>
          </div>
        )}

        {msConnected && googleConnected && (
          <div className="callout callout-success" style={{ margin: 0 }}>
            All available clouds are connected. Proceed to <strong>Select Combination</strong>.
          </div>
        )}
      </div>

      {checking && (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Checking sessions…
        </p>
      )}

      {connectedClouds.length > 0 && (
        <div className="mc-section">
          <h3 className="mc-title">Manage Clouds</h3>
          <div className="mc-list">
            {connectedClouds.map((cloud) => (
              <div key={cloud.id} className="mc-row">
                <div className="mc-icon">
                  <img src={cloud.icon} alt={cloud.name} width="32" height="32" />
                </div>
                <div className="mc-info">
                  <div className="mc-name">{cloud.name}</div>
                  <div className="mc-user">{cloud.user}</div>
                </div>
                <span className="mc-badge">Connected</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small mc-disconnect"
                  onClick={cloud.onDisconnect}
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
