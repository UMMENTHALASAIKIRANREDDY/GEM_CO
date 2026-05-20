// extension/sidebar.js
const GRAPH = 'https://graph.microsoft.com/v1.0';
let graphToken = null;

document.getElementById('signin-btn').onclick = signIn;
document.getElementById('signout-btn').onclick = signOut;

// Auto-resume if token already cached — no popup
chrome.runtime.sendMessage({ type: 'CHECK_TOKEN' }, res => {
  if (res?.token) {
    graphToken = res.token;
    showSignedIn();
    loadConversations();
  }
});

function signIn() {
  show('loading');
  hide('signin-section');
  chrome.runtime.sendMessage({ type: 'GET_TOKEN' }, res => {
    hide('loading');
    if (res?.error) {
      showError('Sign-in failed: ' + res.error);
      show('signin-section');
      return;
    }
    graphToken = res.token;
    showSignedIn();
    loadConversations();
  });
}

function signOut() {
  chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, () => {
    graphToken = null;
    hide('list-section');
    hide('error-msg');
    document.getElementById('signout-btn').style.display = 'none';
    show('signin-section');
  });
}

function showSignedIn() {
  hide('signin-section');
  document.getElementById('signout-btn').style.display = 'block';
}

async function loadConversations() {
  show('loading');
  hide('error-msg');
  hide('list-section');

  try {
    const res = await graphFetch(`${GRAPH}/me/drive/root:/GemCo/index.json:/content`);
    if (res.status === 404) { showError('No migrated conversations found. Run a migration first.'); return; }
    if (!res.ok) { showError(`Error loading index: ${res.status}`); return; }
    const index = await res.json();
    renderList(index.migrations || []);
  } catch (e) {
    showError('Failed to load: ' + e.message);
  } finally {
    hide('loading');
  }
}

function renderList(migrations) {
  const section = document.getElementById('list-section');
  if (!migrations.length) {
    section.innerHTML = '<p style="color:#605e5c;font-size:13px;padding:16px 0">No migrations found.</p>';
    show('list-section');
    return;
  }

  section.innerHTML = migrations.map(m => `
    <div class="source-group">
      <div class="source-header">${esc(m.source)} · ${m.conversations.length} conversations</div>
      ${(m.conversations || []).map(c => `
        <div class="conv-item" data-page-id="${esc(c.pageId)}" data-title="${esc(c.title)}">
          <div class="conv-title">${esc(c.title)}</div>
        </div>
      `).join('')}
    </div>
  `).join('');

  section.querySelectorAll('.conv-item').forEach(el => {
    el.onclick = () => sendConversationToCopilot(el);
  });

  show('list-section');
}

function sendConversationToCopilot(el) {
  const title = el.dataset.title;
  window.parent.postMessage({ type: 'CFZ_SEND_TO_COPILOT', text: title }, '*');

  el.classList.add('sent');
  el.querySelector('.conv-title').textContent = '✓ ' + title;
  setTimeout(() => {
    el.classList.remove('sent');
    el.querySelector('.conv-title').textContent = title;
  }, 1500);
}

function graphFetch(url) {
  return fetch(url, { headers: { Authorization: `Bearer ${graphToken}` } });
}

function showError(msg) {
  hide('loading');
  hide('list-section');
  const el = document.getElementById('error-msg');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = 'block'; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
