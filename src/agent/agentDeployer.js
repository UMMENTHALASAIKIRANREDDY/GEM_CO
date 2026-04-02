import AdmZip from 'adm-zip';
import { getDelegatedToken, getGraphToken } from '../auth/microsoft.js';
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
  constructor(customerName, tenantId) {
    this.customerName = customerName;
    this.tenantId = tenantId;
    this.agentName = `${customerName} Conversation Agent`;
    this.appId = this._generateGuid();
  }

  _headers() {
    return { 'Authorization': `Bearer ${getDelegatedToken()}` };
  }

  /**
   * Build the agent app package, publish to catalog, and pin for all users.
   * Called automatically after migration completes.
   */
  /**
   * @param {string[]} userEmails — list of migrated user emails to install the agent for
   */
  /**
   * @param {string[]} targetEmails — only the mapped M365 user emails from the UI
   */
  async deployAgent(targetEmails = []) {
    logger.info(`Building agent: "${this.agentName}"`);

    // Step 1: Build ZIP package
    const zipBuffer = this._buildAppPackage();

    // Step 2: Publish to org catalog
    const appInfo = await this._publishToCatalog(zipBuffer);
    logger.info(`Agent published to catalog: ${appInfo.id}`);

    // Step 3: Install for mapped target users
    // Uses app-only token — works for users whose policy allows custom apps
    // For users with restrictive policies, falls back to delegated admin token
    let installed = 0;
    let failed = 0;
    const failedEmails = [];

    for (const email of targetEmails) {
      try {
        await this._installForUser(appInfo.id, email);
        installed++;
        logger.info(`Agent installed for: ${email}`);
      } catch (err) {
        if (err.message.includes('409')) {
          installed++;
        } else {
          // App-only failed (policy blocked) — try with delegated admin token
          try {
            await this._installForUserDelegated(appInfo.id, email);
            installed++;
            logger.info(`Agent installed for: ${email} (via admin)`);
          } catch (err2) {
            if (err2.message.includes('409')) {
              installed++;
            } else {
              failed++;
              failedEmails.push(email);
              logger.warn(`Could not install for ${email}: ${err2.message}`);
            }
          }
        }
      }
    }
    logger.info(`Agent installed for ${installed}/${targetEmails.length} users (${failed} failed)`);

    return { ...appInfo, installed, failed, failedEmails, totalUsers: targetEmails.length };
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
      "description": `Search and review migrated ${this.customerName} Gemini conversations. Ask questions about past chats and get instant answers grounded in your conversation history.`,
      "instructions": `You are the ${this.agentName}. Your role is to help users find, review, and answer questions about their migrated Google Gemini conversation history.

The conversations were migrated from Google Gemini to Microsoft 365 and are stored in the user's OneDrive and OneNote. Each conversation contains:
- The original user prompt (what the user asked Gemini)
- The original Gemini response
- A Copilot-generated response for comparison
- Metadata: date, conversation title, Gemini URL

When answering:
1. Search the user's OneDrive and OneNote for relevant migrated conversations
2. Always cite which conversation your answer came from (title + date)
3. If both Gemini and Copilot responses exist, present both clearly
4. Be concise and helpful
5. If no relevant conversation is found, say so clearly

Never make up information. Only answer based on the actual migrated conversation data.`,
      "capabilities": [
        {
          "name": "OneDriveAndSharePoint"
        }
      ],
      "conversation_starters": [
        {
          "title": "My Conversations",
          "text": `Show me all my migrated ${this.customerName} Gemini conversations`
        },
        {
          "title": "Search by Topic",
          "text": "What did I discuss about marketing in Gemini?"
        },
        {
          "title": "Find a Conversation",
          "text": "Find my Gemini conversation about data analysis"
        },
        {
          "title": "Compare Responses",
          "text": "Show the Gemini response vs Copilot response for my last conversation"
        }
      ],
      "disclaimer": {
        "text": `This agent searches your migrated ${this.customerName} Gemini conversation history. Data is sourced from your OneDrive/OneNote.`
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
      "version": "1.0.0",
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
        "short": `Review migrated ${this.customerName} Gemini chats`,
        "full": `Search and review your migrated ${this.customerName} Google Gemini conversation history. Ask questions about past Gemini chats and get instant answers grounded in your actual conversation data. Built by CloudFuze.`
      },
      "icons": {
        "color": "color.png",
        "outline": "outline.png"
      },
      "accentColor": "#0129AC",
      "copilotAgents": {
        "declarativeAgents": [
          {
            "id": "geminiConversationAgent",
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
    const headers = this._headers();

    const response = await fetch(`${GRAPH_V1}/appCatalogs/teamsApps`, {
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

  /**
   * Install the agent into a specific user's personal scope.
   * Uses APP-ONLY token (not delegated) with TeamsAppInstallation.ReadWriteForUser.All
   * application permission — this allows installing apps for other users.
   */
  async _installForUser(teamsAppId, userEmail) {
    const appToken = await getGraphToken(this.tenantId);

    const response = await fetch(
      `${GRAPH_V1}/users/${userEmail}/teamwork/installedApps`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          'teamsApp@odata.bind': `${GRAPH_V1}/appCatalogs/teamsApps/${teamsAppId}`
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Install failed ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Fallback: Install using admin's delegated token.
   * Works when app-only token is blocked by user's app permission policy.
   */
  async _installForUserDelegated(teamsAppId, userEmail) {
    const response = await fetch(
      `${GRAPH_V1}/users/${userEmail}/teamwork/installedApps`,
      {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'teamsApp@odata.bind': `${GRAPH_V1}/appCatalogs/teamsApps/${teamsAppId}`
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Install (delegated) failed ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  _generateGuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}
