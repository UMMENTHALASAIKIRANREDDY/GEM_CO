// extension/background.js
const CLIENT_ID = '68beff40-49fb-4e36-82fe-317bc839a344';
const SCOPES = 'Notes.Read Files.Read';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TOKEN') {
    getToken().then(token => sendResponse({ token })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'CHECK_TOKEN') {
    new Promise(r => chrome.storage.local.get(['ms_token', 'ms_token_expiry'], r))
      .then(c => sendResponse({ token: (c.ms_token && c.ms_token_expiry > Date.now() + 60000) ? c.ms_token : null }));
    return true;
  }
  if (msg.type === 'SIGN_OUT') {
    chrome.storage.local.remove(['ms_token', 'ms_token_expiry'], () => sendResponse({ ok: true }));
    return true;
  }
});

async function getToken() {
  const cached = await new Promise(r => chrome.storage.local.get(['ms_token', 'ms_token_expiry'], r));
  if (cached.ms_token && cached.ms_token_expiry > Date.now() + 60000) {
    return cached.ms_token;
  }
  return acquireTokenImplicit();
}

async function acquireTokenImplicit() {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const state = crypto.randomUUID();

  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');
  authUrl.searchParams.set('response_mode', 'fragment');

  const resultUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, url => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(url);
    });
  });

  // Token comes back in the URL fragment
  const hash = new URL(resultUrl).hash.slice(1);
  const params = new URLSearchParams(hash);

  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));

  const token = params.get('access_token');
  if (!token) throw new Error('No access token in response');

  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
  const expiry = Date.now() + expiresIn * 1000;
  await new Promise(r => chrome.storage.local.set({ ms_token: token, ms_token_expiry: expiry }, r));
  return token;
}
