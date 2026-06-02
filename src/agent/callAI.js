// src/agent/callAI.js
// Backwards-compatible: same exported API + same error shape on permanent failure.
// New behavior: transparently retries 429 (rate limit) and transient 5xx errors
// with exponential backoff, honoring the upstream `retry-after` header when
// present. If all retries fail, the original error is thrown — callers see no
// change.

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;
const MAX_DELAY_MS = 10_000;

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// retry-after can be: "30" (seconds), "30000" (some Azure variants ship ms),
// or an HTTP-date. We clamp to MAX_DELAY_MS so we never wait absurdly long.
function _parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const trimmed = String(headerValue).trim();
  // Numeric seconds
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    // Heuristic: values >300 (5 min) look like ms not seconds — Azure has shipped both
    return n > 300 ? Math.min(n, MAX_DELAY_MS) : Math.min(n * 1000, MAX_DELAY_MS);
  }
  // HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, MAX_DELAY_MS) : null;
  }
  return null;
}

function _shouldRetry(status) {
  // 429 = rate limited, 500/502/503/504 = transient upstream issues
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function _fetchWithRetry(url, init, providerLabel) {
  let lastErrorText = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch(url, init);
    if (r.ok) return r;

    lastStatus = r.status;
    // Read body once; some implementations let you re-read but it's not portable.
    lastErrorText = await r.text();

    if (!_shouldRetry(r.status) || attempt === MAX_RETRIES) {
      // Permanent failure (4xx other than 429) or out of retries — throw exactly
      // like the previous implementation so callers' error handling is unchanged.
      throw new Error(`${providerLabel} error ${r.status}: ${lastErrorText}`);
    }

    const retryAfterMs = _parseRetryAfter(r.headers.get('retry-after'));
    // Exponential backoff (1.5s, 3s, 6s) capped at MAX_DELAY_MS; honor server hint if larger.
    const backoff = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    const waitMs = Math.max(retryAfterMs || 0, backoff);
    console.warn(`[callAI] ${providerLabel} ${r.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
    await _sleep(waitMs);
  }
  // Unreachable, but for completeness
  throw new Error(`${providerLabel} error ${lastStatus}: ${lastErrorText}`);
}

export async function callAI(messages, tools) {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const openaiKey = process.env.OPENAI_API_KEY;

  // Sanitize: drop any messages missing role (prevents Azure/OpenAI 400 errors)
  const safeMessages = messages.filter(m => m && m.role && (m.content || m.tool_calls));

  let response;

  // OPENAI_API_KEY takes priority — use OpenAI directly even if Azure vars are set
  if (openaiKey) {
    const body = { model: process.env.OPENAI_MODEL || 'gpt-4o', messages: safeMessages, max_tokens: 1800, temperature: 0.15 };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    const r = await _fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify(body),
      },
      'OpenAI'
    );
    response = await r.json();
  } else if (azureEndpoint && azureKey) {
    const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    const body = { messages: safeMessages, max_tokens: 1800, temperature: 0.15 };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    const r = await _fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': azureKey },
        body: JSON.stringify(body),
      },
      'Azure OpenAI'
    );
    response = await r.json();
  } else {
    throw new Error('No AI provider configured. Set OPENAI_API_KEY or AZURE_OPENAI_API_KEY in .env');
  }

  return response.choices?.[0]?.message ?? { content: 'No response from AI.' };
}
