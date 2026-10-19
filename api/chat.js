// Vercel serverless function: POST /api/chat
// Forwards a bounded conversation to Groq. GROQ_API_KEY never leaves the server.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

const MAX_MESSAGES = 12; // recent turns kept as context
const MAX_MESSAGE_CHARS = 2000; // per message
const MAX_TOTAL_CHARS = 12000; // across all kept messages
const MAX_OUTPUT_TOKENS = 1024;
const TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = [
  'You are Orbit, a friendly general-purpose AI assistant.',
  'Help with questions on any topic, explain concepts, write and edit content, brainstorm, and answer follow-ups using the conversation so far.',
  'Be clear and concise. Use short paragraphs, and lists or code blocks only when they help.',
  'If you are unsure or do not know something, say so instead of guessing.',
].join(' ');

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string' || Buffer.isBuffer(b)) {
    try {
      return JSON.parse(b.toString());
    } catch {
      return null;
    }
  }
  return null;
}

// Validate, trim and bound the incoming history. Returns { messages } or { error }.
function sanitize(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'Send a non-empty "messages" array.' };
  }
  const clean = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { error: 'Each message needs a role of "user" or "assistant" and string content.' };
    }
    const content = m.content.trim();
    if (!content) continue;
    if (content.length > MAX_MESSAGE_CHARS) {
      return { error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` };
    }
    clean.push({ role: m.role, content });
  }
  // Keep the newest messages that fit the total budget.
  let total = 0;
  const kept = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    total += clean[i].content.length;
    if (total > MAX_TOTAL_CHARS) break;
    kept.unshift(clean[i]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  if (!kept.length || kept[kept.length - 1].role !== 'user') {
    return { error: 'The last message must come from the user.' };
  }
  return { messages: kept };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed.' });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return send(res, 500, { error: 'Orbit is not configured yet (missing GROQ_API_KEY on the server).' });
  }

  const body = parseBody(req);
  if (!body) return send(res, 400, { error: 'Request body must be valid JSON.' });

  const { messages, error } = sanitize(body.messages);
  if (error) return send(res, 400, { error });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
      }),
    });

    if (!upstream.ok) {
      console.error('Groq error', upstream.status, (await upstream.text()).slice(0, 500));
      if (upstream.status === 429) {
        return send(res, 429, { error: 'Orbit is getting a lot of requests. Please try again in a moment.' });
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return send(res, 502, { error: 'The server could not authenticate with Groq. Check GROQ_API_KEY.' });
      }
      if (upstream.status === 400 || upstream.status === 404) {
        return send(res, 502, { error: 'Groq rejected the request. Check that GROQ_MODEL is a valid model name.' });
      }
      return send(res, 502, { error: 'Groq had a problem answering. Please try again.' });
    }

    const data = await upstream.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : '';
    if (!reply) return send(res, 502, { error: 'Groq returned an empty reply. Please try again.' });

    return send(res, 200, { reply });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return send(res, 504, { error: 'Groq took too long to respond. Please try again.' });
    }
    console.error('chat handler error', err && err.message);
    return send(res, 502, { error: 'Could not reach Groq. Please try again.' });
  } finally {
    clearTimeout(timer);
  }
};
