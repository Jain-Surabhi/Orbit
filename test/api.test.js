// Run: node test/api.test.js   (stubs fetch; makes no network calls)
const assert = require('assert');
const handler = require('../api/chat.js');

function call(body, { method = 'POST', env = {} } = {}) {
  const saved = { k: process.env.GROQ_API_KEY, m: process.env.GROQ_MODEL };
  process.env.GROQ_API_KEY = 'k' in env ? env.k : 'test-key-123';
  if (env.model) process.env.GROQ_MODEL = env.model; else delete process.env.GROQ_MODEL;
  if (env.k === null) delete process.env.GROQ_API_KEY;
  return new Promise((resolve) => {
    const res = {
      headers: {}, statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; return this; },
      json(o) { restore(); resolve({ status: this.statusCode, body: o }); },
    };
    function restore() {
      if (saved.k === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved.k;
      if (saved.m === undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL = saved.m;
    }
    handler({ method, body }, res);
  });
}

const ok = (content = 'hi there') => async (url, opts) => {
  ok.last = { url, opts, payload: JSON.parse(opts.body) };
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
};
const u = (c) => ({ role: 'user', content: c });
const a = (c) => ({ role: 'assistant', content: c });

(async () => {
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

  await t('rejects non-POST', async () => assert.equal((await call({}, { method: 'GET' })).status, 405));
  await t('500 when key missing, no leak', async () => {
    const r = await call({ messages: [u('x')] }, { env: { k: null } });
    assert.equal(r.status, 500);
  });
  await t('400 on bad body / empty / bad role / too long / last not user', async () => {
    assert.equal((await call(undefined)).status, 400);
    assert.equal((await call({ messages: [] })).status, 400);
    assert.equal((await call({ messages: [{ role: 'system', content: 'x' }] })).status, 400);
    assert.equal((await call({ messages: [u('x'.repeat(2001))] })).status, 400);
    assert.equal((await call({ messages: [u('a'), a('b')] })).status, 400);
  });
  await t('success returns reply; key only in Authorization header to Groq', async () => {
    global.fetch = ok('hello!');
    const r = await call({ messages: [u('hi')] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { reply: 'hello!' });
    assert.equal(ok.last.opts.headers.Authorization, 'Bearer test-key-123');
    assert.ok(!JSON.stringify(r.body).includes('test-key-123'));
    assert.equal(ok.last.payload.messages[0].role, 'system');
  });
  await t('model defaults and is configurable via GROQ_MODEL', async () => {
    global.fetch = ok();
    await call({ messages: [u('hi')] });
    assert.equal(ok.last.payload.model, 'llama-3.3-70b-versatile');
    await call({ messages: [u('hi')] }, { env: { model: 'custom-model' } });
    assert.equal(ok.last.payload.model, 'custom-model');
  });
  await t('history bounded to 12 messages (+1 system)', async () => {
    global.fetch = ok();
    const msgs = [];
    for (let i = 0; i < 30; i++) msgs.push(i % 2 ? a('a' + i) : u('u' + i));
    msgs.push(u('last'));
    await call({ messages: msgs });
    const sent = ok.last.payload.messages;
    assert.ok(sent.length <= 13, 'sent ' + sent.length);
    assert.equal(sent[sent.length - 1].content, 'last');
    assert.equal(sent[1].role, 'user');
  });
  await t('total character budget enforced', async () => {
    global.fetch = ok();
    const big = 'z'.repeat(1900);
    await call({ messages: [u(big), a(big), u(big), a(big), u(big), a(big), u(big), a(big), u('end')] });
    const total = ok.last.payload.messages.slice(1).reduce((s, m) => s + m.content.length, 0);
    assert.ok(total <= 12000, 'total ' + total);
  });
  await t('maps upstream errors (429, 401, 500) and empty reply', async () => {
    for (const [up, want] of [[429, 429], [401, 502], [500, 502]]) {
      global.fetch = async () => new Response('{"error":"x"}', { status: up });
      assert.equal((await call({ messages: [u('hi')] })).status, want);
    }
    global.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
    assert.equal((await call({ messages: [u('hi')] })).status, 502);
  });
  await t('network failure -> 502; abort -> 504', async () => {
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    assert.equal((await call({ messages: [u('hi')] })).status, 502);
    global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    assert.equal((await call({ messages: [u('hi')] })).status, 504);
  });
  await t('timeout actually aborts a hanging upstream', async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...r) => realSetTimeout(fn, ms === 25000 ? 50 : ms, ...r);
    global.fetch = (url, opts) => new Promise((_, rej) => {
      opts.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; rej(e); });
    });
    const r = await call({ messages: [u('hi')] });
    global.setTimeout = realSetTimeout;
    assert.equal(r.status, 504);
  });
  console.log(`\n${n} test groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
