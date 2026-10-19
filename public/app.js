(function () {
  'use strict';

  var MAX_CHARS = 2000;
  var MAX_HISTORY = 12;
  var CLIENT_TIMEOUT_MS = 35000;

  var log = document.getElementById('log');
  var welcome = document.getElementById('welcome');
  var form = document.getElementById('composer');
  var input = document.getElementById('composer-input');
  var sendBtn = document.getElementById('send');
  var count = document.getElementById('count');
  var newChat = document.getElementById('new-chat');
  var themeBtn = document.getElementById('theme-toggle');

  var history = []; // {role, content}
  var busy = false;
  var controller = null;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Theme ---------- */
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function currentTheme() {
    var t = document.documentElement.dataset.theme;
    return t || (darkQuery.matches ? 'dark' : 'light');
  }
  function syncThemeButton() {
    var dark = currentTheme() === 'dark';
    themeBtn.setAttribute('aria-pressed', String(dark));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  themeBtn.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('orbit-theme', next); } catch (e) {}
    syncThemeButton();
  });
  syncThemeButton();

  /* ---------- Safe, minimal markdown rendering (DOM only, no innerHTML) ---------- */
  function inline(parent, text) {
    var re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0], el;
      if (tok[0] === '`') {
        el = document.createElement('code');
        el.textContent = tok.slice(1, -1);
      } else {
        el = document.createElement('strong');
        el.textContent = tok.slice(2, -2);
      }
      parent.appendChild(el);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function render(container, text) {
    var lines = text.replace(/\r\n/g, '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        var pre = document.createElement('pre');
        var c = document.createElement('code');
        c.textContent = code.join('\n');
        pre.appendChild(c);
        pre.tabIndex = 0;
        container.appendChild(pre);
      } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        var list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          var li = document.createElement('li');
          inline(li, lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
          list.appendChild(li);
          i++;
        }
        container.appendChild(list);
      } else if (!line.trim()) {
        i++;
      } else {
        var para = [];
        while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          para.push(lines[i++].replace(/^#{1,6}\s+/, ''));
        }
        var p = document.createElement('p');
        para.forEach(function (l, idx) {
          if (idx) p.appendChild(document.createElement('br'));
          inline(p, l);
        });
        container.appendChild(p);
      }
    }
  }

  /* ---------- Message UI ---------- */
  function scrollDown() {
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }

  function addMessage(kind, text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (kind === 'user' ? 'user' : 'bot') + (kind === 'error' ? ' error' : '');
    var who = document.createElement('p');
    who.className = 'who label';
    who.textContent = kind === 'user' ? 'you' : 'orbit';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (kind === 'bot') render(bubble, text);
    else bubble.textContent = text;
    wrap.appendChild(who);
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function addTyping() {
    var wrap = document.createElement('div');
    wrap.className = 'msg bot';
    wrap.setAttribute('data-typing', '');
    var who = document.createElement('p');
    who.className = 'who label';
    who.textContent = 'orbit';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var dots = document.createElement('span');
    dots.className = 'typing';
    dots.innerHTML = '<i></i><i></i><i></i>';
    dots.setAttribute('aria-hidden', 'true');
    var sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = 'Orbit is thinking…';
    bubble.appendChild(dots);
    bubble.appendChild(sr);
    wrap.appendChild(who);
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function setBusy(v) {
    busy = v;
    log.setAttribute('aria-busy', String(v));
    updateSend();
  }

  function updateSend() {
    sendBtn.disabled = busy || !input.value.trim();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function updateCount() {
    var n = input.value.length;
    if (n > MAX_CHARS * 0.8) {
      count.textContent = n + ' / ' + MAX_CHARS;
      count.className = n >= MAX_CHARS ? 'warn' : '';
    } else {
      count.textContent = '';
    }
  }

  /* ---------- Networking ---------- */
  function friendly(status, serverMsg) {
    if (serverMsg) return serverMsg;
    if (status === 404) return 'The chat endpoint was not found. Is the /api/chat function deployed?';
    return 'Something went wrong (status ' + status + '). Please try again.';
  }

  function request() {
    welcome.hidden = true;
    var typing = addTyping();
    setBusy(true);

    controller = new AbortController();
    var mine = controller;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; mine.abort(); }, CLIENT_TIMEOUT_MS);

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: mine.signal,
      body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(friendly(res.status, data && data.error));
          if (!data.reply) throw new Error('Orbit sent back an empty reply. Please try again.');
          return data.reply;
        });
      })
      .then(function (reply) {
        if (mine !== controller) return;
        typing.remove();
        history.push({ role: 'assistant', content: reply });
        addMessage('bot', reply);
      })
      .catch(function (err) {
        if (mine !== controller) return; // chat was reset
        typing.remove();
        var msg;
        if (err.name === 'AbortError') msg = timedOut ? 'That took too long. Please try again.' : 'Request cancelled.';
        else if (err instanceof TypeError) msg = 'Could not reach the server. Check your connection and try again.';
        else msg = err.message;
        showError(msg);
      })
      .then(function () {
        clearTimeout(timer);
        if (mine === controller) {
          setBusy(false);
          if (!log.querySelector('.msg.error')) input.focus({ preventScroll: true });
        }
      });
  }

  function showError(msg) {
    var el = addMessage('error', msg);
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = 'Try again';
    retry.addEventListener('click', function () {
      if (busy) return;
      el.remove();
      request();
    });
    el.appendChild(retry);
    retry.focus({ preventScroll: true });
  }

  function dropErrors() {
    log.querySelectorAll('.msg.error').forEach(function (n) { n.remove(); });
  }

  function submit(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    dropErrors();
    history.push({ role: 'user', content: text });
    addMessage('user', text);
    input.value = '';
    autosize();
    updateCount();
    request();
  }

  /* ---------- Events ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit(input.value);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : submit(input.value);
    }
  });

  input.addEventListener('input', function () {
    autosize();
    updateCount();
    updateSend();
  });

  document.getElementById('chips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) submit(chip.textContent);
  });

  newChat.addEventListener('click', function () {
    if (controller) controller.abort();
    controller = null;
    history = [];
    log.querySelectorAll('.msg').forEach(function (n) { n.remove(); });
    welcome.hidden = false;
    log.scrollTop = 0;
    input.value = '';
    autosize();
    updateCount();
    setBusy(false);
    input.focus();
  });

  updateSend();
})();
