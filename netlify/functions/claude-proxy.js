// DBE Narrative Builder — Netlify Serverless Proxy
// Handles two routes via the request body:
//   1. Claude chat: { system, messages }                         → Anthropic Messages API
//   2. Google TTS:  { tts: true, text: "..." }                    → Google Cloud TTS (Neural2)
// API keys are stored as Netlify environment variables:
//   ANTHROPIC_API_KEY   — for Claude chat
//   GOOGLE_TTS_API_KEY  — for Google Text-to-Speech Neural2

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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  // Route: Google TTS
  if (body.tts === true) {
    return await handleTTS(body);
  }

  // Route: Claude chat (default)
  return await handleClaude(body);
};

// ---------------------------------------------------------------------------
// Claude chat handler (unchanged behavior from original proxy)
// ---------------------------------------------------------------------------
async function handleClaude(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: 'Server configuration error: ANTHROPIC_API_KEY not set.' }),
    };
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
}

// ---------------------------------------------------------------------------
// Google Cloud TTS handler
// Uses Chirp 3 HD voice en-US-Chirp3-HD-Orus for a warm, professional male voice.
// Chirp 3 HD is Google's current-generation voice tier with significantly more
// natural prosody than the legacy Neural2 voices.
// Returns base64-encoded MP3 audio.
//
// Note: Chirp 3 HD voices do NOT support SSML, speakingRate, or pitch params.
// The audioConfig intentionally omits those fields.
// ---------------------------------------------------------------------------
async function handleTTS(body) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: 'Server configuration error: GOOGLE_TTS_API_KEY not set.' }),
    };
  }

  const text = (body.text || '').trim();
  if (!text) {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'TTS request missing "text" field.' }),
    };
  }

  // Hard cap on input length to protect against runaway requests and
  // Google's per-request character limits.
  if (text.length > 5000) {
    return {
      statusCode: 400,
      headers: cors(),
      body: JSON.stringify({ error: 'TTS text exceeds 5000 character limit.' }),
    };
  }

  try {
    const response = await fetch(
      'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: text },
          voice: {
            languageCode: 'en-US',
            name: 'en-US-Chirp3-HD-Orus',
          },
          audioConfig: {
            audioEncoding: 'MP3',
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: cors(),
        body: JSON.stringify({ error: data.error?.message || 'Google TTS API error' }),
      };
    }

    // Google returns { audioContent: "<base64 mp3>" }
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ audioContent: data.audioContent }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: cors(),
      body: JSON.stringify({ error: 'Could not reach Google TTS: ' + err.message }),
    };
  }
}

function cors() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

