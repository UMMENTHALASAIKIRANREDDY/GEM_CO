// src/agent/toolExecutor.js
import { getLogger } from '../utils/logger.js';
import { COMBINATIONS } from './combinations.js';
import { callAI } from './callAI.js';
import { loadHistory } from './conversationHistory.js';

const logger = getLogger('agent:executor');

export async function executeTool(toolName, args, { streamEvent, session, migrationState, migrationLogs, db }) {
  const migDir = migrationState?.migDir;
  const appUserId = session?.appUser?._id || session?.appUserId;

  switch (toolName) {

    // ── UI event tools ─────────────────────────────────────────────────────
    case 'navigate_to_step': {
      const step = typeof args.step === 'number' ? args.step : parseInt(args.step, 10);
      streamEvent('navigate', { step });
      return { navigated: true, step };
    }

    case 'select_direction': {
      streamEvent('select_direction', { direction: args.migDir, step: 2 });
      return { selected: true, direction: args.migDir };
    }

    case 'show_reports': {
      streamEvent('refresh_reports', {});
      return { shown: true };
    }

    case 'show_mapping': {
      streamEvent('refresh_mapping', {});
      return { shown: true };
    }

    case 'show_post_migration_guide': {
      streamEvent('show_widget', { widget: { type: 'post_migration_guide', migDir } });
      return { shown: true };
    }

    case 'show_status_card': {
      streamEvent('show_widget', {
        widget: {
          type: 'status_card',
          users: args.users ?? 0,
          files: args.files ?? 0,
          errors: args.errors ?? 0,
          label: args.label ?? 'Migration Results',
        },
      });
      return { shown: true };
    }

    case 'set_migration_config': {
      session.agentConfig = { ...(session.agentConfig ?? {}), ...args };
      streamEvent('set_config', { config: args });
      return { set: true, config: args };
    }

    // ── Execution tools ────────────────────────────────────────────────────
    case 'get_auth_status': {
      try {
        const sessions = await db.collection('authSessions')
          .find({ appUserId })
          .toArray();
        const googleSession = sessions.find(s => s.provider === 'google');
        const msSession = sessions.find(s => s.provider === 'microsoft' || s.provider === 'azure');
        return {
          google: googleSession ? { connected: true, email: googleSession.email } : { connected: false },
          microsoft: msSession ? { connected: true, email: msSession.email } : { connected: false },
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'get_migration_status': {
      const { step, migDir: dir, live, migDone, stats, c2g_live, cl2g_live, c2g_done, cl2g_done, currentBatchId } = migrationState;
      const isRunning = live || c2g_live || cl2g_live;
      const isDone = migDone || c2g_done || cl2g_done;
      const logTail = migrationLogs?.slice(-20) ?? [];
      let dbStatus = null;
      if (currentBatchId) {
        try {
          dbStatus = await db.collection('reportsWorkspace').findOne({ batchId: currentBatchId });
        } catch (e) { logger.warn(`get_migration_status DB query failed: ${e.message}`); }
      }
      return {
        step, direction: dir ?? 'none', running: isRunning, done: isDone,
        users: stats?.users ?? dbStatus?.progressUsers ?? 0,
        pages: stats?.pages ?? dbStatus?.progressPages ?? 0,
        errors: stats?.errors ?? dbStatus?.progressErrors ?? 0,
        recentLogs: logTail,
      };
    }

    case 'pre_flight_check': {
      const combo = COMBINATIONS[migDir];
      const blockers = [];
      const warnings = [];
      if (!migDir) {
        blockers.push('No migration direction selected');
      } else {
        blockers.push(...combo.authCheck(migrationState));
        const effectiveMappings = combo.mappingsCount(migrationState);
        if (combo.hasUpload && migDir === 'gemini-copilot' && !migrationState.uploadData) {
          blockers.push('No data uploaded or imported yet');
        }
        if (migDir === 'claude-gemini' && (migrationState.cl2g_upload_users ?? 0) === 0) {
          blockers.push('No ZIP uploaded yet');
        }
        if (effectiveMappings === 0) blockers.push('No users mapped');
        if (combo.isLive(migrationState)) blockers.push('Migration already running');
        if ((migrationState.selected_users_count ?? 0) < effectiveMappings) {
          warnings.push(`${effectiveMappings - (migrationState.selected_users_count ?? 0)} users have no destination — they will be skipped`);
        }
      }
      return { blockers, warnings, ready: blockers.length === 0 };
    }

    case 'auto_map_users': {
      if (!migDir) return { error: 'No direction selected' };
      try {
        const sourceUsers = await db.collection('cachedUsers')
          .find({ appUserId, role: 'source', migDir })
          .toArray();
        const destUsers = await db.collection('cachedUsers')
          .find({ appUserId, role: 'dest', migDir })
          .toArray();

        const destByEmail = new Map(destUsers.map(u => [u.email?.toLowerCase(), u]));
        const mappings = {};
        let matched = 0;
        for (const src of sourceUsers) {
          const dest = destByEmail.get(src.email?.toLowerCase());
          if (dest) { mappings[src.email] = dest.email; matched++; }
        }

        const collName = migDir === 'copilot-gemini' ? 'c2gUserMappings'
          : migDir === 'claude-gemini' ? 'cl2gUserMappings'
          : 'userMappings';

        await db.collection(collName).updateOne(
          { appUserId, migDir },
          { $set: { mappings, updatedAt: new Date() } },
          { upsert: true }
        );

        streamEvent('refresh_mapping', {});
        return { matched, total: sourceUsers.length };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'explain_log': {
      const line = args.log_line ?? '';
      const isErr = /error|fail|exception/i.test(line);
      const isWarn = /warn|skip|flag/i.test(line);
      const isSuc = /success|created|complet/i.test(line);
      if (isErr) return { explanation: 'This is an error — the migration engine hit a problem. Check user permissions and retry failed items after migration completes.' };
      if (isWarn) return { explanation: 'This is a warning — something was skipped but migration continued. Review skipped items in the report.' };
      if (isSuc) return { explanation: 'This is a success message — the item migrated correctly.' };
      return { explanation: 'This is an informational message showing normal migration progress.' };
    }

    case 'explain_error': {
      const recentErrors = migrationLogs?.filter(l => /error|fail/i.test(l)).slice(-10) ?? [];
      if (recentErrors.length === 0) return { explanation: 'No errors found in recent logs.' };
      try {
        const msg = await callAI([
          { role: 'system', content: 'You are a migration error analyst. Explain the errors in 2-3 plain English sentences with actionable fixes. Be concise.' },
          { role: 'user', content: `Migration errors:\n${recentErrors.join('\n')}` },
        ], null);
        return { explanation: msg.content ?? 'Could not analyze errors.' };
      } catch (e) {
        return { explanation: `Errors found: ${recentErrors.join('; ')}` };
      }
    }

    case 'get_conversation_history': {
      try {
        const history = await loadHistory(db, appUserId);
        return { messages: history, count: history.length };
      } catch (e) {
        return { error: e.message };
      }
    }

    case 'set_schedule': {
      try {
        const runAt = new Date(args.runAt);
        if (isNaN(runAt.getTime())) return { error: 'Invalid date format. Use ISO string like 2026-05-03T02:00:00Z' };
        const job = {
          appUserId,
          migDir,
          dryRun: args.dryRun ?? true,
          runAt,
          status: 'scheduled',
          createdAt: new Date(),
        };
        const result = await db.collection('scheduledJobs').insertOne(job);
        return { scheduled: true, jobId: result.insertedId.toString(), runAt: runAt.toISOString() };
      } catch (e) {
        return { error: e.message };
      }
    }

    // ── Destructive tools — executed after agentLoop confirmation ──────────
    case 'start_migration': {
      const { startMigration } = session._agentDeps ?? {};
      if (!startMigration) return { error: 'Migration executor not available' };
      const batchId = `batch_${Date.now()}`;
      startMigration({ dryRun: args.dryRun ?? true, batchId, migDir, appUserId }).catch(e => {
        logger.error(`Background migration failed: ${e.message}`);
      });
      session.currentBatchId = batchId;
      streamEvent('refresh_status', { batchId });
      return { started: true, batchId, dryRun: args.dryRun ?? true };
    }

    case 'retry_failed': {
      const { retryMigration } = session._agentDeps ?? {};
      if (!retryMigration) return { error: 'Retry executor not available' };
      const batchId = session.currentBatchId;
      if (!batchId) return { error: 'No migration batch found to retry' };
      retryMigration({ batchId, appUserId }).catch(e => {
        logger.error(`Background retry failed: ${e.message}`);
      });
      streamEvent('refresh_status', { batchId });
      return { retrying: true, batchId };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
