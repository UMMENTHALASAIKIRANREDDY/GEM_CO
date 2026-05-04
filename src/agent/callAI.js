// src/agent/callAI.js
export async function callAI(messages, tools) {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const openaiKey = process.env.OPENAI_API_KEY;

  let response;

  if (azureEndpoint && azureKey) {
    const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    const body = { messages, max_tokens: 900, temperature: 0.4 };
    if (tools) body.tools = tools;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': azureKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`Azure OpenAI error ${r.status}: ${t}`); }
    response = await r.json();
  } else if (openaiKey) {
    const body = { model: 'gpt-4o', messages, max_tokens: 700, temperature: 0.35 };
    if (tools) body.tools = tools;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI error ${r.status}: ${t}`); }
    response = await r.json();
  } else {
    throw new Error('No AI provider configured. Set AZURE_OPENAI_API_KEY or OPENAI_API_KEY in .env');
  }

  return response.choices?.[0]?.message ?? { content: 'No response from AI.' };
}
