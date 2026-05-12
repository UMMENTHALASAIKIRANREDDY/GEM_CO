// src/agent/tools.js

export const DESTRUCTIVE_TOOLS = ['start_migration', 'retry_failed'];

export const CONFIRMATION_MESSAGES = {
  start_migration: {
    dry: 'Ready to run a **dry run** — this is safe, no data will be written. Shall I proceed?',
    live: 'Ready to **go live** — this will write real data to the destination. Are you sure?',
  },
  retry_failed: {
    default: "I'll retry all failed items from the last batch. Want me to go ahead?",
  },
};

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'show_reports',
      description: 'Open the migration reports panel',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_mapping',
      description: 'Open the user mapping grid in the left panel',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_migration_status',
      description: 'Get current migration progress, stats, and state from the database',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_log',
      description: 'Explain what a migration log line means and suggest action',
      parameters: {
        type: 'object',
        properties: { log_line: { type: 'string', description: 'The exact log message text' } },
        required: ['log_line'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_status_card',
      description: 'Display a visual status card with migration stats',
      parameters: {
        type: 'object',
        properties: {
          users: { type: 'number', description: 'Users processed' },
          files: { type: 'number', description: 'Files/pages migrated' },
          errors: { type: 'number', description: 'Error count' },
          label: { type: 'string', description: 'Card title' },
        },
        required: ['users', 'files', 'errors'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_post_migration_guide',
      description: 'Show post-migration setup instructions when user asks what to do next after migration completes',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate_to_step',
      description: 'Navigate the left panel to a specific step. Use when user asks to go somewhere.',
      parameters: {
        type: 'object',
        properties: { step: { type: 'number', description: 'Step index: 0=Connect, 1=Direction, 2=Upload/Import, 3=Map Users, 4=Options, 5=Migration' } },
        required: ['step'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_direction',
      description: 'Set the migration direction and advance the left panel to the next step. Call when user says which direction they want. "claude-gemini" = Claude (Anthropic) → Google. "gemini-copilot" = Google → Microsoft 365. "copilot-gemini" = Microsoft 365 → Google.',
      parameters: {
        type: 'object',
        properties: { migDir: { type: 'string', enum: ['gemini-copilot', 'copilot-gemini', 'claude-gemini'], description: 'claude-gemini for Claude→Google, gemini-copilot for Google→Microsoft, copilot-gemini for Microsoft→Google' } },
        required: ['migDir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_migration',
      description: 'Start migration. Always call pre_flight_check first. Agent will ask user to confirm before this executes.',
      parameters: {
        type: 'object',
        properties: { dryRun: { type: 'boolean', description: 'true = dry run (safe preview), false = live migration (writes data)' } },
        required: ['dryRun'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed',
      description: 'Retry failed items from the last migration batch. Only call if migration is done and errors > 0.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_map_users',
      description: 'Automatically map source users to destination users by matching email addresses. Works for all directions.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_migration_config',
      description: 'Set migration options: folder name, date range, dry run toggle',
      parameters: {
        type: 'object',
        properties: {
          folderName: { type: 'string' },
          fromDate: { type: 'string' },
          toDate: { type: 'string' },
          dryRun: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pre_flight_check',
      description: 'Validate state before starting migration. Always call this before start_migration. Returns blockers and warnings.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_auth_status',
      description: 'Check which cloud accounts are currently authenticated by querying the database directly.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_error',
      description: 'Read migration error logs and explain what went wrong in plain English with suggested fixes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_conversation_history',
      description: 'Retrieve the conversation history for the current user session.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_schedule',
      description: 'Schedule a migration to run at a specific time. Use when user asks to run migration at a later time.',
      parameters: {
        type: 'object',
        properties: {
          runAt: { type: 'string', description: 'ISO datetime string for when to run' },
          dryRun: { type: 'boolean', description: 'Whether scheduled run should be dry run' },
        },
        required: ['runAt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_upload_widget',
      description: 'Inject an upload widget into the chat for the user to upload a file. Use widgetType="zip" when the user needs to upload a ZIP export file (Claude export for CL2G, Google Vault for G2C). Use widgetType="csv" when the user needs to upload a CSV to bulk-import user mappings. Only call this when the user is at the correct step and needs to upload.',
      parameters: {
        type: 'object',
        properties: {
          widgetType: {
            type: 'string',
            enum: ['zip', 'csv'],
            description: 'zip = file archive upload (Claude export or Google Vault); csv = user mapping CSV upload',
          },
          label: {
            type: 'string',
            description: 'Short label shown above the widget, e.g. "Upload your Claude export ZIP" or "Import user mappings from CSV"',
          },
        },
        required: ['widgetType'],
      },
    },
  },
];
