import fs from 'fs';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('module:assetScanner');

const IMAGE_KEYWORDS = [
  'generated a visual', 'generated an image', 'here is an image',
  "here's an image", 'created an image', 'image attached',
  'see the image', 'visual above', 'chart above', 'graph above',
  'diagram above', 'illustration', 'mockup', 'generated image',
  'created a logo', 'generated a logo', 'visual mockup'
];

const CHART_CODE_PATTERNS = [
  /import matplotlib/i,
  /plt\.plot\(/i,
  /plt\.show\(/i,
  /Chart\.js/i,
  /new Chart\(/i,
  /d3\.select/i,
  /import d3/i,
  /plotly/i,
  /go\.Figure\(/i,
  /px\.\w+\(/i,
  /SELECT.*FROM.*GROUP BY/is
];

/**
 * Module 2 — Visual Asset Scanner.
 * Scans conversations for image references and chart code.
 * No API calls — purely heuristic text analysis.
 */
export class AssetScanner {
  /**
   * Scan a user's conversations and return list of flagged conversations.
   */
  scan(email, conversations) {
    const flagged = [];

    for (const conv of conversations) {
      let hasImageRef = false;
      let hasChartCode = false;

      for (const turn of conv.turns || []) {
        const response = turn.response || '';
        const responseLower = response.toLowerCase();

        if (!hasImageRef) {
          hasImageRef = IMAGE_KEYWORDS.some(kw => responseLower.includes(kw));
        }
        if (!hasChartCode) {
          hasChartCode = CHART_CODE_PATTERNS.some(re => re.test(response));
        }
      }

      if (hasImageRef || hasChartCode) {
        flagged.push({
          conversation_id: conv.id,
          title: conv.title,
          date: conv.created_at,
          gemini_url: conv.geminiUrl,
          image_references: hasImageRef,
          chart_code: hasChartCode,
          flag_reason: hasImageRef ? 'image_reference' : 'chart_code'
        });
        logger.info(`Flagged: "${conv.title}" (${email})`);
      }
    }

    logger.info(`Asset scan complete for ${email}: ${flagged.length} flagged`);
    return flagged;
  }

  /**
   * Write visual_assets_report.json — metadata only, no conversation content.
   */
  writeReport(outputPath, visualReports) {
    const report = {
      report_type: 'visual_assets',
      generated_at: new Date().toISOString(),
      users: {}
    };

    for (const [email, flagged] of Object.entries(visualReports)) {
      report.users[email] = {
        flagged_count: flagged.length,
        conversations: flagged
      };
    }

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    logger.info(`Visual assets report written: ${outputPath}`);
  }
}
