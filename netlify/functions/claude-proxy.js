// DBE Narrative Builder — Netlify Serverless Proxy
// Stores your Anthropic API key securely server-side.
// Called by the embedded HTML widget on your GoDaddy site.

exports.handler = async function (event) {
  // Allow CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: cors(),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: 'Server configuration error: API key not set.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: body.system,
        messages: body.messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: cors(),
        body: JSON.stringify({ error: data.error?.message || 'Anthropic API error' }),
      };
    }

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: cors(),
      body: JSON.stringify({ error: 'Could not reach Anthropic: ' + err.message }),
    };
  }
};

function cors() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
