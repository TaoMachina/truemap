(() => {
  const TOKEN = window.TRUEMAP_TOKEN;
  const CONTENT = window.TRUEMAP_CONTENT;

  const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex' };
  const S = {
    placeholder: 'Ask about this page', placeholderNotes: 'Add a message (optional)',
    drawPrompt: 'Read this project and draw its blueprint as .truemap/index.html, then open it for me.',
    ok: 'Matches the code', changed: (n) => `${n} changed in code`, broken: (n) => `${n} no longer match`,
    fixPrompt: (p, c, b) => `Check ${p} against the code and update it: ${[b && `${b} anchor(s) no longer match`, c && `${c} anchor(s) whose code changed after the page was written`].filter(Boolean).join(', ')}.`,
    chose: 'Chose', fromPage: 'Sent by the page’s own script', waiting: 'Waiting for the agent', you: 'You',
    state: {
      listening: (a) => `${a} is listening`, working: (a) => `${a} is working`, idle: (a) => `${a} stopped listening`, stale: (a) => `No reply from ${a} yet`,
      offline: () => 'No agent listening', closed: () => 'Workspace closed',
    },
  };

  const $ = (id) => document.getElementById(id);
  const app = $('app'); const frame = $('frame'); const msgsEl = $('msgs'); const input = $('input'); const menu = $('menu');
  const state = {
    pages: [], check: { results: [] }, page: null, history: [], pending: new Set(), scroll: {},
    notes: [], agent: { state: 'offline', name: '', since: 0 }, progress: '', cmd: 'npx -y truemap-cli',
    annotate: false, annotateTouched: false, conn: 'live', frameFocusAt: 0,
  };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const api = (path, body) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Truemap-Token': TOKEN }, body: JSON.stringify(body || {}),
  }).then((r) => r.json()).catch(() => ({}));
  const toFrame = (msg) => { if (state.page && !frame.hidden) frame.contentWindow?.postMessage({ __truemap: true, ...msg }, CONTENT); };
  const agentName = () => AGENTS[state.agent.name] || 'The agent';

  // ---------- text helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeOf = (iso) => {
    try {
      const d = new Date(iso); const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
    } catch { return ''; }
  };
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => {
        if (/^[\w./-]+\.html?(#[\w-]*)?$/i.test(href)) return `<a href="#" data-page="${href}">${t}</a>`;
        if (/^#[\w-]+$/.test(href)) return `<a href="#" class="ref" data-focus="${href.slice(1)}">${t}</a>`;
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
  const fmtElapsed = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

  // ---------- conversation panel: one button opens and closes it ----------
  const narrow = () => window.matchMedia('(max-width: 860px)').matches;
  const panelOpen = () => !app.classList.contains('panel-closed');
  function setPanel(open, remember = true) {
    app.classList.toggle('panel-closed', !open);
    const b = $('togglePanel');
    b.setAttribute('aria-pressed', String(open));
    b.title = open ? 'Hide conversation' : 'Show conversation';
    b.setAttribute('aria-label', b.title);
    if (open) state.unread = false;
    renderBadge();
    if (remember && !narrow()) store.set('truemap.panel', open ? 'open' : 'closed');
  }
  // While the panel is closed its button carries what is waiting there: pending comments, or a new answer.
  function renderBadge() {
    const u = $('unread'); const open = panelOpen(); const n = state.notes?.length || 0;
    u.hidden = open || (!n && !state.unread);
    u.textContent = !open && n ? String(n) : '';
    u.classList.toggle('count', !open && n > 0);
  }
  setPanel(narrow() ? false : store.get('truemap.panel') !== 'closed', false);
  $('togglePanel').onclick = () => { const open = !panelOpen(); setPanel(open); if (open) input.focus(); };

  // ---------- annotate ----------
  function setAnnotate(on, { touched = false } = {}) {
    state.annotate = !!on;
    if (touched) { state.annotateTouched = true; store.set('truemap.annotate', on ? 'on' : 'off'); }
    $('annotate').setAttribute('aria-checked', String(state.annotate));
    toFrame({ type: 'annotate', on: state.annotate });
  }
  state.annotate = store.get('truemap.annotate') === 'on';
  $('annotate').setAttribute('aria-checked', String(state.annotate));
  $('annotate').onclick = () => setAnnotate(!state.annotate, { touched: true });

  // ---------- page switcher ----------
  const resultFor = (page) => state.check.results?.find((r) => r.page === page);
  const stateOf = (r) => (r?.counts?.broken ? 'broken' : r?.counts?.changed ? 'changed' : '');
  const titleOf = (p) => (p.page === 'index.html' && (!p.title || p.title === 'index') ? 'Blueprint' : p.title || p.page);

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
        b.innerHTML = `<span class="pi-text"><span class="pi-title">${esc(titleOf(p))}</span><span class="pi-file">${esc(p.page)}</span></span>${st ? `<span class="tri ${st}" title="${st === 'broken' ? 'Out of date' : 'Code changed'}"></span>` : ''}`;
        b.onclick = () => { closeMenu(); go(p.page); };
        list.appendChild(b);
        if (i === 0 && p.page === 'index.html' && arr.length > 1) list.insertAdjacentHTML('beforeend', '<div class="menu-gap"></div>');
      });
    if (!state.pages.length) list.innerHTML = '<div class="menu-head">No pages in .truemap/ yet</div>';
  }
  function openMenu() { renderMenu(); menu.hidden = false; $('pageBtn').setAttribute('aria-expanded', 'true'); ($('filter').hidden ? menu.querySelector('.page-item.active, .page-item') : $('filter'))?.focus(); }
  function closeMenu() { menu.hidden = true; $('pageBtn').setAttribute('aria-expanded', 'false'); }
  $('pageBtn').onclick = () => (menu.hidden ? openMenu() : closeMenu());
  $('filter').addEventListener('input', renderMenu);
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.switcher')) closeMenu(); });
  window.addEventListener('blur', () => { if (!menu.hidden) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input,textarea,select,[contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); menu.hidden ? openMenu() : closeMenu(); }
    else if (e.key === 'Escape' && !menu.hidden) { closeMenu(); $('pageBtn').focus(); }
    else if (e.key === 'Escape' && !typing && state.annotate && $('moreMenu').hidden) setAnnotate(false, { touched: true });
    else if (!menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...menu.querySelectorAll('.page-item')]; if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'a' && menu.hidden) {
      setAnnotate(!state.annotate, { touched: true });
    }
  });
  $('recheck').onclick = () => { api('/api/check'); closeMenu(); };

  // ---------- more menu: the page file, export, end the conversation ----------
  const more = $('moreMenu');
  const filePath = () => {
    if (!state.page) return '';
    const sepChar = String(state.root).includes('\\') ? '\\' : '/';
    return [state.root, '.truemap', ...state.page.split('/')].join(sepChar);
  };
  function renderMore() {
    $('moreFile').textContent = state.page ? `‎.truemap/${state.page}` : 'No page open';
    $('moreFile').title = filePath();
    $('copyPath').disabled = !state.page;
    $('exportPage').disabled = !state.page || state.conn !== 'live';
    const talking = state.conn === 'live' && (state.agent.state === 'listening' || state.agent.state === 'working');
    $('endConv').disabled = !talking;
    $('endHint').textContent = talking ? `Lets ${agentName()} go back to the terminal` : 'No conversation is running';
  }
  const closeMore = () => { more.hidden = true; $('moreBtn').setAttribute('aria-expanded', 'false'); };
  $('moreBtn').onclick = (e) => {
    e.stopPropagation();
    if (!more.hidden) return closeMore();
    closeMenu(); renderMore(); more.hidden = false; $('moreBtn').setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('click', (e) => { if (!more.hidden && !e.target.closest('.more')) closeMore(); });
  window.addEventListener('blur', () => { if (!more.hidden) closeMore(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !more.hidden) { closeMore(); $('moreBtn').focus(); } });
  $('copyPath').onclick = () => {
    navigator.clipboard?.writeText(filePath()).then(() => { $('copyPath').textContent = 'Copied'; setTimeout(() => { $('copyPath').textContent = 'Copy path'; }, 1400); }).catch(() => {});
  };
  $('exportPage').onclick = () => {
    const a = document.createElement('a');
    a.href = `/api/export?page=${encodeURIComponent(state.page)}&t=${encodeURIComponent(TOKEN)}`;
    a.download = ''; document.body.appendChild(a); a.click(); a.remove(); closeMore();
  };
  $('endConv').onclick = () => { api('/api/end'); closeMore(); };

  function renderHeader() {
    const p = state.pages.find((x) => x.page === state.page);
    $('pageTitle').textContent = p ? titleOf(p) : (state.pages.length ? 'Pages' : 'No pages yet');
    // The blueprint is always one click away.
    const home = state.pages.find((x) => x.page === 'index.html');
    const showHome = !!home && !!state.page && state.page !== 'index.html';
    $('crumbHome').hidden = !showHome; $('crumbSep').hidden = !showHome;
    if (showHome) { $('crumbHome').textContent = titleOf(home); $('crumbHome').title = `Back to ${titleOf(home)}`; }
    $('pagePath').textContent = state.page ? `.truemap/${state.page}` : '';
    document.title = p ? `${titleOf(p)} – truemap` : 'truemap';
    const r = resultFor(state.page); const st = stateOf(r);
    const chip = $('checkChip');
    if (!r || r.missing || !r.anchors?.length || state.conn === 'closed') { chip.hidden = true; return; }
    chip.hidden = false;
    const { changed, broken } = r.counts;
    chip.dataset.state = st || 'ok';
    $('checkText').textContent = broken ? S.broken(broken) + (changed ? `, ${S.changed(changed)}` : '') : changed ? S.changed(changed) : S.ok;
    chip.title = st ? 'Ask the agent to update this page' : `${r.counts.ok} boxes checked against the code`;
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
  // Back and forward between pages, like a browser (Alt+Left / Alt+Right, mouse side buttons).
  const nav = { back: [], fwd: [], moving: false };
  function setCurrent(page) {
    if (state.page && page !== state.page && !nav.moving) { nav.back.push(state.page); nav.fwd = []; if (nav.back.length > 50) nav.back.shift(); }
    nav.moving = false;
    state.page = page;
    history.replaceState(null, '', `${location.pathname}${location.search}#page=${encodeURIComponent(page)}`);
    api('/api/viewing', { page });
    renderHeader(); renderNotice(); renderNotes();
  }
  function showEmpty() {
    state.page = null; frame.hidden = true; frame.removeAttribute('src'); $('empty').hidden = false; renderHeader(); renderNotice();
  }
  const reloadFrame = () => { if (state.page) frame.src = pageUrl(state.page, true); };

  // ---------- notes (comments collected in annotate mode) ----------
  const notesForPage = () => state.notes.filter((n) => n.page === state.page);
  function syncFrameNotes() { toFrame({ type: 'notes', items: notesForPage().map(({ id, kind, label, src, text, selector, rect }) => ({ id, kind, label, src, text, selector, rect })) }); }
  // Unsent comments survive a reload of this tab.
  try { state.notes = JSON.parse(sessionStorage.getItem('truemap.notes') || '[]'); } catch { state.notes = []; }
  function saveNotes() { try { sessionStorage.setItem('truemap.notes', JSON.stringify(state.notes)); } catch { /* ignore */ } }
  function renderNotes() {
    saveNotes(); renderBadge();
    const list = $('notes'); list.innerHTML = '';
    list.hidden = state.notes.length === 0;
    state.notes.forEach((n, i) => {
      const li = document.createElement('li'); li.className = 'note';
      li.innerHTML = `<span class="mn-num">${i + 1}</span><span class="mn-what"><b>${esc(n.kind === 'text' ? `“${n.label}”` : n.label)}</b>${n.page !== state.page ? ` on ${esc(n.page)}` : ''}</span><span class="note-text">${esc(n.text)}</span><button class="note-x" type="button" aria-label="Remove comment" title="Remove">×</button>`;
      li.querySelector('.note-x').onclick = (e) => { e.stopPropagation(); state.notes = state.notes.filter((x) => x.id !== n.id); renderNotes(); syncFrameNotes(); };
      li.onclick = () => { if (n.page !== state.page) go(n.page); else toFrame({ type: 'focus-note', id: n.id }); };
      list.appendChild(li);
    });
    const count = state.notes.length;
    $('send').textContent = count ? `Send ${count} comment${count > 1 ? 's' : ''}` : 'Send';
    input.placeholder = count ? S.placeholderNotes : S.placeholder;
  }

  // ---------- conversation ----------
  function whoLine(role, at, name) {
    const el = document.createElement('div'); el.className = 'who';
    el.innerHTML = `<b>${esc(role === 'agent' ? (AGENTS[name] || name || agentName()) : S.you)}</b><span>${timeOf(at)}</span>`;
    return el;
  }
  let lastRole = null;
  function renderAll() {
    msgsEl.innerHTML = ''; lastRole = null;
    if (!state.history.length) {
      msgsEl.innerHTML = `<div class="intro"><h2>Ask about anything on the page</h2><ol>
        <li>Turn on <b>Annotate</b> (or press <kbd>A</kbd>), then click a box or select text to comment on it.</li>
        <li>Add as many comments as you like. They go out together, each with the code it points to.</li>
        <li>Or just type a question below.</li></ol></div>`;
    }
    for (const e of state.history) appendEntry(e, false);
    renderWorking();
    scrollChat();
  }
  function appendEntry(e, scroll = true, live = false) {
    msgsEl.querySelector('.intro')?.remove();
    if (e.role !== lastRole) { msgsEl.appendChild(whoLine(e.role, e.at, e.agent)); lastRole = e.role; }
    const el = document.createElement('div');
    if (e.role === 'agent') {
      el.className = 'msg agent';
      el.innerHTML = e.ask && e.text.trim() === e.ask.question.trim() ? '' : md(e.text);
      if (e.focus?.length) {
        el.insertAdjacentHTML('beforeend', `<p><a href="#" class="ref" data-focus="${esc(e.focus.join(','))}">Show on the map</a></p>`);
        if (live) pointAt(e.focus, '', AGENTS[e.agent] || agentName());
      }
      if (e.ask) el.appendChild(askCard(e));
      if (live && !panelOpen()) { state.unread = true; renderBadge(); }
    } else {
      el.className = 'msg user'; el.dataset.id = e.id;
      let body = '';
      if (e.kind === 'answer') {
        body = `<span class="answer-q">${esc(e.answer?.question || '')}</span>${esc(S.chose)}: <strong>${esc(e.answer?.choice || '')}</strong>${e.answer?.note ? `<br>${esc(e.answer.note)}` : ''}`;
      } else {
        const notes = (e.context || []).filter((c) => c.comment);
        const sel = (e.context || []).filter((c) => !c.comment);
        if (notes.length) {
          body += `<ol class="msg-notes">${notes.map((c, i) => `<li class="mn"><span class="mn-num">${i + 1}</span><span class="mn-what"><b>${esc(c.kind === 'text' ? `“${c.label}”` : c.label)}</b>${c.src ? ` ${esc(c.src)}` : ''}</span><span>${esc(c.comment)}</span></li>`).join('')}</ol>`;
        }
        if (sel.length) body += `<div class="mn-what">${sel.map((c) => `<b>${esc(c.label)}</b>`).join(', ')}</div>`;
        if (e.text) body += `<div class="msg-text">${esc(e.text).replace(/\n/g, '<br>')}</div>`;
      }
      el.innerHTML = body
        + (e.from === 'page' ? `<div class="from-page">${S.fromPage}</div>` : '')
        + (state.pending.has(e.id) ? `<div class="waiting">${S.waiting}</div>` : '');
    }
    msgsEl.appendChild(el);
    renderWorking();
    if (scroll) scrollChat();
  }
  const scrollChat = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };
  msgsEl.addEventListener('click', (e) => {
    const ref = e.target.closest('[data-focus]');
    if (ref) { e.preventDefault(); pointAt(ref.dataset.focus.split(',').filter(Boolean), '', ''); return; }
    const opt = e.target.closest('.ask-opt');
    if (opt && !opt.disabled) { e.preventDefault(); answerAsk(opt); return; }
    const a = e.target.closest('a[data-page]');
    if (!a) return;
    e.preventDefault();
    const [page, id] = a.dataset.page.split('#');
    if (state.pages.some((p) => p.page === page)) { if (id) state.pendingFocus = { items: [id] }; go(page); }
  });

  // ---------- the agent points at the map ----------
  function pointAt(items, note, who, page) {
    const target = page && state.pages.some((p) => p.page === page) ? page : state.page;
    const msg = { type: 'focus', items, note: note || '', who: who || agentName() };
    if (target && target !== state.page) { state.pendingFocus = msg; go(target); } else toFrame(msg);
  }

  // ---------- choices the agent asks for (only when it is blocked on a real trade-off) ----------
  function askCard(e) {
    const answered = state.history.find((h) => h.kind === 'answer' && h.answer?.question === e.ask.question && h.at > e.at);
    const box = document.createElement('div'); box.className = 'ask';
    box.innerHTML = `<div class="ask-q">${esc(e.ask.question)}</div>` + e.ask.options.map((o, i) =>
      `<button type="button" class="ask-opt${answered?.answer?.choice === o.label ? ' chosen' : ''}" data-i="${i}" ${answered ? 'disabled' : ''}><b>${esc(o.label)}</b>${o.why ? `<span>${esc(o.why)}</span>` : ''}</button>`).join('');
    box.dataset.q = e.ask.question;
    return box;
  }
  function answerAsk(btn) {
    const box = btn.closest('.ask');
    for (const b of box.querySelectorAll('.ask-opt')) b.disabled = true;
    btn.classList.add('chosen');
    send('', { kind: 'answer', noNotes: true, context: [], answer: { question: box.dataset.q, choice: btn.querySelector('b').textContent, note: '' } });
  }

  // ---------- peek: what a box is, in the code ----------
  const peekEl = $('peek');
  const closePeek = () => { peekEl.hidden = true; peekEl.innerHTML = ''; };
  const pageHref = (href) => {
    const [file, id] = href.split('#');
    const base = state.page && state.page.includes('/') ? state.page.replace(/[^/]+$/, '') : '';
    const parts = (base + file).split('/'); const outp = [];
    for (const p of parts) { if (p === '..') outp.pop(); else if (p && p !== '.') outp.push(p); }
    return { page: outp.join('/'), id };
  };
  async function openPeek(box, rect) {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const rel = (list, label) => (list.length ? `<div class="peek-rel"><span>${label}</span>${list.map((c) => `<button type="button" class="ref" data-focus="${esc(c.id)}">${esc(c.label)}${c.via ? ` <i>${esc(c.via)}</i>` : ''}</button>`).join('')}</div>` : '');
    const page = box.href ? pageHref(box.href) : null;
    const pageTitle = page && state.pages.find((p) => p.page === page.page);
    peekEl.innerHTML = `
      <div class="peek-head"><div class="peek-title"><b>${esc(box.label)}</b>${box.src ? `<code>${esc(box.src)}</code>` : (box.ext ? '<span>Outside this code</span>' : '')}</div><button class="peek-x" type="button" aria-label="Close">×</button></div>
      ${box.mark ? `<div class="peek-mark ${esc(box.mark)}">${box.mark === 'broken' ? 'This box no longer matches the code.' : 'The code changed after this page was written.'}</div>` : ''}
      ${box.desc ? `<p class="peek-desc">${esc(box.desc)}</p>` : ''}
      ${box.why ? `<p class="peek-why"><b>Why it is built this way.</b> ${esc(box.why)}</p>` : ''}
      ${box.src ? '<div class="peek-code"><div class="peek-loading">Reading the code…</div></div>' : ''}
      ${rel(box.to, 'Calls')}${rel(box.from, 'Called by')}
      <div class="peek-actions">
        ${pageTitle ? `<button type="button" class="primary" data-act="open">Open ${esc(titleOf(pageTitle))}</button>` : ''}
        <button type="button" data-act="ask">Ask about this</button>
        ${box.id && (box.to.length || box.from.length) ? '<button type="button" data-act="links">Show its connections</button>' : ''}
      </div>`;
    peekEl.hidden = false;
    // place it beside the box, inside the stage
    const W = Math.min(400, stage.width - 24); peekEl.style.width = `${W}px`;
    const H = () => peekEl.offsetHeight;
    let left = rect.r + 12; let top = rect.t;
    if (left + W > stage.width - 12) left = rect.l - W - 12;
    if (left < 12) { left = Math.max(12, Math.min(rect.l, stage.width - W - 12)); top = rect.b + 10; }
    const place = () => { peekEl.style.left = `${left}px`; peekEl.style.top = `${Math.max(12, Math.min(top, stage.height - H() - 12))}px`; };
    place();
    peekEl.querySelector('.peek-x').onclick = closePeek;
    peekEl.onclick = (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      const ref = ev.target.closest('[data-focus]');
      if (ref) { pointAt([box.id, ref.dataset.focus].filter(Boolean), '', ''); return; }
      if (act === 'open') { closePeek(); if (page.id) state.pendingFocus = { type: 'focus', items: [page.id] }; go(page.page); }
      else if (act === 'ask') { state.about = { kind: 'element', label: box.label, src: box.src, excerpt: box.desc }; renderAbout(); closePeek(); setPanel(true); input.focus(); }
      else if (act === 'links') { pointAt([box.id, ...box.to.map((c) => c.id), ...box.from.map((c) => c.id)], '', ''); }
    };
    if (box.src) {
      let sn = {};
      try { sn = await fetch(`/api/snippet?src=${encodeURIComponent(box.src)}&t=${encodeURIComponent(TOKEN)}`).then((r) => r.json()); } catch { sn = { error: 'could not read the code' }; }
      const code = peekEl.querySelector('.peek-code'); if (!code || peekEl.hidden) return;
      if (sn.kind === 'folder') code.innerHTML = `<div class="peek-loading">A folder: ${esc(sn.path)}</div>`;
      else if (sn.error) code.innerHTML = `<div class="peek-loading">${esc(sn.error)}</div>`;
      else {
        code.innerHTML = `<div class="peek-codehead">${esc(sn.path)}, line ${sn.line}${sn.lastChange ? `, changed ${esc(sn.lastChange)}` : ''}</div><pre>${sn.lines.map((l, i) => `<span class="${sn.start + i === sn.line ? 'hit' : ''}"><i>${sn.start + i}</i>${esc(l) || ' '}</span>`).join('')}</pre>`;
        place();
      }
    }
  }
  document.addEventListener('mousedown', (e) => { if (!peekEl.hidden && !e.target.closest('#peek')) closePeek(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !peekEl.hidden) { closePeek(); e.stopPropagation(); } }, true);

  // "Ask about this": the box goes along with the next message.
  function renderAbout() {
    const el = $('about'); const a = state.about;
    el.hidden = !a; if (!a) { el.innerHTML = ''; return; }
    el.innerHTML = `<span>About <b>${esc(a.label)}</b>${a.src ? ` <code>${esc(a.src)}</code>` : ''}</span><button type="button" aria-label="Remove">×</button>`;
    el.querySelector('button').onclick = () => { state.about = null; renderAbout(); };
    input.placeholder = `Ask about ${a.label}`;
  }
  function markPending(id, on) {
    const el = msgsEl.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.querySelector('.waiting')?.remove();
    if (on) el.insertAdjacentHTML('beforeend', `<div class="waiting">${S.waiting}</div>`);
  }

  // ---------- agent state ----------
  let tick = null;
  function renderWorking() {
    msgsEl.querySelector('.working')?.remove();
    if (state.agent.state !== 'working' || state.conn !== 'live' || isStale()) return;
    const w = document.createElement('div'); w.className = 'working';
    w.innerHTML = `<i></i><span>${esc(state.progress || `${agentName()} is working on it`)}</span>`;
    msgsEl.appendChild(w);
  }
  function renderAgent() {
    const s = state.conn === 'closed' ? 'closed' : state.agent.state;
    const shown = s === 'working' && isStale() ? 'stale' : s;
    $('agent').dataset.state = shown;
    $('agentLabel').textContent = S.state[shown] ? S.state[shown](agentName()) : shown;
    clearInterval(tick);
    const el = $('elapsed');
    if (s === 'working' && state.agent.since) {
      let stale = isStale();
      const upd = () => {
        el.textContent = fmtElapsed(Date.now() - state.agent.since);
        if (isStale() !== stale) { stale = !stale; renderAgent(); }
      };
      upd(); el.hidden = false; tick = setInterval(upd, 1000);
    } else el.hidden = true;
    renderWorking(); renderNotice();
  }
  function renderNotice() {
    const n = $('notice');
    const s = state.conn === 'closed' ? 'closed' : state.agent.state;
    const page = state.page && state.page !== 'index.html' ? ` ${state.page}` : '';
    // One pattern for every state that needs the user: what is true, what to do, the command to give the agent.
    const listen = cmdBox(`${state.cmd} listen`);
    let html = '';
    if (s === 'closed') {
      html = `<b>This workspace is closed</b>Your pages are still in <code>.truemap/</code>. To reopen this page, ask your agent to run:${cmdBox(state.cmd + page)}`;
    } else if (s === 'offline') {
      html = `<b>Your messages will wait here</b>To get answers, ask your agent in its terminal session to run:${listen}`;
    } else if (s === 'idle') {
      html = `<b>Your messages will wait here</b>To continue, ask ${esc(agentName())} in the terminal to run:${listen}`;
    } else if (s === 'working' && isStale()) {
      html = `<b>No reply for ${Math.round(STALE_MS / 60000)} minutes</b>${esc(agentName())} may have stopped, or be waiting for you in the terminal. Check there, or ask it to run:${listen}<p class="after">If it no longer knows your last comments, send them again.</p>`;
    }
    n.innerHTML = html; n.hidden = !html;
    n.querySelector('.copy')?.addEventListener('click', (e) => {
      const text = n.querySelector('.cmd code').textContent;
      navigator.clipboard?.writeText(text).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1400); }).catch(() => {});
    });
  }
  const STALE_MS = 3 * 60 * 1000;
  const isStale = () => state.agent.state === 'working' && state.conn === 'live'
    && Date.now() - Math.max(state.agent.since || 0, state.lastAgentEvent || 0) > STALE_MS;
  const cmdBox = (cmd) => `<div class="cmd"><code>${esc(cmd)}</code><button class="copy" type="button">Copy</button></div>`;
  function setAgent(a) {
    if (!a) return;
    state.agent = { state: a.state || 'offline', name: a.name || state.agent.name, since: a.since || 0 };
    if (state.agent.state !== 'working') state.progress = '';
    renderAgent();
  }

  // ---------- sending ----------
  async function send(text, extra = {}) {
    text = String(text || '').trim();
    const withNotes = !extra.answer && !extra.noNotes;
    const notes = withNotes ? state.notes : [];
    let context = extra.context ?? notes.map((n) => ({ kind: n.kind, label: n.label, src: n.src, excerpt: n.excerpt, comment: n.text, page: n.page }));
    const about = !extra.context && !extra.answer && state.about;
    if (about) context = [...context, { kind: 'element', label: about.label, src: about.src, excerpt: about.excerpt || '', page: state.page }];
    if (!text && !context.length && !extra.answer) return;
    const r = await api('/api/send', { text, context, page: state.page, ...extra });
    if (r.id && !r.delivered) { state.pending.add(r.id); markPending(r.id, true); }
    if (withNotes && notes.length && r.id) { state.notes = []; renderNotes(); syncFrameNotes(); }
    if (about && r.id) { state.about = null; renderAbout(); input.placeholder = S.placeholder; }
  }

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() && !state.notes.length) { input.focus(); return; }
    input.value = ''; autosize();
    send(text);
  });

  $('drawBlueprint').onclick = () => { setPanel(true); send(S.drawPrompt, { context: [], noNotes: true }); };
  $('checkChip').onclick = () => {
    const r = resultFor(state.page);
    if (!r || (!r.counts.changed && !r.counts.broken)) return;
    setPanel(true);
    send(S.fixPrompt(`.truemap/${state.page}`, r.counts.changed, r.counts.broken), { context: [], noNotes: true });
  };

  // A decision only counts as the user's if the user actually moved focus into the page.
  window.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement === frame) state.frameFocusAt = Date.now(); }, 0); });
  const userIsInFrame = () => document.activeElement === frame && state.frameFocusAt > 0;

  // ---------- messages from the page frame ----------
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== CONTENT || !e.data || !e.data.__truemap) return;
    const d = e.data;
    if (d.type === 'press') {
      closePeek();
    } else if (d.type === 'nav') {
      navigate(d.dir);
    } else if (d.type === 'peek') {
      if (d.box && d.rect) openPeek(d.box, d.rect);
    } else if (d.type === 'loaded') {
      if (d.page && d.page !== state.page) setCurrent(d.page);
      closePeek();
      if (state.pendingFocus) { const pf = state.pendingFocus; state.pendingFocus = null; setTimeout(() => toFrame({ type: 'focus', note: '', who: agentName(), ...pf }), 60); }
      renderHeader(); sendMarks();
      if (!state.annotateTouched && typeof d.annotate === 'boolean') state.annotate = d.annotate;
      setAnnotate(state.annotate);
      syncFrameNotes();
      const y = state.scroll[d.page]; if (y) toFrame({ type: 'scroll', y });
    } else if (d.type === 'scroll') {
      state.scroll[d.page] = d.y; closePeek();
    } else if (d.type === 'note' || d.type === 'note-update') {
      const n = d.note || {};
      const note = { id: String(n.id), page: d.page, kind: n.kind === 'text' ? 'text' : 'element', label: String(n.label || '').slice(0, 80), src: String(n.src || ''), excerpt: String(n.excerpt || '').slice(0, 400), text: String(n.text || '').slice(0, 4000), selector: String(n.selector || ''), rect: n.rect && typeof n.rect === 'object' ? { left: +n.rect.left || 0, top: +n.rect.top || 0, right: +n.rect.right || 0, bottom: +n.rect.bottom || 0 } : null };
      const i = state.notes.findIndex((x) => x.id === note.id);
      if (i >= 0) state.notes[i] = note; else state.notes.push(note);
      renderNotes(); syncFrameNotes();
      if (d.send) send(input.value).then(() => { input.value = ''; autosize(); });
      else if (!panelOpen() && !narrow()) setPanel(true, false);
    } else if (d.type === 'note-remove') {
      state.notes = state.notes.filter((x) => x.id !== d.id); renderNotes(); syncFrameNotes();
    } else if (d.type === 'toggle-annotate') {
      setAnnotate(!state.annotate, { touched: true });
    } else if (d.type === 'annotate-off') {
      setAnnotate(false, { touched: true });
    } else if (d.type === 'answer') {
      const fromUser = d.trusted === true && userIsInFrame();
      send('', {
        kind: 'answer', from: fromUser ? 'user' : 'page', noNotes: true,
        context: d.src ? [{ kind: 'element', label: d.question, src: d.src }] : [],
        answer: { question: d.question, choice: d.choice, note: d.note },
      });
    } else if (d.type === 'page-send') {
      if (d.text) send(d.text, { from: 'page', context: [], noNotes: true });
    }
  });

  // ---------- live events from the server ----------
  let closedTimer = null;
  function setConn(c) {
    if (state.conn === c) return;
    state.conn = c; app.dataset.conn = c;
    $('annotate').disabled = c === 'closed';
    renderHeader();
    renderAgent();
  }
  function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
    let greeted = false;
    const guard = setTimeout(() => { if (!greeted) { es.close(); connect(); } }, 3000);
    es.onerror = () => {
      if (closedTimer) return;
      closedTimer = setTimeout(() => { if (es.readyState !== EventSource.OPEN) setConn('closed'); }, 5000);
    };
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type === 'hello') {
        greeted = true; clearTimeout(guard); clearTimeout(closedTimer); closedTimer = null;
        setConn('live');
        state.pages = d.pages || []; state.check = d.check || { results: [] }; state.history = d.history || [];
        state.pending = new Set(d.pending || []);
        if (d.cmd) state.cmd = d.cmd;
        state.root = String(d.root || '');
        if (typeof d.annotate === 'boolean') { state.annotate = d.annotate; state.annotateTouched = true; $('annotate').setAttribute('aria-checked', String(d.annotate)); }
        $('ver').textContent = `truemap ${d.version}`;
        $('project').textContent = String(d.root || '').split(/[\\/]/).filter(Boolean).pop() || '';
        state.agent = { state: d.agent?.state || 'offline', name: d.agent?.name || '', since: d.agent?.since || 0 };
        renderAll(); renderAgent(); renderNotes();
        const fromHash = decodeURIComponent((location.hash.match(/page=([^&]+)/) || [])[1] || '');
        const target = [state.page, fromHash, d.current].find((p) => p && state.pages.some((x) => x.page === p)) || state.pages[0]?.page;
        target ? go(target, { force: !frame.getAttribute('src') }) : showEmpty();
      } else if (d.type === 'chat') {
        state.history.push(d.entry); appendEntry(d.entry, true, true);
        if (d.entry.role === 'agent') state.lastAgentEvent = Date.now();
      } else if (d.type === 'agent') {
        setAgent(d.agent);
      } else if (d.type === 'delivered') {
        for (const id of d.ids || []) { state.pending.delete(id); markPending(id, false); }
      } else if (d.type === 'progress') {
        state.progress = d.text || ''; state.lastAgentEvent = Date.now(); renderWorking(); renderNotice(); scrollChat();
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
        if (typeof d.annotate === 'boolean') { state.annotate = d.annotate; state.annotateTouched = true; }
        if (d.page && state.pages.some((p) => p.page === d.page)) go(d.page, { force: true });
        else setAnnotate(state.annotate);
        renderHeader();
      } else if (d.type === 'show') {
        if (d.clear) toFrame({ type: 'clear-focus' });
        else pointAt(d.focus || [], d.note || '', AGENTS[d.agent] || agentName(), d.page);
      } else if (d.type === 'closing') {
        es.close(); setConn('closed');
      }
    };
  }
  function navigate(dir) {
    const from = dir === 'back' ? nav.back : nav.fwd; const to = dir === 'back' ? nav.fwd : nav.back;
    while (from.length) {
      const page = from.pop();
      if (state.pages.some((p) => p.page === page)) { if (state.page) to.push(state.page); nav.moving = true; go(page); return; }
    }
  }
  $('crumbHome').onclick = () => go('index.html');
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); navigate(e.key === 'ArrowLeft' ? 'back' : 'forward'); }
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 3) navigate('back'); else if (e.button === 4) navigate('forward'); });
  renderNotes();
  connect();
})();
