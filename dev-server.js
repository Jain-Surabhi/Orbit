// Tiny local dev server (no dependencies): serves /public and runs api/chat.js.
//   GROQ_API_KEY=... node dev-server.js          -> real Groq calls
//   node dev-server.js --mock                    -> fake Groq upstream, for UI testing only
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

if (process.argv.includes('--mock')) {
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'mock-key';
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes('api.groq.com')) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    const last = body.messages[body.messages.length - 1].content;
    if (/slow/i.test(last)) await new Promise((r) => setTimeout(r, 4000));
    if (/fail/i.test(last)) return new Response('{"error":{"message":"boom"}}', { status: 500 });
    const text = /code/i.test(last)
      ? 'Here is a snippet:\n\n```js\nconsole.log("hi");\n```\n\nUse `console.log` to print.'
      : `**Mock reply** (context: ${body.messages.length - 1} messages, model ${body.model}).\n\n- You said: ${last.slice(0, 80)}\n- Second point\n\nA closing sentence.`;
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  console.log('[mock] Groq upstream is faked. No real API calls.');
}

const handler = require('./api/chat.js');

function wrap(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  return res;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/chat') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = raw; }
      handler(req, wrap(res));
    });
    return;
  }
  let p = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => console.log(`Orbit on http://localhost:${PORT}`));
