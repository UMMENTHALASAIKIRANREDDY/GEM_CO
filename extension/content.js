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

    if (data.ok && !data.note) {
      showCfzToast('Migration started! Check the CloudFuze tab for progress.');
    }
    if (data.done || data.error === 'job not found or expired') {
      chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
    }
  } catch (err) {
    console.error('[CFZ] Relay failed:', err);
  }
});

// On every Copilot page load with an active migration token:
// click New Chat then auto-send a probe message to trigger the Substrate WebSocket.
chrome.storage.local.get(['cfz_token', 'cfz_token_ts'], (stored) => {
  if (!stored.cfz_token) return;
  if (Date.now() - (stored.cfz_token_ts || 0) > TOKEN_TTL_MS) {
    chrome.storage.local.remove(['cfz_token', 'cfz_token_ts']);
    return;
  }
  // Give the SPA time to render before interacting
  setTimeout(triggerWebSocket, 2000);
});

async function triggerWebSocket() {
  // Click New Chat so we start fresh (not mid-conversation)
  const newBtn = document.querySelector(
    '[aria-label*="new chat" i], [data-testid*="new-chat"], button[title*="New chat"]'
  );
  if (newBtn) {
    newBtn.click();
    await sleep(1200);
  }

  // Find the chat input — try multiple selectors
  let input = null;
  for (let i = 0; i < 8; i++) {
    input =
      document.getElementById('m365-chat-editor-target-element') ||
      document.querySelector('[placeholder="Message Copilot"]') ||
      document.querySelector('[aria-placeholder="Message Copilot"]') ||
      document.querySelector('[aria-label="Message Copilot"]') ||
      [...document.querySelectorAll('[contenteditable="true"]')].find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 100 && r.height > 20 && r.bottom > window.innerHeight * 0.4;
      });
    if (input) break;
    await sleep(500);
  }

  if (!input) {
    console.log('[CFZ] Could not find Copilot input — user must send a message manually');
    return;
  }

  input.focus();

  // Inject probe text via synthetic paste (works with most SPA editors)
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Hi');
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  } catch (_) {
    try { document.execCommand('insertText', false, 'Hi'); } catch (_) {}
  }

  await sleep(400);

  // Send — prefer the Send button, fall back to Enter key
  const sendBtn = document.querySelector(
    'button[aria-label*="send" i], button[data-testid*="send"], button[aria-label*="Submit" i]'
  );
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
    console.log('[CFZ] Probe message sent via button — WS will be captured');
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    console.log('[CFZ] Probe message sent via Enter — WS will be captured');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
