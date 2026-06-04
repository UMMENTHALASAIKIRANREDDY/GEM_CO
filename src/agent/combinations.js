// src/agent/combinations.js
export const COMBINATIONS = {
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
  'gemini-gemini': {
    label: 'Google Workspace → Google Workspace',
    auth: ['google'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Select Accounts', 'Upload Data', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.googleAuthed) blockers.push('Google Workspace not connected');
      return blockers;
    },
    mappingsCount: (state) => state.g2g_mappings_count ?? 0,
    isLive: (state) => !!state.g2g_live,
    isDone: (state) => !!state.g2g_done,
  },
  'claude-copilot': {
    label: 'Claude (Anthropic) → Microsoft 365 Copilot',
    auth: ['microsoft'],
    hasUpload: true,
    steps: ['Connect', 'Direction', 'Upload ZIP', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.msAuthed) blockers.push('Microsoft 365 not connected');
      return blockers;
    },
    mappingsCount: (state) => state.cl2c_mappings_count ?? 0,
    isLive: (state) => !!state.cl2c_live,
    isDone: (state) => !!state.cl2c_done,
  },
  'copilot-copilot': {
    label: 'Microsoft 365 Copilot → Microsoft 365 Copilot (cross-tenant)',
    auth: [], // uses per-tenant admin consent, not user OAuth
    hasUpload: false,
    steps: ['Connect Tenants', 'Direction', 'Select Tenants', 'Map Users', 'Options', 'Migration'],
    authCheck: (state) => {
      const blockers = [];
      if (!state.c2c_source_tenant_id) blockers.push('Source tenant not selected');
      if (!state.c2c_dest_tenant_id) blockers.push('Destination tenant not selected');
      return blockers;
    },
    mappingsCount: (state) => state.c2c_mappings_count ?? 0,
    isLive: (state) => !!state.c2c_live,
    isDone: (state) => !!state.c2c_done,
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
