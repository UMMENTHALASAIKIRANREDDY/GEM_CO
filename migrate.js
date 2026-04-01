#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';

import { VaultReader } from './src/modules/vaultReader.js';
import { AssetScanner } from './src/modules/assetScanner.js';
import { ResponseGenerator } from './src/modules/responseGenerator.js';
import { PagesCreator } from './src/modules/pagesCreator.js';
import { ReportWriter } from './src/modules/reportWriter.js';
import { CheckpointManager } from './src/utils/checkpoint.js';

const program = new Command();

program
  .name('migrate')
  .description('Gemini → Copilot Pages Migration Tool — CloudFuze')
  .requiredOption('--customer <path>', 'Path to customer directory (contains config.json)')
  .option('--dry-run', 'Preview migration — no API calls made', false)
  .option('--user <email>', 'Process one user only')
  .option('--resume', 'Skip users already in checkpoint file', false)
  .option('--parallel <n>', 'Number of users to process concurrently (max 10)', '1')
  .option('--from-date <date>', 'Filter conversations from date (YYYY-MM-DD)')
  .option('--to-date <date>', 'Filter conversations to date (YYYY-MM-DD)')
  .option('--skip-followups', 'Skip follow-up prompts', false)
  .action(run);

program.parse();

/**
 * Extract vault ZIP into vault_export/ if ZIP exists and folder not yet extracted.
 */
function extractVaultZip(customerPath, config) {
  const zipPath = path.join(customerPath, config.vault_zip.replace('./', ''));
  const extractTo = path.join(customerPath, config.vault_export_path.replace('./', ''));

  if (!fs.existsSync(zipPath)) return; // no ZIP provided — use existing folder

  if (fs.existsSync(path.join(extractTo, 'export_metadata.json'))) {
    console.log(chalk.gray('Vault export already extracted — skipping unzip.\n'));
    return;
  }

  console.log(`Extracting vault ZIP: ${path.basename(zipPath)} ...`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractTo, true);
  console.log(chalk.green(`Extracted to: ${extractTo}\n`));
}

async function run(opts) {
  console.log(chalk.bold.blue('\nGemini → Copilot Pages Migration') + ' — CloudFuze\n');

  // Load customer config
  const configPath = path.join(opts.customer, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(chalk.red(`config.json not found at: ${configPath}`));
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  console.log(`Customer: ${chalk.bold(config.customer_name)}`);
  console.log(`Tenant:   ${config.m365_tenant_id}`);
  console.log(`Mode:     ${opts.dryRun ? chalk.yellow('DRY RUN') : chalk.green('LIVE')}\n`);

  // Extract ZIP if provided
  if (config.vault_zip) {
    try {
      extractVaultZip(opts.customer, config);
    } catch (err) {
      console.error(chalk.red(`ZIP extraction failed: ${err.message}`));
      process.exit(1);
    }
  }

  const vaultPath = path.join(opts.customer, config.vault_export_path.replace('./', ''));

  // Module 1 — Vault Reader: discover users
  const reader = new VaultReader(vaultPath);
  let users;
  try {
    users = reader.discoverUsers();
  } catch (err) {
    console.error(chalk.red(`Vault read error: ${err.message}`));
    process.exit(1);
  }

  // Filter to single user if --user flag provided
  if (opts.user) {
    users = users.filter(u => u.email === opts.user);
    if (!users.length) {
      console.error(chalk.red(`User ${opts.user} not found in Vault export`));
      process.exit(1);
    }
  }

  // Print discovered users table
  const table = new Table({
    head: ['Email', 'Conversations', 'Status'],
    style: { head: ['cyan'] }
  });
  users.forEach(u => table.push([u.email, String(u.conversationCount), 'queued']));
  console.log(table.toString());

  if (opts.dryRun) {
    console.log(chalk.yellow('\nDRY RUN complete — no API calls made.'));
    console.log(`Total users:         ${users.length}`);
    console.log(`Total conversations: ${users.reduce((s, u) => s + u.conversationCount, 0)}`);
    return;
  }

  // Module 2 — Asset Scanner (no API calls, runs before migration)
  const scanner = new AssetScanner();
  const visualReports = {};
  for (const u of users) {
    const convs = reader.loadUserConversations(u.email, opts.fromDate, opts.toDate);
    visualReports[u.email] = scanner.scan(u.email, convs);
  }

  // Checkpoint
  const checkpoint = new CheckpointManager(path.join(opts.customer, 'checkpoint.json'));
  if (opts.resume) {
    const completed = checkpoint.getCompletedUsers();
    users = users.filter(u => !completed.has(u.email));
    console.log(chalk.yellow(`\nResuming — ${users.length} users remaining\n`));
  }

  // Process users (with optional concurrency)
  const report = new ReportWriter();
  const generator = new ResponseGenerator();
  const creator = new PagesCreator(config.m365_tenant_id);
  const parallel = Math.min(parseInt(opts.parallel) || 1, 10);

  for (let i = 0; i < users.length; i += parallel) {
    const batch = users.slice(i, i + parallel);
    await Promise.all(batch.map(u => processUser(
      u, reader, generator, creator,
      visualReports, report, checkpoint,
      opts.fromDate, opts.toDate, opts.skipFollowups
    )));
  }

  // Module 5 — Write reports
  const reportPath = path.join(opts.customer, 'migration_report.json');
  const visualPath = path.join(opts.customer, 'visual_assets_report.json');
  report.write(reportPath);
  scanner.writeReport(visualPath, visualReports);

  console.log(chalk.bold.green('\nMigration complete!'));
  console.log(`Report:        ${reportPath}`);
  console.log(`Visual assets: ${visualPath}`);
}

async function processUser(
  u, reader, generator, creator,
  visualReports, report, checkpoint,
  fromDate, toDate, skipFollowups
) {
  const { email } = u;
  console.log(`\n${chalk.bold('Processing:')} ${email}`);

  let conversations;
  const errors = [];
  let pagesCreated = 0;

  try {
    conversations = reader.loadUserConversations(email, fromDate, toDate);

    for (const conv of conversations) {
      try {
        const convWithResponses = await generator.generate(conv, skipFollowups);
        await creator.createPage(email, convWithResponses, visualReports[email] || []);
        pagesCreated++;
        console.log(`  ${chalk.green('✓')} ${conv.title?.slice(0, 60)}`);
      } catch (err) {
        errors.push({ conversation: conv.title, error: err.message });
        console.log(`  ${chalk.red('✗')} ${conv.title?.slice(0, 40)} — ${err.message}`);
      }
    }

    report.addUserResult({
      email,
      conversations: conversations.length,
      pagesCreated,
      visualAssetsFlagged: (visualReports[email] || []).length,
      errors
    });

    checkpoint.markComplete(email);
  } catch (err) {
    console.error(chalk.red(`Fatal error for ${email}: ${err.message}`));
    report.addUserResult({ email, conversations: 0, pagesCreated: 0, visualAssetsFlagged: 0, errors: [{ error: err.message }] });
  } finally {
    // Clear user data from memory (FR-4.11)
    conversations = null;
  }
}
