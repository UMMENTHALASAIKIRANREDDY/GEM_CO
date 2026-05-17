// extension/background.js
// SETUP REQUIRED: Replace __AZURE_CLIENT_ID__ with your AZURE_CLIENT_ID from .env
// After loading extension in Chrome, get extension ID from chrome://extensions
// Register https://<extension-id>.chromiumapp.org/ as redirect URI in Azure AD app

const CLIENT_ID = '__AZURE_CLIENT_ID__';
const SCOPES = 'Notes.Read Files.Read offline_access';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TOKEN') {
    getToken().then(token => sendResponse({ token })).catch(e => sendResponse({ error: e.message }));
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
  return acquireTokenViaOAuth();
}

async function acquireTokenViaOAuth() {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = crypto.randomUUID();

  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'select_account');

  const resultUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, url => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(url);
    });
  });

  const params = new URL(resultUrl).searchParams;
  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));

  const code = params.get('code');
  const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: SCOPES,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const e = await tokenRes.text();
    throw new Error(`Token exchange failed: ${e.slice(0, 200)}`);
  }

  const data = await tokenRes.json();
  const expiry = Date.now() + (data.expires_in * 1000);
  await new Promise(r => chrome.storage.local.set({ ms_token: data.access_token, ms_token_expiry: expiry }, r));
  return data.access_token;
}

function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
