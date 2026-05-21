// extension/content.js
// Runs in ISOLATED world. hook.js (MAIN world) posts CFZ_WS_URL messages.
const SERVER = 'https://migcomb.cftools.live';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hr

const cfzToken = new URLSearchParams(location.search).get('cfz_token');

if (cfzToken) {
  chrome.storage.local.set({ cfz_token: cfzToken, cfz_token_ts: Date.now() });
}

// Receive WS URLs from hook.js and relay to server
window.addEventListener('message', async (e) => {
  if (e.source !== window || e.data?.type !== 'CFZ_WS_URL') return;
  const wsUrl = e.data.url;

  const stored = await new Promise(r =>
    chrome.storage.local.get(['cfz_token', 'cfz_token_ts'], r)
  );
  const token = stored.cfz_token;
  if (!token) return;

  if (Date.now() - (stored.cfz_token_ts || 0) > TOKEN_TTL_MS) {
    chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
    return;
  }

  console.log('[CFZ] Relaying substrate WS to server');
  try {
    const r = await fetch(`${SERVER}/copilot/ws-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, wsUrl }),
    });
    const data = await r.json();

    if (cfzToken && data.ok && !data.note) {
      showCfzToast('Migration started! Check the CloudFuze tab for progress.');
    }
    if (data.done || data.error === 'job not found or expired') {
      chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
    }
  } catch (err) {
    console.error('[CFZ] Relay failed:', err);
  }
});

// Click New Chat whenever migration is active — works on first load AND after Copilot's own login redirect
// (cfz_token may not be in URL after redirect, but IS in storage)
chrome.storage.local.get(['cfz_token', 'cfz_token_ts'], (stored) => {
  if (!stored.cfz_token) return;
  if (Date.now() - (stored.cfz_token_ts || 0) > TOKEN_TTL_MS) {
    chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
    return;
  }
  setTimeout(() => {
    const newBtn = document.querySelector(
      '[aria-label*="new chat" i], [data-testid*="new-chat"], button[title*="New chat"]'
    );
    if (newBtn) {
      console.log('[CFZ] Clicking New Chat to force WS capture');
      newBtn.click();
    }
  }, 2000);
});

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

// Re-inject on SPA navigation (Copilot navigates without full page reload)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
  }
}).observe(document.body, { subtree: true, childList: true });
