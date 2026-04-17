import { useState } from "react";

const CLOUDS = [
  {
    id: "copilot",
    name: "Microsoft Copilot",
    icon: "/copilot-icon.png",
    iconType: "img",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    icon: "/gemini-icon.svg",
    iconType: "img",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    icon: null,
    iconType: "svg",
  },
];

const VALID_COMBOS = [
  { source: "copilot", dest: "gemini" },
  { source: "gemini", dest: "copilot" },
  { source: "chatgpt", dest: "gemini" },
];

function ChatGPTIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="24" fill="#10a37f" />
      <path
        d="M33.6 21.6a6.01 6.01 0 0 0-5.16-8.28 6.01 6.01 0 0 0-9.72-1.68A6.02 6.02 0 0 0 10.68 17a6.01 6.01 0 0 0-1.08 6.12A6.01 6.01 0 0 0 14.76 31.4a6.01 6.01 0 0 0 9.72 1.68A6.02 6.02 0 0 0 32.52 27.8a6.01 6.01 0 0 0 1.08-6.2z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M22.2 18l-6 10.4h7.2L22.2 34" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M25.8 14l1.2 5.6-6 10.4h7.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function isValidCombo(sourceId, destId) {
  return VALID_COMBOS.some((c) => c.source === sourceId && c.dest === destId);
}

export default function CloudSelector({ onSelect }) {
  const [source, setSource] = useState(null);
  const [dest, setDest] = useState(null);

  const handleCloudClick = (cloudId, role) => {
    if (role === "source") {
      setSource(cloudId);
      if (dest === cloudId) setDest(null);
    } else {
      setDest(cloudId);
    }
  };

  const handleConfirm = () => {
    if (source && dest) {
      onSelect(`${source}-${dest}`);
    }
  };

  const renderCard = (cloud, role) => {
    const selected =
      (role === "source" && source === cloud.id) ||
      (role === "dest" && dest === cloud.id);

    const disabled =
      (role === "source" && dest === cloud.id) ||
      (role === "dest" && source === cloud.id) ||
      (role === "dest" && source && !isValidCombo(source, cloud.id)) ||
      (role === "source" && dest && !isValidCombo(cloud.id, dest));

    return (
      <div
        key={cloud.id}
        className={`cs-card ${selected ? "cs-card-selected" : ""} ${disabled ? "cs-card-disabled" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && handleCloudClick(cloud.id, role)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) handleCloudClick(cloud.id, role);
        }}
      >
        <div className="cs-card-icon">
          {cloud.iconType === "img" ? (
            <img src={cloud.icon} alt={cloud.name} width="48" height="48" />
          ) : (
            <ChatGPTIcon />
          )}
        </div>
        <div className="cs-card-name">{cloud.name}</div>
        {selected && (
          <span className="cs-card-check">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0129AC" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </span>
        )}
      </div>
    );
  };

  const comboLabel = source && dest
    ? `${CLOUDS.find((c) => c.id === source)?.name} → ${CLOUDS.find((c) => c.id === dest)?.name}`
    : null;

  return (
    <section className="panel cs-panel">
      <div className="panel-head">
        <h2>Select Migration Clouds</h2>
        <p className="panel-desc">
          Choose a source platform and a destination platform for the migration.
        </p>
      </div>

      <div className="cs-layout">
        <div className="cs-column">
          <div className="cs-column-header cs-column-header-source">Select Source</div>
          <div className="cs-cards">
            {CLOUDS.map((c) => renderCard(c, "source"))}
          </div>
        </div>

        <div className="cs-arrows">
          <svg width="40" height="24" viewBox="0 0 40 24" fill="none">
            <path d="M2 12h36M28 4l10 8-10 8" stroke="#0129AC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
          </svg>
        </div>

        <div className="cs-column">
          <div className="cs-column-header cs-column-header-dest">Select Destination</div>
          <div className="cs-cards">
            {CLOUDS.map((c) => renderCard(c, "dest"))}
          </div>
        </div>
      </div>

      {comboLabel && (
        <div className="cs-confirm-bar">
          <span className="cs-combo-label">{comboLabel}</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
          >
            Continue →
          </button>
        </div>
      )}
    </section>
  );
}
