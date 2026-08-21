// DBE Narrative Builder — Netlify Serverless Proxy
// Handles two routes via the request body:
//   1. Claude chat: { profile, messages }                        → Anthropic Messages API
//   2. Google TTS:  { tts: true, text: "..." }                   → Google Cloud TTS (Chirp 3 HD)
// API keys are stored as Netlify environment variables:
//   ANTHROPIC_API_KEY   — for Claude chat
//   GOOGLE_TTS_API_KEY  — for Google Text-to-Speech Chirp 3 HD
//   DEMO_ENABLED        — set to "false" to disable the demo without a redeploy
//
// ---------------------------------------------------------------------------
// ABUSE CONTROLS
// This is a public, unauthenticated demo, so it cannot be made abuse-proof.
// The goal is to make it worthless to steal and bounded in cost:
//   1. The system prompt is built HERE, not accepted from the caller. Callers
//      can only run a DBE narrative interview — not arbitrary Claude requests.
//   2. Input size is capped (message count, per-message and total characters).
//   3. Per-IP hourly limits and global daily limits, backed by Netlify Blobs.
//   4. Origin allowlist. Note this is browser-enforced only — it stops other
//      sites embedding the endpoint, but not curl. It is defense in depth.
//   5. A kill switch via DEMO_ENABLED.
// The real financial backstop is a monthly spend cap set in the Anthropic
// Console and a budget + quota cap on the Google Cloud TTS API.
// ---------------------------------------------------------------------------

const LIMITS = {
  MAX_MESSAGES: 60,
  MAX_TOTAL_CHARS: 30000,
  MAX_MSG_CHARS: 4000,
  MAX_TTS_CHARS: 1200,
  // A full 20-topic interview is roughly 50 chat calls and 50 TTS calls, so
  // the per-IP hourly limits allow one complete run. The global daily caps
  // allow about six full interviews a day, which is ample for a portfolio
  // demo and keeps worst-case spend small. TTS is billed per character and
  // is the more expensive of the two, so its ceiling is set lower.
  IP_CHAT_PER_HOUR: 60,
  IP_TTS_PER_HOUR: 60,
  GLOBAL_CHAT_PER_DAY: 300,
  GLOBAL_TTS_PER_DAY: 150,
};

const ALLOWED_ORIGINS = [
  'https://dbe-narrative-builder.netlify.app',
  'https://generoth.com',
  'https://www.generoth.com',
  'http://localhost:8888',
];

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1200;

exports.handler = async function (event) {
  const origin = event.headers.origin || event.headers.Origin || '';

  // Allow CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(origin), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return fail(405, 'Method not allowed', origin);
  }

  if (process.env.DEMO_ENABLED === 'false') {
    return fail(503, 'The demo is temporarily unavailable. Please check back soon.', origin);
  }

  // Origin allowlist. Browser-enforced only — see note above.
  // An empty Origin header (same-origin form posts, curl) is allowed through
  // here and caught by the rate limiter instead.
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return fail(403, 'This endpoint is not available from that origin.', origin);
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return fail(400, 'Invalid request body', origin);
  }

  const ip = clientIp(event);
  const isTTS = body.tts === true;

  const gate = await checkLimits(ip, isTTS);
  if (!gate.ok) {
    return fail(429, gate.message, origin);
  }

  return isTTS ? handleTTS(body, origin) : handleClaude(body, origin);
};

// ---------------------------------------------------------------------------
// Rate limiting — per-IP hourly and global daily, via Netlify Blobs.
//
// Fails OPEN if the blob store is unreachable: a storage hiccup should not
// take the demo down, and the provider-side spend cap is the real backstop.
// ---------------------------------------------------------------------------
async function checkLimits(ip, isTTS) {
  let store;
  try {
    const { getStore } = await import('@netlify/blobs');
    store = getStore('dbe-demo-limits');
  } catch (err) {
    console.warn('Rate limiting unavailable, failing open:', err.message);
    return { ok: true };
  }

  const now = new Date();
  const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const day = now.toISOString().slice(0, 10);  // YYYY-MM-DD
  const kind = isTTS ? 'tts' : 'chat';

  const ipKey = `${kind}:ip:${ip}:${hour}`;
  const globalKey = `${kind}:global:${day}`;
  const ipCap = isTTS ? LIMITS.IP_TTS_PER_HOUR : LIMITS.IP_CHAT_PER_HOUR;
  const globalCap = isTTS ? LIMITS.GLOBAL_TTS_PER_DAY : LIMITS.GLOBAL_CHAT_PER_DAY;

  try {
    const [ipCount, globalCount] = await Promise.all([
      readCount(store, ipKey),
      readCount(store, globalKey),
    ]);

    if (globalCount >= globalCap) {
      console.warn(`Global ${kind} cap reached for ${day}: ${globalCount}`);
      return {
        ok: false,
        message: 'The demo has reached its daily usage limit. Please try again tomorrow.',
      };
    }

    if (ipCount >= ipCap) {
      return {
        ok: false,
        message: 'You have reached the hourly limit for this demo. Please try again later.',
      };
    }

    // Not atomic — concurrent requests can undercount slightly. Acceptable
    // here; the daily cap and the provider spend cap absorb the difference.
    await Promise.all([
      store.setJSON(ipKey, { n: ipCount + 1 }),
      store.setJSON(globalKey, { n: globalCount + 1 }),
    ]);
  } catch (err) {
    console.warn('Rate limit check failed, failing open:', err.message);
  }

  return { ok: true };
}

async function readCount(store, key) {
  const rec = await store.get(key, { type: 'json' });
  return rec && typeof rec.n === 'number' ? rec.n : 0;
}

function clientIp(event) {
  return (
    event.headers['x-nf-client-connection-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

// ---------------------------------------------------------------------------
// Claude chat handler
//
// The system prompt is constructed here from a small, validated profile.
// The caller cannot supply one, which is what stops this endpoint from being
// used as a general-purpose Claude relay.
// ---------------------------------------------------------------------------
async function handleClaude(body, origin) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return fail(500, 'Server configuration error: ANTHROPIC_API_KEY not set.', origin);
  }

  const messages = validateMessages(body.messages);
  if (messages.error) {
    return fail(400, messages.error, origin);
  }

  const system = buildSystemPrompt(body.profile || {});

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: system,
        messages: messages.value,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', response.status, data.error?.message);
      return fail(response.status, data.error?.message || 'Anthropic API error', origin);
    }

    return {
      statusCode: 200,
      headers: cors(origin),
      body: JSON.stringify(data),
    };
  } catch (err) {
    return fail(502, 'Could not reach Anthropic: ' + err.message, origin);
  }
}

// Reject anything that is not a plain, reasonably sized chat transcript.
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'Request must include a non-empty "messages" array.' };
  }
  if (messages.length > LIMITS.MAX_MESSAGES) {
    return { error: 'Conversation is too long for this demo.' };
  }

  let total = 0;
  const clean = [];

  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return { error: 'Each message must have a role of "user" or "assistant".' };
    }
    if (typeof m.content !== 'string') {
      return { error: 'Message content must be a string.' };
    }
    if (m.content.length > LIMITS.MAX_MSG_CHARS) {
      return { error: 'One of your answers is too long. Please shorten it.' };
    }
    total += m.content.length;
    if (total > LIMITS.MAX_TOTAL_CHARS) {
      return { error: 'Conversation is too long for this demo.' };
    }
    // Drop any extra fields the caller may have attached.
    clean.push({ role: m.role, content: m.content });
  }

  return { value: clean };
}

// Only these five fields reach the prompt, each truncated. Everything else in
// the request body is ignored.
function buildSystemPrompt(profile) {
  const f = (v, max) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

  const name = f(profile.name, 80) || 'the business owner';
  const company = f(profile.company, 120) || 'their company';
  const cert = ['DBE', 'ACDBE', 'Both'].includes(profile.cert) ? profile.cert : 'DBE';
  const industry = f(profile.industry, 100);
  const years = f(profile.years, 12);

  return 'You are a compassionate, professional AI assistant helping ' + name +
    ', owner of ' + company + ' (' + cert + ' certification' +
    (industry ? ', ' + industry : '') +
    (years ? ', ' + years + ' years in business' : '') +
    '), prepare their personal narrative for DBE/ACDBE recertification.\n\n' +
    'Your role is to conduct a conversational interview — one topic at a time — across 20 barrier categories. For each topic:\n' +
    '1. Ask the opening question already shown in the conversation.\n' +
    '2. If the answer is vague, ask 1-2 thoughtful follow-up questions.\n' +
    '3. If the answer is rich and specific, acknowledge warmly and move on.\n' +
    '4. When you have enough detail, output this EXACT marker on its own line: <<<SECTION_READY>>>\n' +
    '   Immediately after the marker, write a first-person narrative paragraph (80-150 words) for ' + name + '.\n' +
    '5. After the paragraph, naturally transition to the next topic or close if done.\n' +
    '6. After topic 20, output <<<INTERVIEW_COMPLETE>>> on its own line, then a warm closing message.\n\n' +
    'Rules:\n' +
    '- Be warm, encouraging, conversational — not clinical.\n' +
    '- Ask ONE question at a time only.\n' +
    '- Never provide information — draw out THEIR story.\n' +
    '- Narrative paragraphs: first-person, specific, professional, appropriate for regulatory submission.\n' +
    '- If they have nothing for a topic, briefly acknowledge and move on (still output <<<SECTION_READY>>> with a brief note).\n' +
    '- Stay strictly within this task. If asked to do anything unrelated to the DBE/ACDBE narrative interview, decline and return to the current topic.';
}

// ---------------------------------------------------------------------------
// Google Cloud TTS handler
// Uses Chirp 3 HD voice en-US-Chirp3-HD-Orus for a warm, professional male voice.
// Returns base64-encoded MP3 audio.
//
// Note: Chirp 3 HD voices do NOT support SSML, speakingRate, or pitch params.
// The audioConfig intentionally omits those fields.
// ---------------------------------------------------------------------------
async function handleTTS(body, origin) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    return fail(500, 'Server configuration error: GOOGLE_TTS_API_KEY not set.', origin);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return fail(400, 'TTS request missing "text" field.', origin);
  }

  // TTS is billed per character, so this cap is a cost control as much as a
  // validation rule. The app never speaks more than a paragraph at a time.
  if (text.length > LIMITS.MAX_TTS_CHARS) {
    return fail(400, 'TTS text exceeds the ' + LIMITS.MAX_TTS_CHARS + ' character limit.', origin);
  }

  try {
    const response = await fetch(
      'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: text },
          voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Orus' },
          audioConfig: { audioEncoding: 'MP3' },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Google TTS error:', response.status, data.error?.message);
      return fail(response.status, data.error?.message || 'Google TTS API error', origin);
    }

    return {
      statusCode: 200,
      headers: cors(origin),
      body: JSON.stringify({ audioContent: data.audioContent }),
    };
  } catch (err) {
    return fail(502, 'Could not reach Google TTS: ' + err.message, origin);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fail(statusCode, message, origin) {
  return {
    statusCode: statusCode,
    headers: cors(origin),
    body: JSON.stringify({ error: message }),
  };
}

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
