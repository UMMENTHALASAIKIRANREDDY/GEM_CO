// src/agent/combinations.js
export const COMBINATIONS = {
  'gemini-copilot': {
    label: 'Google Workspace → Microsoft 365',
    auth: ['google', 'microsoft'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Import Data', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      if (!state.msAuthed) blockers.push('Microsoft 365 not connected');
      return blockers;
    },
    mappingsCount: (state) => state.mappings_count ?? 0,
    isLive: (state) => !!state.live,
    isDone: (state) => !!state.migDone,
  },
  'copilot-gemini': {
    label: 'Microsoft 365 Copilot → Google Workspace',
    auth: ['microsoft', 'google'],
    hasUpload: false,
    steps: ['Connect', 'Direction', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.msAuthed) blockers.push('Microsoft 365 not connected');
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      return blockers;
    },
    mappingsCount: (state) => state.c2g_mappings_count ?? 0,
    isLive: (state) => !!state.c2g_live,
    isDone: (state) => !!state.c2g_done,
  },
  'claude-gemini': {
    label: 'Claude (Anthropic) → Google Workspace',
    auth: ['google'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Upload ZIP', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      return blockers;
    },
    mappingsCount: (state) => state.cl2g_mappings_count ?? 0,
    isLive: (state) => !!state.cl2g_live,
    isDone: (state) => !!state.cl2g_done,
  },
};

export function getCombo(migDir) {
  return COMBINATIONS[migDir] ?? null;
}

export function listCombinations() {
  return Object.entries(COMBINATIONS).map(([key, c]) => ({
    key,
    label: c.label,
    auth: c.auth,
    hasUpload: c.hasUpload,
  }));
}
