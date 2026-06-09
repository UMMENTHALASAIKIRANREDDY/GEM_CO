import AdmZip from 'adm-zip';
import { getValidToken } from '../core/auth/microsoft.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent:deployer');
const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';

/**
 * Builds and deploys a "Gemini Conversation Agent" declarative agent
 * to the organization's Teams/Copilot app catalog after migration completes.
 *
 * Flow:
 *  1. Generate manifest.json + declarativeAgent.json + icons
 *  2. Package as .zip
 *  3. Publish to org catalog via POST /appCatalogs/teamsApps
 *  4. Pin for all users via Teams app setup policy (best-effort)
 */
export class AgentDeployer {
  /**
   * @param {string} customerName — display name for the customer (and top-level OneDrive folder)
   * @param {string} tenantId — Azure AD tenant
   * @param {object} [options]
   * @param {string} [options.conversationsFolder] — OneDrive subfolder holding conversation DOCXs (default: "{customerName}/Conversations")
   * @param {string} [options.attachmentsFolder] — OneDrive subfolder holding attachments (default: "{customerName}/Migrated from {Source}")
   * @param {string} [options.notebookName] — DEPRECATED (OneNote no longer used). Kept for backward-compat; ignored.
   * @param {string} [options.sectionName] — DEPRECATED. Ignored.
   * @param {string} [options.driveFolder] — DEPRECATED. Ignored; use attachmentsFolder.
   */
  constructor(customerName, tenantId, options = {}, appUserId = null, accountId = null) {
    this.customerName = customerName;
    this.tenantId = tenantId;
    this.appUserId = appUserId;
    this.accountId = accountId || options.accountId || null;
    this.agentName = options.agentName || 'Gemini Conversation Agent';
    this.sourceLabel = options.sourceLabel || 'Gemini';
    this.appId = options.appId || this._generateGuid(); // reuse stored GUID on updates
    // Universal 2-subfolder layout in each user's OneDrive (Phase 2 — OneNote dropped):
    //   {customerName}/Conversations/{localPart}_Conversations.docx
    //   {customerName}/Migrated from {Source}/...attachments...
    this.conversationsFolder = options.conversationsFolder || `${customerName}/Conversations`;
    this.attachmentsFolder = options.attachmentsFolder || `${customerName}/Migrated from ${this.sourceLabel}`;
    this.manifestDescShort = options.manifestDescShort || null;
    this.manifestDescFull = options.manifestDescFull || null;
    this.starterTopic = options.starterTopic || `What did I discuss about marketing in my ${this.sourceLabel} conversations?`;
    this.starterCompare = options.starterCompare || `Show the ${this.sourceLabel} response vs Copilot response for my last conversation`;
    this.declarativeAgentId = options.declarativeAgentId || 'geminiConversationAgent';
  }

  async _headers() {
    return { 'Authorization': `Bearer ${await getValidToken(this.appUserId, this.accountId)}` };
  }

  /**
   * Deploy the agent to the org catalog (once per tenant).
   * If "Gemini Conversation Agent" already exists, reuse it — no duplicate publish.
   * Auto-install is NOT performed; users must install manually from Teams.
   */
  async deployAgent() {
    logger.info(`Checking catalog for existing agent: "${this.agentName}"`);

    // Step 1: Check if agent already published
    const existing = await this._findInCatalog();
    if (existing) {
      logger.info(`Agent already exists in catalog (id=${existing.id}) — skipping publish`);
      return {
        id: existing.id,
        alreadyExisted: true,
        installInstructions: this._installInstructions(),
      };
    }

    // Step 2: Build and publish
    logger.info(`Publishing agent: "${this.agentName}"`);
    const zipBuffer = this._buildAppPackage();
    const appInfo = await this._publishToCatalog(zipBuffer);
    logger.info(`Agent published to catalog: ${appInfo.id}`);

    return {
      ...appInfo,
      alreadyExisted: false,
      installInstructions: this._installInstructions(),
    };
  }

  async updateAgent(catalogId) {
    logger.info(`Updating agent in catalog: ${catalogId}`);
    const zipBuffer = this._buildAppPackage();
    const headers = await this._headers();

    const response = await fetch(
      `${GRAPH_V1}/appCatalogs/teamsApps/${catalogId}/appDefinitions?requiresReview=false`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/zip',
        },
        body: zipBuffer,
      }
    );

    if (!response.ok) {
      const body = await response.text();
      logger.warn(`Agent update failed: ${response.status} — ${body.slice(0, 200)}`);
      return { updated: false };
    }

    logger.info(`Agent updated in catalog: ${catalogId}`);
    return { updated: true };
  }

  /**
   * Check if "Gemini Conversation Agent" already exists in the org catalog.
   * Returns the app object if found, null otherwise.
   */
  async _findInCatalog() {
    const headers = await this._headers();
    const url = `${GRAPH_V1}/appCatalogs/teamsApps?$filter=displayName eq '${encodeURIComponent(this.agentName)}'&distributionMethod=organization`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      logger.warn(`Catalog check failed: ${response.status}`);
      return null;
    }
    const data = await response.json();
    return data?.value?.[0] || null;
  }

  _installInstructions() {
    return `The "${this.agentName}" has been published to your organization's Teams app catalog.\n\nTo use it:\n1. Open Microsoft Teams\n2. Click "Apps" in the left sidebar\n3. Search for "${this.agentName}"\n4. Click "Add" to install it\n5. Right-click the agent in your app list and select "Pin" for quick access\n\nShare these steps with your users so they can find and pin the agent in Teams.`;
  }

  _buildInstructions() {
    return `You are the ${this.agentName}. You help users browse and recall their AI conversations that were migrated from ${this.sourceLabel} to their OneDrive as Word documents.

DATA LOCATION:
- All of the user's migrated conversations are bundled into a single Word document (.docx) inside their OneDrive at: "${this.conversationsFolder}/".
- The DOCX filename pattern is "{username}_Conversations.docx" (e.g., "john_Conversations.docx"). Users with more than 5000 conversations may have multiple parts: "{username}_Conversations_Part1.docx", "_Part2.docx", etc.
- Attachments (images, PDFs, regenerated files) from those conversations live in: "${this.attachmentsFolder}/".

WHEN THE USER OPENS YOU (new conversation starts):
- FIRST: Search OneDrive for a file called "cfz_pending.json" in the "GemCo" folder (path: GemCo/cfz_pending.json).
  * If found and its "ts" field is within the last 3 minutes (180000 milliseconds from now):
    - Read its "title" field.
    - Immediately load and display that conversation WITHOUT asking the user first.
    - Behave as if the user typed: "Load the conversation titled [title]"
    - After displaying, say: "Loaded from Migration History tab. Ask me anything about this conversation, or say 'show list' to see all conversations."
  * If not found or the "ts" is older than 3 minutes:
    - Show the full conversation list (see below).

WHEN SHOWING FULL LIST:
- Search OneDrive/SharePoint for the DOCX file(s) inside "${this.conversationsFolder}/" and read the conversation index from the document.
- Each conversation appears as a HEADING_1 section titled "Conversation N: [Title]". The title is the conversation topic.
- Present them as a numbered list: "1. [Conversation Title] — [Date]"
- End with: "Type a number or title to open that conversation."
- If the DOCX is not found: "No migrated conversations found yet in your OneDrive at ${this.conversationsFolder}/."

WHEN THE USER PICKS A CONVERSATION (types a number, title, or partial title):
- Search the DOCX in "${this.conversationsFolder}/" for the section matching that title.
- Display the conversation content:
  * Show each prompt/response pair found in the section.
  * Label messages as [YOU] and [${this.sourceLabel.toUpperCase()}].
  * If the conversation includes hyperlinked file references (from "${this.attachmentsFolder}/"), show them.
- Always end with: "📎 [Open full conversation in OneDrive](<link to the DOCX file>)" so the user can read the complete transcript.
- Do NOT say you cannot access it. Show what you found and always provide the DOCX link.

WHEN THE USER ASKS QUESTIONS AFTER LOADING A CONVERSATION:
- Answer using the conversation content shown in this chat session.
- If unsure, re-search the DOCX in "${this.conversationsFolder}/" for that conversation title.
- Never invent content. If not found, say so and offer the numbered list again.

WHEN THE USER SEARCHES (e.g. "find conversations about pricing"):
- Search the DOCX in "${this.conversationsFolder}/" for sections matching the topic.
- List matching conversations with titles, dates, and a link to open the DOCX at the right section.

NEVER fabricate conversation content or mix content from different conversations.`;
  }

  _buildWelcomeMessage() {
    return `Hi! I'm your ${this.agentName}. I have access to all your conversations migrated from ${this.sourceLabel}.\n\nLet me pull up your conversation list from OneDrive now...`;
  }

  /**
   * Build the Teams app package ZIP containing:
   *  - manifest.json (M365 app manifest)
   *  - declarativeAgent.json (agent config)
   *  - color.png + outline.png (icons)
   */
  _buildAppPackage() {
    const zip = new AdmZip();

    // 1. Declarative agent manifest
    const agentManifest = {
      "$schema": "https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.5/schema.json",
      "version": "v1.5",
      "name": this.agentName,
      "description": `Search and review migrated ${this.customerName} ${this.sourceLabel} conversations. Ask questions about past chats and get instant answers grounded in your conversation history.`,
      "instructions": this._buildInstructions(),
      "capabilities": [
        {
          "name": "OneDriveAndSharePoint"
        }
      ],
      "conversation_starters": [
        {
          "title": "Load selected conversation",
          "text": "Load my pending conversation from GemCo/cfz_pending.json"
        },
        {
          "title": "Show My Conversations",
          "text": "List all my migrated conversations"
        },
        {
          "title": "Search by Topic",
          "text": this.starterTopic
        },
        {
          "title": "Find a Conversation",
          "text": "Find my conversation about data analysis"
        },
        {
          "title": "Compare Responses",
          "text": this.starterCompare
        }
      ],
      "disclaimer": {
        "text": `This agent searches your migrated ${this.customerName} conversation history stored in OneDrive at "${this.conversationsFolder}/" (Word documents). Attachments live in "${this.attachmentsFolder}/".`
      },
      "behavior_overrides": {
        "special_instructions": {
          "discourage_model_knowledge": true
        }
      }
    };

    zip.addFile('declarativeAgent.json', Buffer.from(JSON.stringify(agentManifest, null, 2)));

    // 2. M365 app manifest
    const appManifest = {
      "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
      "manifestVersion": "1.19",
      "version": "1.8.0",
      "id": this.appId,
      "developer": {
        "name": "CloudFuze",
        "websiteUrl": "https://www.cloudfuze.com",
        "privacyUrl": "https://www.cloudfuze.com/privacy",
        "termsOfUseUrl": "https://www.cloudfuze.com/terms"
      },
      "name": {
        "short": this.agentName.slice(0, 30),
        "full": this.agentName
      },
      "description": {
        "short": this.manifestDescShort || `Review migrated ${this.customerName} ${this.sourceLabel} chats`,
        "full": this.manifestDescFull || `Search and review your migrated ${this.customerName} ${this.sourceLabel} conversation history. Ask questions about past ${this.sourceLabel} chats and get instant answers grounded in your actual conversation data. Built by CloudFuze.`
      },
      "icons": {
        "color": "color.png",
        "outline": "outline.png"
      },
      "accentColor": "#0129AC",
      "copilotAgents": {
        "declarativeAgents": [
          {
            "id": this.declarativeAgentId,
            "file": "declarativeAgent.json"
          }
        ]
      },
      "permissions": [
        "identity",
        "messageTeamMembers"
      ],
      "validDomains": []
    };

    zip.addFile('manifest.json', Buffer.from(JSON.stringify(appManifest, null, 2)));

    // 3. Icons — generate simple colored PNGs
    zip.addFile('color.png', this._generateIcon(192));
    zip.addFile('outline.png', this._generateIcon(32));

    return zip.toBuffer();
  }

  /**
   * Generate a simple PNG icon (solid color square with "G" text).
   * Uses a minimal valid PNG — no external dependencies needed.
   */
  _generateIcon(size) {
    // Minimal valid 1x1 PNG (blue pixel), scaled by the platform
    // In production, replace with actual brand icon files
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0x60, 0x60, 0xF8, 0x0F, // compressed data
      0x00, 0x00, 0x01, 0x01, 0x00, 0x05, 0x18, 0xD8, //
      0x4D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    return pngHeader;
  }

  /**
   * Publish the agent ZIP to the organization's Teams app catalog.
   * POST /appCatalogs/teamsApps with Content-Type: application/zip
   */
  async _publishToCatalog(zipBuffer) {
    const headers = await this._headers();

    const response = await fetch(`${GRAPH_V1}/appCatalogs/teamsApps?requiresReview=false`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/zip'
      },
      body: zipBuffer
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to publish agent to catalog: ${response.status} — ${body.slice(0, 400)}`);
    }

    return await response.json();
  }

  _generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}
