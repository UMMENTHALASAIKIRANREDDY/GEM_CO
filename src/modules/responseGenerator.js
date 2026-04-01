import { AzureOpenAI } from 'openai';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:responseGenerator');

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

/**
 * Module 3 — Copilot Response Generator.
 * Primary:  Microsoft Graph Copilot interactions endpoint.
 * Fallback: Azure OpenAI GPT-4o.
 * All prompt/response data held in memory only — never written to disk.
 */
export class ResponseGenerator {
  constructor() {
    this._openaiClient = null;
  }

  _getOpenAIClient() {
    if (!this._openaiClient) {
      this._openaiClient = new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: '2024-02-01',
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o'
      });
    }
    return this._openaiClient;
  }

  /**
   * Generate Copilot responses for all turns in a conversation.
   * Returns a new conversation object with copilotResponse added per turn.
   * Data stays in memory only.
   */
  async generate(conversation, skipFollowups = false) {
    const result = { ...conversation, turns: [] };

    for (const turn of conversation.turns || []) {
      if (skipFollowups && turn.is_followup) continue;
      if (!turn.prompt) continue;

      try {
        const copilotResponse = await this._callGraphCopilot(turn.prompt);
        result.turns.push({ ...turn, copilotResponse });
      } catch {
        // Fallback to Azure OpenAI
        try {
          const copilotResponse = await this._callAzureOpenAI(turn.prompt);
          result.turns.push({ ...turn, copilotResponse });
        } catch (err) {
          logger.warn(`Response generation failed for turn in "${conversation.title}": ${err.message}`);
          result.turns.push({ ...turn, copilotResponse: '[Response generation failed — retry with --resume]' });
        }
      }
    }

    return result;
  }

  /**
   * Primary: Microsoft Graph Copilot interactions endpoint.
   * TODO: Implement when Graph Copilot API admin approval is granted.
   */
  async _callGraphCopilot(_prompt) {
    throw new Error('Graph Copilot API — pending admin approval / implementation');
  }

  /**
   * Fallback: Azure OpenAI GPT-4o.
   * Stateless — each prompt sent as a standalone request (FR-3.3).
   * Exponential backoff on 429/5xx (FR-3.5).
   */
  async _callAzureOpenAI(prompt, attempt = 1) {
    try {
      const client = this._getOpenAIClient();
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

      const response = await client.chat.completions.create({
        model: deployment,
        messages: [
          {
            role: 'system',
            content: 'You are Microsoft Copilot. Answer the user\'s question helpfully and concisely.'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 2000,
        temperature: 0.7
      });

      return response.choices[0].message.content;
    } catch (err) {
      const isRetryable = err.status === 429 || (err.status >= 500 && err.status < 600);
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(`Rate limited / server error — retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        return this._callAzureOpenAI(prompt, attempt + 1);
      }
      throw err;
    }
  }
}
