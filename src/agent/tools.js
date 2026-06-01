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
      description: 'Navigate the left panel to a specific step. Step indices differ per combination. Common pattern: 0=Connect Clouds, 1=Direction. After that the order depends on combo: G2C=2 Import,3 Map,4 Options,5+ Migrate. C2G=2 Map,3 Options,4+ Migrate. CL2G/CL2C=2 Upload ZIP,3 Map,4 Options,5+ Migrate. G2G=2 Select Accounts,3 Upload,4 Map,5 Options,6+ Migrate. C2C=2 Select Tenants,3 Map,4 Options,5+ Migrate. Always check current step via get_migration_status before navigating.',
      parameters: {
        type: 'object',
        properties: { step: { type: 'number', description: 'Step index (combo-specific, see description)' } },
        required: ['step'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_direction',
      description: 'Set the migration direction. ALWAYS call this when user picks a direction OR says "switch to X" — even if you think it\'s already set (it might not be the same one). Naming convention is SOURCE → DESTINATION. Map of phrases to migDir codes: "Claude → Gemini" / "claude to google" / "CL2G" → claude-gemini · "Gemini → Copilot" / "Google → Microsoft" / "G2C" → gemini-copilot · "Copilot → Gemini" / "Microsoft → Google" / "C2G" → copilot-gemini · "Gemini → Gemini" / "Google → Google" / "G2G" → gemini-gemini · "Claude → Copilot" / "Claude → Microsoft" / "CL2C" → claude-copilot · "Copilot → Copilot" / "M365 → M365" / "C2C cross-tenant" → copilot-copilot.',
      parameters: {
        type: 'object',
        properties: { migDir: { type: 'string', enum: ['gemini-copilot', 'copilot-gemini', 'claude-gemini', 'gemini-gemini', 'claude-copilot', 'copilot-copilot'], description: 'claude-gemini for Claude→Google, gemini-copilot for Google→Microsoft, copilot-gemini for Microsoft→Google, gemini-gemini for Google→Google, claude-copilot for Claude→Microsoft, copilot-copilot for Microsoft→Microsoft cross-tenant' } },
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
      name: 'select_mapping_users',
      description: 'Tick or untick checkboxes in the user mapping section to decide which users will actually be migrated. Match on INTENT, not exact wording — users phrase this many ways: "select X", "tick X", "include X", "add X", "uncheck X", "skip X", "exclude X", "remove X", "select all", "everyone", "deselect all", "clear selection", "only the mapped ones", "no one yet". Pick the action that captures their intent: "all"/"none" for everyone/no-one, "only_mapped" for filter by mapped state, "add"/"remove" for explicit name lists. Idempotent — safe to call repeatedly.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['all', 'none', 'only_mapped', 'add', 'remove'],
            description: '"all" = check every row. "none" = uncheck every row. "only_mapped" = check rows that have a destination assigned, uncheck the rest. "add"/"remove" = check or uncheck a specific list (pass `emails`).',
          },
          emails: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of source emails to add/remove. Required when action is "add" or "remove". Ignored otherwise.',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_user_mapping',
      description: 'Set ONE specific source→destination assignment in the mapping table. Use whenever the user expresses intent to pair a specific source user with a specific destination, however they phrase it ("map A to B", "send A\'s chats to B", "A goes to B", "assign B as A\'s destination", "A→B", "make B the target for A"). For multiple pairs in one turn, call this tool multiple times — or call auto_map_users if they want the obvious matches done at once.',
      parameters: {
        type: 'object',
        properties: {
          sourceEmail: { type: 'string', description: 'The source user identifier — typically email. For Claude (CL2G/CL2C) this can be the Claude UUID instead.' },
          destEmail:   { type: 'string', description: 'The destination email. Empty string clears the mapping.' },
        },
        required: ['sourceEmail', 'destEmail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_uploaded_csv',
      description: 'Delete a previously uploaded mapping CSV — wipes both the DB record AND the in-memory mappings/selections. Recognise intent regardless of phrasing: "delete csv", "remove that csv", "throw it away", "reset mappings", "start over", "I want to re-upload", "scrap the csv", "undo the import", etc. After clearing, the user can re-upload or call auto_map_users to re-establish defaults.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_migration_status',
      description: 'Look up a specific user\'s migration result from the database. Use when the user asks things like "Did mia@cloudfuze.com migrate?", "How many files did erik get?", "Which users failed?". Returns latest batch result for that user.',
      parameters: {
        type: 'object',
        properties: {
          userEmail: { type: 'string', description: 'The user\'s email address (case-insensitive). Required.' },
          batchId:   { type: 'string', description: 'Optional batch ID to scope the lookup. If omitted, searches across all batches for the most recent result for this user.' },
        },
        required: ['userEmail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_migration_config',
      description: 'Update migration options: folder name, date range, and/or dry-run flag. ALWAYS call this when the user expresses intent to change any of these — never just reply with text saying it\'s been changed, the UI will not reflect the change unless this tool is invoked. Resolve natural-language dates ("today", "last week", "since March 1") to ISO format (YYYY-MM-DD) before calling, using the "Today\'s date is …" context above. Empty string clears a field.',
      parameters: {
        type: 'object',
        properties: {
          folderName: { type: 'string', description: 'Destination folder / OneNote section name. e.g. "MarketingChats". Empty string resets to default.' },
          fromDate:   { type: 'string', description: 'Start date. ISO ("2026-03-01") OR a natural phrase the server understands: "today", "yesterday", "tomorrow", "this week", "last week", "this month", "last month", "last 7 days", "N days ago". Empty string clears.' },
          toDate:     { type: 'string', description: 'End date. Same format options as fromDate. Empty string clears.' },
          dryRun:     { type: 'boolean', description: 'true = safe preview (no writes), false = live migration.' },
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
      name: 'select_g2g_accounts',
      description: 'For Gemini→Gemini (G2G) only: set the source and destination Google Workspace accounts. Both must already be connected to CloudFuze. After setting, advances the left panel to step 3 (Upload Data). Call when user names which Google account is the source and which is the destination.',
      parameters: {
        type: 'object',
        properties: {
          sourceAccountId: { type: 'string', description: 'Connected Google account ID (UUID) to migrate FROM. Get from get_auth_status or ask user.' },
          destAccountId:   { type: 'string', description: 'Connected Google account ID (UUID) to migrate TO. Must differ from source.' },
        },
        required: ['sourceAccountId', 'destAccountId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_c2c_tenants',
      description: 'For Copilot→Copilot (C2C, cross-tenant) only: set the source and destination Microsoft 365 tenants. Both tenants must already have admin consent granted (use initiate_tenant_consent first if not). After setting, advances the left panel to step 3 (Map Users). Call when user names which tenant is the source and which is the destination.',
      parameters: {
        type: 'object',
        properties: {
          sourceTenantId: { type: 'string', description: 'Microsoft 365 tenant ID to migrate FROM (GUID).' },
          destTenantId:   { type: 'string', description: 'Microsoft 365 tenant ID to migrate TO. Must differ from source.' },
        },
        required: ['sourceTenantId', 'destTenantId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'initiate_tenant_consent',
      description: 'For Copilot→Copilot (C2C) only: open the Microsoft admin-consent popup so a tenant admin can grant CloudFuze access to a Microsoft 365 tenant. Use BEFORE select_c2c_tenants if either tenant is not yet consented. The user signs in as a Global Admin and approves the requested permissions. On success the tenant becomes available in get_auth_status.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['source', 'destination'], description: '"source" or "destination" — which tenant slot the consent is for. UI uses this to pre-fill the next selector.' },
        },
        required: ['role'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_vault_export',
      description: 'For G2C (Vault → Copilot) and G2G (Google → Google) only: kick off the server-side Google Vault export from the chat. The UI switches to the User\'s List tab, selects the requested users, then runs the export. The export takes 1–10 minutes; the UI polls and auto-advances once done. Use when the user says "export Vault for ALL users", "start Vault export", "export everyone", etc.',
      parameters: {
        type: 'object',
        properties: {
          scope:  { type: 'string', enum: ['all', 'selected'], description: '"all" = export every user in the source Workspace. "selected" = export only the emails passed.' },
          emails: { type: 'array', items: { type: 'string' }, description: 'Required when scope="selected". List of emails to include in the export.' },
        },
        required: ['scope'],
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
  {
    type: 'function',
    function: {
      name: 'show_connect_clouds_widget',
      description: 'Inject an inline "Connect Google Workspace" / "Connect Microsoft 365" button card directly into the chat so the user can sign in WITHOUT leaving the conversation. Call this whenever the user says any of: "connect google", "connect cloud", "connect microsoft", "sign in", "I want to connect google workspace", "connect my account", "add another account", or any phrase that signals they want to authenticate. ALWAYS call this tool — do NOT just point at the right panel. Skip a side; the widget auto-hides the buttons for clouds that are already authed.',
      parameters: {
        type: 'object',
        properties: {
          which: {
            type: 'string',
            enum: ['google', 'microsoft', 'both'],
            description: 'Which connection button(s) to show. "google" = only Google Workspace button. "microsoft" = only Microsoft 365 button. "both" = whichever isn\'t connected yet. Default: "both".',
          },
        },
        required: [],
      },
    },
  },
];
