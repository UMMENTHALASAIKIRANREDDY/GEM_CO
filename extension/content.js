// extension/content.js
const SERVER = 'https://migcomb.cftools.live';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hr — clear stored token after a day

// ── WS capture + auto-refresh ─────────────────────────────────────────────────
// Always hook WebSocket on every Copilot page load.
// - First visit (cfz_token in URL): store token, trigger New Chat, show toast.
// - Subsequent visits: silently POST fresh WS URL to keep server session alive.
// This means the Substrate token never goes stale as long as user uses Copilot.

const cfzToken = new URLSearchParams(location.search).get('cfz_token');

// Store new token (or extend TTL of existing one)
if (cfzToken) {
  chrome.storage.local.set({ cfz_token: cfzToken, cfz_token_ts: Date.now() });
}

// Always inject WS hook — passive, captures every new Substrate connection
injectWsHook();

function injectWsHook() {
  const hookScript = document.createElement('script');
  hookScript.textContent = `
    (function () {
      if (window.__cfzHooked) return;
      window.__cfzHooked = true;
      const _WS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (url && url.includes('substrate.office.com')) {
          window.postMessage({ type: 'CFZ_WS_URL', url }, '*');
        }
        return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
      };
      Object.setPrototypeOf(window.WebSocket, _WS);
      window.WebSocket.prototype = _WS.prototype;
    })();
  `;
  (document.head || document.documentElement).appendChild(hookScript);
  hookScript.remove();

  // Listen for ALL captured WS URLs (no { once: true } — refresh on every new chat)
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.type !== 'CFZ_WS_URL') return;
    const wsUrl = e.data.url;

    // Load stored migration token
    const stored = await new Promise(r =>
      chrome.storage.local.get(['cfz_token', 'cfz_token_ts'], r)
    );
    const token = stored.cfz_token;
    if (!token) return; // no active migration — nothing to do

    // Expire stored token after 24 hr
    if (Date.now() - (stored.cfz_token_ts || 0) > TOKEN_TTL_MS) {
      chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
      return;
    }

    console.log('[CFZ] Relaying substrate WS to server (token refresh or initial capture)');
    try {
      const r = await fetch(`${SERVER}/copilot/ws-capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, wsUrl }),
      });
      const data = await r.json();

      // Initial capture — show toast
      if (cfzToken && data.ok && !data.note) {
        showCfzToast('Migration started! Check the CloudFuze tab for progress.');
      }
      // Job finished or gone — clear stored token so we stop sending
      if (data.done || data.error === 'job not found or expired') {
        chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
      }
    } catch (err) {
      console.error('[CFZ] Relay failed:', err);
    }
  });

  // On first visit (cfz_token in URL): click New Chat to force a fresh WS immediately.
  // On return visits the hook catches the next natural WS open automatically.
  if (cfzToken) {
    setTimeout(() => {
      const newBtn = document.querySelector(
        '[aria-label*="new chat" i], [data-testid*="new-chat"], button[title*="New chat"]'
      );
      if (newBtn) {
        console.log('[CFZ] Clicking New Chat to force initial WS capture');
        newBtn.click();
      }
    }, 1500);
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
const SIDEBAR_ID = 'cfz-migration-sidebar';
const TOGGLE_ID  = 'cfz-sidebar-toggle';
let sidebarOpen = false;

function setSidebarOpen(open) {
  sidebarOpen = open;
  const sidebar = document.getElementById(SIDEBAR_ID);
  const toggle  = document.getElementById(TOGGLE_ID);
  if (!sidebar || !toggle) return;
  sidebar.style.transform = open ? 'translateX(0)' : 'translateX(100%)';
  toggle.style.right = open ? '396px' : '16px';
}

function injectSidebar() {
  if (document.getElementById(SIDEBAR_ID)) return;

  const toggle = document.createElement('div');
  toggle.id = TOGGLE_ID;
  toggle.title = 'CloudFuze Migration Viewer';
  toggle.innerHTML = `<svg width="22" height="22" viewBox="0 0 20 20" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M10 2L3 6v8l7 4 7-4V6L10 2zm0 2.2l5 2.85V13l-5 2.85L5 13V7.05L10 4.2z"/></svg>`;
  Object.assign(toggle.style, {
    position: 'fixed', right: '16px', top: '50%', transform: 'translateY(-50%)',
    width: '44px', height: '44px', background: '#0129AC', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', zIndex: '999999', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    transition: 'right 0.3s, background 0.2s',
  });
  toggle.addEventListener('mouseenter', () => { toggle.style.background = '#0050e6'; });
  toggle.addEventListener('mouseleave', () => { toggle.style.background = '#0129AC'; });

  const sidebar = document.createElement('div');
  sidebar.id = SIDEBAR_ID;
  Object.assign(sidebar.style, {
    position: 'fixed', right: '0', top: '0', width: '380px', height: '100vh',
    background: 'white', zIndex: '999998', boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
    transform: 'translateX(100%)', transition: 'transform 0.3s ease',
  });

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sidebar.html');
  Object.assign(iframe.style, { width: '100%', height: '100%', border: 'none' });
  sidebar.appendChild(iframe);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setSidebarOpen(!sidebarOpen);
  });

  // Close sidebar when clicking anywhere outside it
  document.addEventListener('click', (e) => {
    if (!sidebarOpen) return;
    if (e.target.closest(`#${SIDEBAR_ID}`) || e.target.closest(`#${TOGGLE_ID}`)) return;
    setSidebarOpen(false);
  });

  document.body.appendChild(toggle);
  document.body.appendChild(sidebar);
}

window.addEventListener('message', e => {
  if (e.data?.type !== 'CFZ_SEND_TO_COPILOT') return;
  injectIntoCopilot(e.data.text);
});

function findCopilotInput() {
  return (
    document.getElementById('m365-chat-editor-target-element') ||
    document.querySelector('[placeholder="Message Copilot"]') ||
    document.querySelector('[aria-placeholder="Message Copilot"]') ||
    document.querySelector('[aria-label="Message Copilot"]') ||
    [...document.querySelectorAll('[contenteditable="true"]')].find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 20 && r.bottom > window.innerHeight * 0.4;
    }) || null
  );
}

async function injectIntoCopilot(text) {
  // Retry a few times — element may not be rendered yet
  let input = null;
  for (let i = 0; i < 5; i++) {
    input = findCopilotInput();
    if (input) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!input) {
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    showCfzToast('Copied — click chat input and press Ctrl+V');
    return;
  }

  input.focus();

  // Method 1: synthetic paste (works with most SPA editors)
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    if (input.textContent?.trim() || input.value?.trim()) return;
  } catch (_) {}

  // Method 2: execCommand insertText
  if (input.contentEditable === 'true') {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand('insertText', false, text)) return;
    } catch (_) {}
  }

  // Method 3: direct assignment + events
  if (input.contentEditable === 'true') {
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  } else {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function showCfzToast(msg) {
  const existing = document.getElementById('cfz-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'cfz-toast';
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
    background: '#0129AC', color: 'white', padding: '10px 18px', borderRadius: '6px',
    fontSize: '13px', zIndex: '9999999', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    pointerEvents: 'none',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectSidebar);
} else {
  injectSidebar();
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(injectSidebar, 500);
  }
}).observe(document.body, { subtree: true, childList: true });
