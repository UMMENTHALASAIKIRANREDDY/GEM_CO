// src/agent/callAI.js
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
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI error ${r.status}: ${t}`); }
    response = await r.json();
  } else if (azureEndpoint && azureKey) {
    const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    const body = { messages: safeMessages, max_tokens: 1800, temperature: 0.15 };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': azureKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`Azure OpenAI error ${r.status}: ${t}`); }
    response = await r.json();
  } else {
    throw new Error('No AI provider configured. Set OPENAI_API_KEY or AZURE_OPENAI_API_KEY in .env');
  }

  return response.choices?.[0]?.message ?? { content: 'No response from AI.' };
}
