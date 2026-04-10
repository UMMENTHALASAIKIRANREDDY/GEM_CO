import { google } from 'googleapis';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('module:auditLogClient');

/**
 * Queries the Google Admin SDK Reports API for Drive access events in a time window.
 * Used to correlate which Drive files were accessed during Gemini conversations.
 */
export class AuditLogClient {
  constructor(googleAuthClient) {
    this.auth = googleAuthClient;
    this.reports = google.admin({ version: 'reports_v1', auth: googleAuthClient });
  }

  /**
   * Get Drive access events for a user in a given time window.
   * Adds bufferMinutes padding on both sides of the window.
   *
   * @param {string} userEmail - filter by actor (or 'all' for domain-wide)
   * @param {Date|string} startTime
   * @param {Date|string} endTime
   * @param {number} bufferMinutes
   * @returns {Promise<Array<{docId, docTitle, docType, mimeType, ownerEmail, accessTime}>>}
   */
  async getDriveEventsForWindow(userEmail, startTime, endTime, bufferMinutes = 5, eventName = null, applicationName = 'access_evaluation') {
    const start = new Date(startTime);
    const end = new Date(endTime);
    start.setMinutes(start.getMinutes() - bufferMinutes);
    end.setMinutes(end.getMinutes() + bufferMinutes);

    const params = {
      userKey: userEmail,
      applicationName,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      maxResults: 1000,
    };

    if (eventName) params.eventName = eventName;

    const events = [];
    let pageToken = null;
    let page = 0;

    do {
      if (pageToken) params.pageToken = pageToken;

      try {
        const res = await this.reports.activities.list(params);
        const items = res.data.items || [];

        for (const item of items) {
          const actor = item.actor?.email || '';
          for (const event of (item.events || [])) {
            const params_ = {};
            for (const p of (event.parameters || [])) {
              params_[p.name] = p.value || p.boolValue || p.intValue || null;
            }

            const docId = params_['doc_id'] || params_['resource_name'] || params_['object_id'];
            if (!docId) {
              // Log raw params for unknown event shapes so we can identify field names
              logger.info(`AuditLog: skipped event="${event.name}" actor=${actor} params=${JSON.stringify(params_).slice(0, 300)}`);
              continue;
            }

            logger.info(`AuditLog: event="${event.name}" docTitle="${params_['doc_title'] || params_['resource_name']}" actor=${actor}`);
            const docTitle = params_['doc_title'] || params_['resource_name'] || null;
            const docType  = params_['doc_type'] || null;
            const owner    = params_['owner'] || params_['owner_email'] || actor;
            events.push({
              docId,
              eventName: event.name,
              actor,          // raw actor email — Gemini reads have service account here
              docTitle,
              docType,
              mimeType: docType ? _docTypeToMime(docType) : null,
              ownerEmail: owner,
              accessTime: item.id?.time ? new Date(item.id.time) : new Date(start),
            });
          }
        }

        pageToken = res.data.nextPageToken || null;
        page++;

        if (pageToken) {
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (err) {
        const errDetail = JSON.stringify(err.response?.data || err.message || '');

        if (err.code === 404 || err.status === 404) {
          logger.warn(`AuditLog: 404 for ${userEmail}: ${err.message}`);
          break;
        }
        if (err.code === 403 || err.status === 403) {
          logger.warn(`AuditLog: 403 for ${userEmail}: ${err.message} — ${errDetail}`);
          break;
        }
        if (err.code === 400 || err.status === 400) {
          logger.warn(`AuditLog: 400 for ${userEmail}: ${err.message} — ${errDetail}`);
          break;
        }
        throw err;
      }
    } while (pageToken);

    logger.info(`AuditLog: found ${events.length} Drive access event(s) for ${userEmail} across ${page} page(s)`);
    return events;
  }

  /**
   * Same as getDriveEventsForWindow but falls back to userKey='all' if the
   * user-specific query returns nothing. Filters results by ownerEmail client-side.
   */
  async getDriveEventsForWindowWithFallback(userEmail, startTime, endTime, bufferMinutes = 5) {
    // Try each application name — Gemini file reads appear as 'view' events under 'drive'
    const appNames = ['drive', 'access_evaluation'];

    for (const appName of appNames) {
      let events = await this.getDriveEventsForWindow(userEmail, startTime, endTime, bufferMinutes, null, appName);
      if (events.length > 0) {
        logger.info(`AuditLog: found ${events.length} event(s) via userKey=${userEmail} app=${appName}`);
        return events;
      }

      // Fallback to userKey='all' for this app
      logger.info(`AuditLog: retrying with userKey='all' app=${appName} for ${userEmail}`);
      const allEvents = await this.getDriveEventsForWindow('all', startTime, endTime, bufferMinutes, null, appName);
      events = allEvents.filter(e => e.ownerEmail === userEmail);
      if (events.length > 0) {
        logger.info(`AuditLog: found ${events.length} event(s) via userKey='all' app=${appName} for ${userEmail}`);
        return events;
      }
    }

    return [];
  }

  /**
   * Diagnostic method — tries both userKey=userEmail and userKey='all',
   * returns a summary so you can see which works.
   *
   * @param {string} userEmail
   * @param {Date|string} startTime
   * @param {Date|string} endTime
   * @returns {Promise<{byUser: {count, events}, byAll: {count, events}}>}
   */
  async testQuery(userEmail, startTime, endTime) {
    const result = {
      byUser:             { count: 0, events: [], error: null },
      byAll:              { count: 0, events: [], error: null },
      geminiByUser:       { count: 0, events: [], error: null },
      geminiByAll:        { count: 0, events: [], error: null },
    };

    const mapEvent = e => ({
      docTitle: e.docTitle, docType: e.docType,
      eventName: e.eventName, ownerEmail: e.ownerEmail, accessTime: e.accessTime,
    });

    // drive app
    try {
      const evts = await this.getDriveEventsForWindow(userEmail, startTime, endTime, 60, null, 'drive');
      result.byUser.count = evts.length;
      result.byUser.events = evts.slice(0, 5).map(mapEvent);
    } catch (err) { result.byUser.error = err.message; }

    try {
      const evts = await this.getDriveEventsForWindow('all', startTime, endTime, 60, null, 'drive');
      result.byAll.count = evts.length;
      result.byAll.events = evts.slice(0, 5).map(mapEvent);
    } catch (err) { result.byAll.error = err.message; }

    // access_evaluation app — where Gemini file access events appear in Admin Console
    try {
      const evts = await this.getDriveEventsForWindow(userEmail, startTime, endTime, 60, null, 'access_evaluation');
      result.geminiByUser.count = evts.length;
      result.geminiByUser.events = evts.slice(0, 10).map(mapEvent);
    } catch (err) { result.geminiByUser.error = err.message; }

    try {
      const evts = await this.getDriveEventsForWindow('all', startTime, endTime, 60, null, 'access_evaluation');
      result.geminiByAll.count = evts.length;
      result.geminiByAll.events = evts.slice(0, 10).map(mapEvent);
    } catch (err) { result.geminiByAll.error = err.message; }

    return result;
  }
}

/**
 * Map Vault/audit doc_type strings to MIME types for scoring.
 */
function _docTypeToMime(docType) {
  const map = {
    'document': 'application/vnd.google-apps.document',
    'spreadsheet': 'application/vnd.google-apps.spreadsheet',
    'presentation': 'application/vnd.google-apps.presentation',
    'pdf': 'application/pdf',
    'drawing': 'application/vnd.google-apps.drawing',
    'form': 'application/vnd.google-apps.form',
    'folder': 'application/vnd.google-apps.folder',
    'video': 'video/mp4',
    'image': 'image/jpeg',
    'text': 'text/plain',
    'csv': 'text/csv',
    'msexcel': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'msword': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'mspowerpoint': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[docType?.toLowerCase()] || null;
}
