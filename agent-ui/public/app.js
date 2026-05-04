// agent-ui/public/app.js

const API = '';  // same-origin (proxied)

// ── State ──────────────────────────────────────────────────────────────────
let sessions = [];
let activeSessionId = null;
let activeEventIndex = null;
let traceEvents = [];

// ── DOM refs ───────────────────────────────────────────────────────────────
const elSessionList  = document.getElementById('session-list');
const elTraceEvents  = document.getElementById('trace-events');
const elDetailJson   = document.getElementById('detail-json');
const elTraceTitle   = document.getElementById('trace-title');
const elTraceCount   = document.getElementById('trace-count');
const elLiveBadge    = document.getElementById('live-badge');
const elBtnRefresh   = document.getElementById('btn-refresh');

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function eventSummary(ev) {
  if (ev.type === 'tool_call')      return `→ ${ev.toolName}(${JSON.stringify(ev.toolArgs ?? {}).slice(0, 60)})`;
  if (ev.type === 'tool_result')    return `← ${ev.toolName}: ${JSON.stringify(ev.result ?? ev.output ?? {}).slice(0, 60)}`;
  if (ev.type === 'llm_response')   return (ev.content ?? '').slice(0, 80);
  if (ev.type === 'session_start')  return `user=${ev.appUserId ?? '?'}  step=${ev.step ?? '-'}  dir=${ev.migDir ?? '-'}`;
  if (ev.type === 'session_end')    return `tools=${ev.toolCallCount ?? 0}  replyLen=${ev.finalReplyLength ?? 0}`;
  if (ev.type === 'confirmation_gate') return `${ev.toolName}: ${(ev.confirmText ?? '').slice(0, 60)}`;
  if (ev.type === 'error')          return ev.error ?? 'unknown error';
  return JSON.stringify(ev).slice(0, 80);
}

// ── Session list ───────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const r = await fetch(`${API}/api/audit/sessions`);
    sessions = await r.json();
    renderSessions();
  } catch (e) {
    elSessionList.innerHTML = `<li class="empty-state">Failed to load sessions</li>`;
  }
}

function renderSessions() {
  if (!sessions.length) {
    elSessionList.innerHTML = `<li class="empty-state">No sessions yet</li>`;
    return;
  }
  elSessionList.innerHTML = sessions.map((s, i) => `
    <li data-idx="${i}" class="${s.sessionId === activeSessionId ? 'active' : ''}">
      <div class="sess-id">${s.sessionId}</div>
      <div class="sess-meta">${fmtDate(s.lastTs)} · ${s.eventCount} events · ${s.migDir ?? 'no dir'}</div>
      <div class="sess-snippet">${s.messageSnippet ?? ''}</div>
    </li>
  `).join('');

  elSessionList.querySelectorAll('li[data-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const s = sessions[+el.dataset.idx];
      selectSession(s.sessionId);
    });
  });
}

async function selectSession(sessionId) {
  activeSessionId = sessionId;
  activeEventIndex = null;
  elDetailJson.textContent = '';

  // Re-render list to update active state
  renderSessions();

  const shortId = sessionId.slice(-12);
  elTraceTitle.textContent = `Session …${shortId}`;
  elTraceEvents.innerHTML = `<div class="empty-state">Loading…</div>`;

  try {
    const r = await fetch(`${API}/api/audit/session/${encodeURIComponent(sessionId)}`);
    traceEvents = await r.json();
    elTraceCount.textContent = `${traceEvents.length} events`;
    renderTrace();
  } catch (e) {
    elTraceEvents.innerHTML = `<div class="empty-state">Failed to load trace</div>`;
  }
}

function renderTrace() {
  if (!traceEvents.length) {
    elTraceEvents.innerHTML = `<div class="empty-state">No events</div>`;
    return;
  }
  elTraceEvents.innerHTML = traceEvents.map((ev, i) => `
    <div class="event-row${i === activeEventIndex ? ' active' : ''}" data-idx="${i}">
      <span class="event-time">${fmtTime(ev.ts)}</span>
      <span class="event-type type-${ev.type}">${ev.type}</span>
      <span class="event-summary">${escHtml(eventSummary(ev))}</span>
    </div>
  `).join('');

  elTraceEvents.querySelectorAll('.event-row').forEach(el => {
    el.addEventListener('click', () => {
      activeEventIndex = +el.dataset.idx;
      renderTrace();  // re-render to update active
      showDetail(traceEvents[activeEventIndex]);
    });
  });
}

function showDetail(ev) {
  elDetailJson.textContent = JSON.stringify(ev, null, 2);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Live SSE ───────────────────────────────────────────────────────────────
let evtSource = null;

function connectSSE() {
  const old = evtSource;
  evtSource = null;
  if (old) old.close();
  evtSource = new EventSource(`${API}/api/audit/stream`);

  evtSource.onopen = () => {
    elLiveBadge.textContent = '● Live';
    elLiveBadge.className = 'badge-live';
  };

  evtSource.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }

    // If this event belongs to currently viewed session, append to trace
    if (ev.sessionId === activeSessionId) {
      traceEvents.push(ev);
      elTraceCount.textContent = `${traceEvents.length} events`;
      renderTrace();
      // Auto-scroll trace panel
      elTraceEvents.scrollTop = elTraceEvents.scrollHeight;
    }

    // If it's a session_start for a new session, prepend to session list
    if (ev.type === 'session_start') {
      const existing = sessions.findIndex(s => s.sessionId === ev.sessionId);
      if (existing === -1) {
        sessions.unshift({
          sessionId: ev.sessionId,
          lastTs: ev.ts,
          firstTs: ev.ts,
          appUserId: ev.appUserId,
          step: ev.step,
          migDir: ev.migDir,
          messageSnippet: ev.message,
          eventCount: 1,
        });
      }
      renderSessions();
    }

    // Update event count for the session in the list
    const sess = sessions.find(s => s.sessionId === ev.sessionId);
    if (sess) {
      sess.eventCount = (sess.eventCount ?? 0) + 1;
      sess.lastTs = ev.ts;
      renderSessions();
    }
  };

  evtSource.onerror = () => {
    if (!evtSource || evtSource.readyState === EventSource.CLOSED) return;
    elLiveBadge.textContent = '● Offline';
    elLiveBadge.className = 'badge-offline';
    setTimeout(connectSSE, 5000);
  };
}

// ── Init ───────────────────────────────────────────────────────────────────
elBtnRefresh.addEventListener('click', loadSessions);

loadSessions();
connectSSE();
