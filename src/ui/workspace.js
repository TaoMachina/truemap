(() => {
  const TOKEN = window.TRUEMAP_TOKEN;
  const CONTENT = window.TRUEMAP_CONTENT;

  const S = {
    listening: 'Agent is listening', working: 'Agent is working', offline: 'Agent not connected',
    placeholder: 'Ask about this project, or select something on the page', placeholderCtx: 'Ask about the selection',
    intro: 'Select a box or some text on the page, then ask about it. The agent receives the code it points to.',
    drawPrompt: 'Read this project and draw its blueprint as .truemap/index.html, then open it for me.',
    quick: [
      ['Explain', 'Explain how this works.'],
      ['What uses it', 'What depends on this, and what does it depend on?'],
      ['Why like this', 'Why is it built this way? What are the trade-offs?'],
      ['Change it…', null],
    ],
    changePrefix: 'Change it so that ',
    ok: 'Matches the code', changed: (n) => `${n} changed in code`, broken: (n) => `${n} out of date`,
    fixPrompt: (p, c, b) => `Check ${p} against the code and update it: ${[b && `${b} anchor(s) no longer match`, c && `${c} anchor(s) whose code changed after the page was written`].filter(Boolean).join(', ')}.`,
    queued: 'Waiting for the agent', answered: 'Chose', fromPage: 'sent by the page', blueprint: 'Blueprint',
    offlineHint: 'Messages wait here until the agent runs <code>truemap listen</code>.',
  };

  const $ = (id) => document.getElementById(id);
  const app = $('app'); const frame = $('frame'); const msgsEl = $('msgs'); const input = $('input'); const menu = $('menu');
  const state = { pages: [], check: { results: [] }, page: null, chips: [], agent: 'offline', pending: new Set(), scroll: {}, history: [], frameFocusAt: 0 };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const api = (path, body) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Truemap-Token': TOKEN }, body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({}));
  const toFrame = (msg) => { if (state.page && !frame.hidden) frame.contentWindow?.postMessage({ __truemap: true, ...msg }, CONTENT); };

  // ---------- text helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeOf = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
        if (/^[\w./-]+\.html?(#[\w-]*)?$/i.test(href)) return `<a href="#" data-page="${href}">${t}</a>`;
        if (/^https:\/\/[^\s"'<>]+$/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`;
        return t;
      });
  }
  function md(text) {
    const lines = esc(text).split('\n');
    let html = ''; let list = null; let code = null; let para = [];
    const flush = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = []; } };
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of lines) {
      if (code !== null) { if (/^```/.test(line)) { html += `<pre><code>${code}</code></pre>`; code = null; } else code += line + '\n'; continue; }
      if (/^```/.test(line)) { flush(); close(); code = ''; continue; }
      let m;
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flush(); if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flush(); if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = line.match(/^#{1,4}\s+(.*)/))) { flush(); close(); html += `<h4>${inline(m[1])}</h4>`; continue; }
      if (!line.trim()) { flush(); close(); continue; }
      close(); para.push(line);
    }
    if (code !== null) html += `<pre><code>${code}</code></pre>`;
    flush(); close();
    return html;
  }

  // ---------- chat panel open/closed ----------
  const narrow = () => window.matchMedia('(max-width: 860px)').matches;
  function setChat(open, remember = true) {
    app.classList.toggle('chat-closed', !open);
    $('toggleChat').hidden = open;
    if (open) $('unread').hidden = true;
    if (remember && !narrow()) store.set('truemap.chat', open ? 'open' : 'closed');
  }
  setChat(narrow() ? false : store.get('truemap.chat') !== 'closed', false);
  $('toggleChat').onclick = () => { setChat(true); input.focus(); };
  $('closeChat').onclick = () => setChat(false);
  const chatOpen = () => !app.classList.contains('chat-closed');

  // ---------- page switcher ----------
  const resultFor = (page) => state.check.results?.find((r) => r.page === page);
  const stateOf = (r) => (r?.counts?.broken ? 'broken' : r?.counts?.changed ? 'changed' : '');
  const titleOf = (p) => (p.page === 'index.html' && (!p.title || p.title === 'index') ? S.blueprint : p.title);

  function renderMenu() {
    const list = $('pages'); list.innerHTML = '';
    const q = $('filter').value.trim().toLowerCase();
    $('filter').hidden = state.pages.length <= 7;
    state.pages
      .filter((p) => !q || `${p.title} ${p.page}`.toLowerCase().includes(q))
      .forEach((p, i, arr) => {
        const st = stateOf(resultFor(p.page));
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'page-item' + (p.page === state.page ? ' active' : ''); b.setAttribute('role', 'menuitem');
        b.innerHTML = `<span class="pi-text"><span class="pi-title">${esc(titleOf(p))}</span><span class="pi-file">${esc(p.page)}</span></span>${st ? `<span class="state-dot ${st}"></span>` : ''}`;
        b.onclick = () => { closeMenu(); go(p.page); };
        list.appendChild(b);
        if (i === 0 && p.page === 'index.html' && arr.length > 1) list.insertAdjacentHTML('beforeend', '<div class="menu-gap"></div>');
      });
  }
  function openMenu() { renderMenu(); menu.hidden = false; $('pageBtn').setAttribute('aria-expanded', 'true'); ($('filter').hidden ? menu.querySelector('.page-item.active, .page-item') : $('filter'))?.focus(); }
  function closeMenu() { menu.hidden = true; $('pageBtn').setAttribute('aria-expanded', 'false'); }
  $('pageBtn').onclick = () => (menu.hidden ? openMenu() : closeMenu());
  $('filter').addEventListener('input', renderMenu);
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.switcher')) closeMenu(); });
  window.addEventListener('blur', () => { if (!menu.hidden) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); menu.hidden ? openMenu() : closeMenu(); }
    else if (e.key === 'Escape' && !menu.hidden) { closeMenu(); $('pageBtn').focus(); }
    else if (!menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...menu.querySelectorAll('.page-item')]; if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  $('recheck').onclick = () => { api('/api/check'); closeMenu(); };

  function renderHeader() {
    const p = state.pages.find((x) => x.page === state.page);
    $('pageTitle').textContent = p ? titleOf(p) : 'truemap';
    $('pagePath').textContent = state.page ? `.truemap/${state.page}` : '';
    document.title = p ? `${titleOf(p)} – truemap` : 'truemap';
    const r = resultFor(state.page); const st = stateOf(r);
    const dot = $('titleDot'); dot.hidden = !st; dot.className = `state-dot ${st}`;
    const chip = $('checkChip');
    if (!r || r.missing || !r.anchors?.length) { chip.hidden = true; return; }
    chip.hidden = false;
    const { changed, broken } = r.counts;
    chip.dataset.state = st || 'ok';
    chip.textContent = broken ? S.broken(broken) + (changed ? `, ${S.changed(changed)}` : '') : changed ? S.changed(changed) : S.ok;
    chip.title = st ? 'Ask the agent to update this page' : '';
  }
  function sendMarks() {
    const r = resultFor(state.page);
    toFrame({ type: 'marks', items: (r?.anchors || []).filter((a) => a.state !== 'ok').map((a) => ({ src: a.src, state: a.state })) });
  }

  const pageUrl = (page, bust) => `${CONTENT}/pages/${page.split('/').map(encodeURIComponent).join('/')}${bust ? `?r=${Date.now()}` : ''}`;
  function go(page, { force = false } = {}) {
    if (!page) return showEmpty();
    $('empty').hidden = true; frame.hidden = false;
    if (state.page !== page || force) frame.src = pageUrl(page);
    setCurrent(page);
  }
  function setCurrent(page) {
    if (state.page !== page) { state.chips = []; renderChips(); }
    state.page = page;
    history.replaceState(null, '', `${location.pathname}${location.search}#page=${encodeURIComponent(page)}`);
    api('/api/viewing', { page });
    renderHeader();
  }
  function showEmpty() {
    state.page = null; frame.hidden = true; frame.removeAttribute('src'); $('empty').hidden = false; renderHeader();
  }
  const reloadFrame = () => { if (state.page) frame.src = pageUrl(state.page, true); };

  // ---------- chat ----------
  function renderAll() {
    msgsEl.innerHTML = `<p class="intro">${esc(S.intro)}</p>`;
    for (const e of state.history) appendEntry(e, false);
    scrollChat();
  }
  function appendEntry(e, scroll = true) {
    const el = document.createElement('div');
    if (e.role === 'agent') {
      el.className = 'msg agent';
      el.innerHTML = `<div class="bubble">${md(e.text)}</div><div class="meta"><span>${timeOf(e.at)}</span></div>`;
      $('progress').hidden = true;
      if (!chatOpen()) $('unread').hidden = false;
    } else {
      const isAnswer = e.kind === 'answer';
      el.className = 'msg user' + (isAnswer ? ' answer' : '');
      el.dataset.id = e.id;
      const ctx = (e.context || []).map((c) => `<span title="${esc(c.src || '')}">${esc(c.label)}</span>`).join('');
      const body = isAnswer
        ? `${esc(S.answered)}: <strong>${esc(e.answer?.choice || '')}</strong>${e.answer?.note ? `<br>${esc(e.answer.note)}` : ''}<span class="answer-q">${esc(e.answer?.question || '')}</span>`
        : esc(e.text);
      const pending = state.pending.has(e.id) ? `<span class="pending">${S.queued}</span>` : '';
      el.innerHTML = `${ctx && !isAnswer ? `<div class="ctx">${ctx}</div>` : ''}<div class="bubble">${body}</div><div class="meta">${pending}${e.from === 'page' ? `<span>${S.fromPage}</span>` : ''}<span>${timeOf(e.at)}</span></div>`;
    }
    msgsEl.appendChild(el);
    if (scroll) scrollChat();
  }
  const scrollChat = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };
  msgsEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-page]');
    if (!a) return;
    e.preventDefault();
    const [page] = a.dataset.page.split('#');
    if (state.pages.some((p) => p.page === page)) go(page);
  });

  function setAgent(s) {
    state.agent = s;
    $('agent').dataset.state = s; $('agentLabel').textContent = S[s] || s;
    $('offlineHint').innerHTML = S.offlineHint; $('offlineHint').hidden = s !== 'offline';
  }

  function renderChips() {
    const box = $('chips'); box.innerHTML = '';
    state.chips.forEach((c, i) => {
      const chip = document.createElement('span'); chip.className = 'chip';
      chip.innerHTML = `<span class="chip-label">${esc(c.label)}</span>${c.src ? `<span class="chip-src">${esc(c.src)}</span>` : ''}<button type="button" aria-label="Remove">×</button>`;
      chip.querySelector('button').onclick = () => {
        state.chips.splice(i, 1); renderChips();
        if (!state.chips.some((x) => x.kind === 'element')) toFrame({ type: 'clear-selection' });
      };
      box.appendChild(chip);
    });
    const quick = $('quick');
    quick.hidden = state.chips.length === 0;
    if (!quick.childElementCount) {
      for (const [label, prompt] of S.quick) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.onclick = () => { if (!prompt) { input.value = S.changePrefix; input.focus(); autosize(); return; } send(prompt); };
        quick.appendChild(b);
      }
    }
    input.placeholder = state.chips.length ? S.placeholderCtx : S.placeholder;
  }

  async function send(text, extra = {}) {
    text = String(text || '').trim();
    const context = extra.context ?? state.chips;
    if (!text && !context.length && !extra.answer) return;
    const r = await api('/api/send', { text, context, page: state.page, ...extra });
    if (r.id && !r.delivered) { state.pending.add(r.id); markPending(r.id, true); }
    if (!extra.keepChips) { state.chips = []; renderChips(); toFrame({ type: 'clear-selection' }); }
  }
  function markPending(id, on) {
    const el = msgsEl.querySelector(`.msg[data-id="${CSS.escape(id)}"] .meta`);
    if (!el) return;
    el.querySelector('.pending')?.remove();
    if (on) el.insertAdjacentHTML('afterbegin', `<span class="pending">${S.queued}</span>`);
  }

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() && !state.chips.length) return;
    input.value = ''; autosize();
    send(text);
  });
  input.placeholder = S.placeholder;

  $('drawBlueprint').onclick = () => { setChat(true); send(S.drawPrompt, { context: [] }); };
  $('checkChip').onclick = () => {
    const r = resultFor(state.page);
    if (!r || (!r.counts.changed && !r.counts.broken)) return;
    setChat(true);
    send(S.fixPrompt(`.truemap/${state.page}`, r.counts.changed, r.counts.broken), { context: [] });
  };

  // A decision only counts as the user's if the user actually moved focus into the page.
  window.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement === frame) state.frameFocusAt = Date.now(); }, 0); });
  const userIsInFrame = () => document.activeElement === frame && state.frameFocusAt > 0;

  // ---------- messages from the page iframe ----------
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== CONTENT || !e.data || !e.data.__truemap) return;
    const d = e.data;
    if (d.type === 'loaded') {
      if (d.page && d.page !== state.page) setCurrent(d.page);
      renderHeader(); sendMarks();
      const y = state.scroll[d.page]; if (y) toFrame({ type: 'scroll', y });
    } else if (d.type === 'scroll') {
      state.scroll[d.page] = d.y;
    } else if (d.type === 'select') {
      state.chips = [...state.chips.filter((c) => c.kind === 'text'), ...(d.items || [])].slice(0, 8);
      renderChips();
      if (d.items?.length) { setChat(true, false); input.focus({ preventScroll: true }); }
    } else if (d.type === 'select-text') {
      state.chips = [...state.chips.filter((c) => c.kind !== 'text'), d.item];
      renderChips();
    } else if (d.type === 'answer') {
      const fromUser = d.trusted === true && userIsInFrame();
      send('', {
        kind: 'answer', from: fromUser ? 'user' : 'page', keepChips: true,
        context: d.src ? [{ kind: 'element', label: d.question, src: d.src }] : [],
        answer: { question: d.question, choice: d.choice, note: d.note },
      });
    } else if (d.type === 'page-send') {
      if (d.text) send(d.text, { from: 'page', context: [], keepChips: true });
    }
  });

  // ---------- live events from the server ----------
  function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
    let greeted = false;
    const guard = setTimeout(() => { if (!greeted) { es.close(); connect(); } }, 3000);
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'hello') {
        greeted = true; clearTimeout(guard);
        state.pages = d.pages || []; state.check = d.check || { results: [] }; state.history = d.history || [];
        state.pending = new Set(d.pending || []);
        $('ver').textContent = `truemap ${d.version}`;
        $('project').textContent = String(d.root || '').split(/[\\/]/).filter(Boolean).pop() || '';
        setAgent(d.agent);
        renderAll();
        const fromHash = decodeURIComponent((location.hash.match(/page=([^&]+)/) || [])[1] || '');
        const target = [state.page, fromHash, d.current].find((p) => p && state.pages.some((x) => x.page === p)) || state.pages[0]?.page;
        target ? go(target, { force: !frame.getAttribute('src') }) : showEmpty();
      } else if (d.type === 'chat') {
        state.history.push(d.entry); appendEntry(d.entry);
      } else if (d.type === 'agent') {
        setAgent(d.state);
        if (d.state !== 'working') $('progress').hidden = true;
      } else if (d.type === 'delivered') {
        for (const id of d.ids || []) { state.pending.delete(id); markPending(id, false); }
      } else if (d.type === 'progress') {
        const p = $('progress'); p.textContent = d.text; p.hidden = !d.text;
      } else if (d.type === 'pages') {
        state.pages = d.pages || []; renderHeader(); if (!menu.hidden) renderMenu();
        if (!state.page && state.pages[0]) go(state.pages[0].page);
        else if (state.page && !state.pages.some((p) => p.page === state.page)) state.pages[0] ? go(state.pages[0].page) : showEmpty();
      } else if (d.type === 'changed') {
        const files = d.files || [];
        if (state.page && files.some((f) => !f || f === state.page || f.startsWith('assets/'))) reloadFrame();
      } else if (d.type === 'check') {
        state.check = d.check || { results: [] }; renderHeader(); sendMarks(); if (!menu.hidden) renderMenu();
      } else if (d.type === 'navigate') {
        if (d.pages) state.pages = d.pages;
        if (d.page && state.pages.some((p) => p.page === d.page)) go(d.page, { force: true });
        renderHeader();
      }
    };
  }
  connect();
})();
