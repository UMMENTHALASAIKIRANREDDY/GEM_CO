import fs from 'fs';
import path from 'path';
import { parseStringPromise } from 'xml2js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:vaultReader');

/**
 * Module 1 — Google Vault Export Reader & User Discovery.
 *
 * Real Vault export format (confirmed from actual export):
 *   ZIP root/
 *     alice@company.com-XXXXXX.xml
 *     bob@company.com-XXXXXX.xml
 *
 * XML schema:
 *   <GeminiUserConversationHistory>
 *     <User><Email>...</Email></User>
 *     <Conversations>
 *       <Conversation>
 *         <ConversationId>c_xxx</ConversationId>
 *         <ConversationTopic>Title</ConversationTopic>
 *         <ConversationTurns>
 *           <ConversationTurn>
 *             <Timestamp>...</Timestamp>
 *             <Prompt><Text>...</Text></Prompt>
 *             <PrimaryResponse><Text>...</Text></PrimaryResponse>
 *           </ConversationTurn>
 *         </ConversationTurns>
 *       </Conversation>
 *     </Conversations>
 *   </GeminiUserConversationHistory>
 */
export class VaultReader {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    this._userFiles = null;  // { email -> filePath }
  }

  /**
   * Discover all users by scanning for *.xml files in the vault directory.
   * Email is extracted from the <User><Email> tag inside each XML file.
   */
  async discoverUsers() {
    const xmlFiles = fs.readdirSync(this.vaultPath)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .map(f => path.join(this.vaultPath, f));

    if (xmlFiles.length === 0) {
      throw new Error(`No XML files found in: ${this.vaultPath}`);
    }

    this._userFiles = {};
    const users = [];

    for (const filePath of xmlFiles) {
      try {
        const email = await this._extractEmailFromFile(filePath);
        if (!email) {
          logger.warn(`Could not extract email from: ${path.basename(filePath)} — skipping`);
          continue;
        }
        this._userFiles[email] = filePath;

        // Count conversations without loading full content
        const convCount = await this._countConversations(filePath);
        users.push({
          email,
          displayName: email,
          conversationCount: convCount,
          exportFile: filePath
        });
      } catch (err) {
        logger.warn(`Failed to read ${path.basename(filePath)}: ${err.message}`);
      }
    }

    logger.info(`Discovered ${users.length} users from Vault export`);
    return users;
  }

  /**
   * Load and parse all conversations for one user from their XML file.
   * Returns normalised conversation array — data stays in memory only.
   */
  async loadUserConversations(email, fromDate = null, toDate = null) {
    if (!this._userFiles) await this.discoverUsers();

    const filePath = this._userFiles[email];
    if (!filePath || !fs.existsSync(filePath)) {
      logger.warn(`No export file for ${email}`);
      return [];
    }

    const xml = fs.readFileSync(filePath, 'utf8');
    const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });

    const root = parsed.GeminiUserConversationHistory;
    const rawConvs = root?.Conversations?.[0]?.Conversation || [];

    const conversations = [];

    for (const conv of rawConvs) {
      const id = conv.ConversationId?.[0] || '';
      const title = conv.ConversationTopic?.[0] || 'Untitled Conversation';
      const turns = conv.ConversationTurns?.[0]?.ConversationTurn || [];

      if (turns.length === 0) continue;

      // Use timestamp of first turn as conversation date
      const firstTs = turns[0]?.Timestamp?.[0] || null;

      // Date filtering
      if (firstTs && (fromDate || toDate)) {
        const d = new Date(firstTs);
        if (fromDate && d < new Date(fromDate + 'T00:00:00Z')) continue;
        if (toDate && d > new Date(toDate + 'T23:59:59Z')) continue;
      }

      const normTurns = turns.map((turn, i) => ({
        turn_id: turn.RequestId?.[0] || `turn_${i}`,
        prompt: turn.Prompt?.[0]?.Text?.[0] || '',
        response: turn.PrimaryResponse?.[0]?.Text?.[0] || '',
        timestamp: turn.Timestamp?.[0] || null,
        is_followup: i > 0
      })).filter(t => t.prompt);

      if (normTurns.length === 0) continue;

      conversations.push({
        id,
        title,
        created_at: firstTs,
        geminiUrl: id ? `https://gemini.google.com/app/${id}` : null,
        turns: normTurns
      });
    }

    logger.info(`Loaded ${conversations.length} conversations for ${email}`);
    return conversations;
  }

  async _extractEmailFromFile(filePath) {
    const xml = fs.readFileSync(filePath, 'utf8');
    const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });
    return parsed?.GeminiUserConversationHistory?.User?.[0]?.Email?.[0] || null;
  }

  async _countConversations(filePath) {
    const xml = fs.readFileSync(filePath, 'utf8');
    const parsed = await parseStringPromise(xml, { explicitArray: true, trim: true });
    const convs = parsed?.GeminiUserConversationHistory?.Conversations?.[0]?.Conversation || [];
    return convs.length;
  }
}
