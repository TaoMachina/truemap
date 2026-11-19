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
    state: { listening: 'Listening', working: 'Working', idle: 'Stopped listening', stale: 'No reply yet', offline: 'Not listening', closed: 'Closed' },
    stateLong: {
      listening: (a) => `${a} is listening`, working: (a) => `${a} is working`, idle: (a) => `${a} stopped listening`, stale: (a) => `No reply from ${a} yet`,
      offline: () => 'No agent is listening', closed: () => 'This workspace is closed',
    },
  };

  const $ = (id) => document.getElementById(id);
  const app = $('app'); const frame = $('frame'); const msgsEl = $('msgs'); const input = $('input'); const menu = $('menu');
  const state = {
    pages: [], check: { results: [] }, page: null, history: [], pending: new Set(), scroll: {},
    notes: [], agent: { state: 'offline', name: '', since: 0 }, progress: '', cmd: 'npx -y truemap-cli',
    conn: 'live', frameFocusAt: 0,
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
    else if (!menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...menu.querySelectorAll('.page-item')]; if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
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
    renderProjects();
    const r = resultFor(state.page); const st = stateOf(r);
    const chip = $('checkChip');
    if (!r || r.missing || !r.anchors?.length || state.conn === 'closed') { chip.hidden = true; return; }
    chip.hidden = false;
    const { changed, broken } = r.counts;
    chip.dataset.state = st || 'ok';
    $('checkText').textContent = broken ? S.broken(broken) + (changed ? `, ${S.changed(changed)}` : '') : changed ? S.changed(changed) : S.ok;
    chip.title = st ? 'Ask the agent to update this page' : `${S.ok}: ${r.counts.ok} boxes checked`;
    if (!st) $('checkText').textContent = '';
    chip.setAttribute('aria-label', st ? $('checkText').textContent : S.ok);
  }
  function sendMarks() {
    const r = resultFor(state.page);
    if (panelEl.classList.contains('show-changes')) return toFrame({ type: 'marks', items: [] });
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

  // ---------- notes: comments on boxes or text, sent together ----------
  const notesForPage = () => state.notes.filter((n) => n.page === state.page);
  function syncFrameNotes() { toFrame({ type: 'notes', items: notesForPage().map(({ id, kind, label, src, text, selector, rect }) => ({ id, kind, label, src, text, selector, rect })) }); }
  // Unsent comments survive a reload of this tab.
  try { state.notes = JSON.parse(localStorage.getItem('truemap.notes') || '[]'); } catch { state.notes = []; }
  function saveNotes() { try { localStorage.setItem('truemap.notes', JSON.stringify(state.notes)); } catch { /* ignore */ } }
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
    $('send').textContent = planRequest ? 'Send request' : count ? `Send ${count} comment${count > 1 ? 's' : ''}` : 'Send';
    if (!planRequest) input.placeholder = count ? S.placeholderNotes : S.placeholder;
  }

  // ---------- conversation ----------
  function whoLine(role, at, name) {
    const el = document.createElement('div'); el.className = role === 'agent' ? 'who' : 'who you';
    el.innerHTML = `<b>${esc(role === 'agent' ? (AGENTS[name] || name || agentName()) : S.you)}</b><span>${timeOf(at)}</span>`;
    return el;
  }
  let lastRole = null;
  function renderAll() {
    msgsEl.innerHTML = ''; lastRole = null;
    if (!state.history.length) {
      msgsEl.innerHTML = `<div class="intro"><p>Ask about anything on the page. <b>Click a box</b> to see what it is and comment on it; comments go out together, each with the code it points to.</p></div>`;
    }
    for (const e of state.history) appendEntry(e, false);
    renderWorking();
    scrollChat(); requestAnimationFrame(scrollChat); setTimeout(scrollChat, 300);
  }
  function appendEntry(e, scroll = true, live = false) {
    msgsEl.querySelector('.intro')?.remove();
    if (e.role !== lastRole) { msgsEl.appendChild(whoLine(e.role, e.at, e.agent)); lastRole = e.role; }
    const el = document.createElement('div');
    if (e.role === 'agent') {
      el.className = 'msg agent';
      el.innerHTML = e.ask && e.text.trim() === e.ask.question.trim() ? '' : md(e.text);
      for (const li of el.querySelectorAll('li')) if (li.querySelector('a.ref')) li.classList.add('has-ref');
      if (e.focus?.length) {
        if (!e.plan) el.insertAdjacentHTML('beforeend', `<p class="show-map"><a href="#" data-focus="${esc(e.focus.join(','))}">Show on the map</a></p>`);
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
  let hoverLit = null;
  msgsEl.addEventListener('mouseover', (e) => {
    const host = e.target.closest('li.has-ref, a.ref');
    const ids = host ? [...new Set([...(host.matches('a.ref') ? [host] : host.querySelectorAll('a.ref'))].flatMap((r) => r.dataset.focus.split(',')).filter(Boolean))] : null;
    const key = ids ? ids.join(',') : null;
    if (key === hoverLit || (!key && (hoverLit === '__pinned' || !hoverLit))) return;
    msgsEl.querySelector('li.lit')?.classList.remove('lit');
    hoverLit = key;
    if (ids) { if (host.matches('li')) host.classList.add('lit'); toFrame({ type: 'focus', items: ids, note: '', who: '', scroll: false, transient: true }); }
    else toFrame({ type: 'clear-focus' });
  });
  msgsEl.addEventListener('mouseleave', () => { if (hoverLit && hoverLit !== '__pinned') { hoverLit = null; msgsEl.querySelector('li.lit')?.classList.remove('lit'); toFrame({ type: 'clear-focus' }); } });
  msgsEl.addEventListener('click', (e) => {
    const ref = e.target.closest('[data-focus]');
    if (ref) { e.preventDefault(); hoverLit = '__pinned'; pointAt(ref.dataset.focus.split(',').filter(Boolean), '', ''); return; }
    const step = e.target.closest('li.has-ref');
    if (step) { hoverLit = '__pinned'; pointAt([...step.querySelectorAll('a.ref')].flatMap((r) => r.dataset.focus.split(',')).filter(Boolean), '', ''); return; }
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

  // ---------- inspector: what a box is. It takes the panel's place until you go back. ----------
  const panelEl = $('panel'); const inspBody = $('inspBody');
  const pageHref = (href) => {
    const [file, id] = href.split('#');
    const base = state.page && state.page.includes('/') ? state.page.replace(/[^/]+$/, '') : '';
    const parts = (base + file).split('/'); const outp = [];
    for (const p of parts) { if (p === '..') outp.pop(); else if (p && p !== '.') outp.push(p); }
    return { page: outp.join('/'), id };
  };
  const PLAN = { new: 'New in this plan', change: 'Changes in this plan', remove: 'Removed in this plan' };
  let inspSeq = 0; let panelWasClosed = false;
  const inspecting = () => panelEl.classList.contains('inspecting');
  function closeInspector() {
    if (!inspecting()) return;
    panelEl.classList.remove('inspecting'); inspBody.innerHTML = ''; inspSeq++; app.classList.remove('wide-panel');
    toFrame({ type: 'select', id: null });
    if (panelWasClosed) { panelWasClosed = false; setPanel(false, false); }
  }
  $('inspBack').onclick = () => closeInspector();
  const absPath = (rel) => { const sep = String(state.root).includes('\\') ? '\\' : '/'; return [state.root, ...rel.split('/')].join(sep); };
  async function loadCode(box, holder, seq) {
    let sn = {};
    try { sn = await fetch(`/api/snippet?src=${encodeURIComponent(box.src)}&t=${encodeURIComponent(TOKEN)}`).then((r) => r.json()); } catch { sn = { error: 'Could not read the code' }; }
    if (seq !== inspSeq) return; // another box was opened meanwhile
    if (sn.kind === 'folder') holder.innerHTML = `<div class="code-note">A folder: ${esc(sn.path)}</div>`;
    else if (sn.error) holder.innerHTML = `<div class="code-note">${esc(sn.error)}</div>`;
    else if (sn.missing) holder.innerHTML = `<div class="code-note broken">“${esc(sn.name)}” no longer appears in ${esc(sn.path)}. The code moved on; ask the agent to update this box.</div>`;
    else {
      holder.innerHTML = `<div class="code-meta">Line ${sn.line}${sn.lastChange ? `, changed ${esc(sn.lastChange)}` : ''}</div><pre>${sn.lines.map((l, i) => `<span class="${sn.start + i === sn.line ? 'hit' : ''}"><i>${sn.start + i}</i>${esc(l) || ' '}</span>`).join('')}</pre>`;
      const ed = inspBody.querySelector('.open-ed');
      if (ed) { ed.href = `vscode://file/${absPath(sn.path).replace(/\\/g, '/')}:${sn.line}`; ed.hidden = false; }
      const hit = holder.querySelector('.hit'); const pre = holder.querySelector('pre');
      if (hit && pre) pre.scrollTop = Math.max(0, hit.offsetTop - pre.offsetTop - 44);
      holder.closest('.insp-code')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  function openInspector(box) {
    const seq = ++inspSeq;
    if (!panelOpen()) { panelWasClosed = true; setPanel(true, false); }
    panelEl.classList.add('inspecting');
    $('inspBack').lastChild.textContent = panelEl.classList.contains('show-changes') ? 'Changes' : 'Conversation';
    toFrame({ type: 'select', id: box.id || null, src: box.src || '' });
    const chips = (list) => list.map((c) => `<button type="button" class="chip" data-box="${esc(c.id)}">${esc(c.label)}${c.via ? `<i>${esc(c.via)}</i>` : ''}</button>`).join('');
    const page = box.href ? pageHref(box.href) : null;
    const pageT = page && state.pages.find((p) => p.page === page.page);
    let detail = ''; let list = false;
    for (const d of box.detail || []) {
      if (d.t === 'li' && !list) { detail += '<ul>'; list = true; }
      if (d.t !== 'li' && list) { detail += '</ul>'; list = false; }
      detail += d.t === 'li' ? `<li>${esc(d.text)}</li>` : `<p>${esc(d.text)}</p>`;
    }
    if (list) detail += '</ul>';
    if (!detail && box.desc) detail = `<p>${esc(box.desc)}</p>`;
    const rel = box.to.length || box.from.length;
    inspBody.innerHTML = `
      <div class="insp-name"><h2>${esc(box.label)}</h2>${box.tag ? `<code>${esc(box.tag)}</code>` : ''}</div>
      ${PLAN[box.plan] ? `<span class="insp-plan">${PLAN[box.plan]}</span>${box.planNote ? `<p class="insp-why">${esc(box.planNote)}</p>` : ''}` : ''}
      ${box.mark ? `<div class="insp-state ${box.mark === 'broken' ? 'broken' : ''}">${box.mark === 'broken' ? 'This box no longer matches the code.' : 'The code changed after this page was written.'}</div>` : ''}
      ${changeSection(box)}
      ${detail ? `<div class="insp-detail">${detail}</div>` : ''}
      ${box.why ? `<div class="insp-why">${esc(box.why)}</div>` : ''}
      <form class="insp-comment"><textarea rows="1" aria-label="Comment"></textarea><button type="submit" disabled>Add</button></form>
      ${rel ? `<div class="insp-rel">${box.to.length ? `<span>Calls</span><div>${chips(box.to)}</div>` : ''}${box.from.length ? `<span>Called by</span><div>${chips(box.from)}</div>` : ''}</div>` : ''}
      ${box.src ? `<details class="insp-code"><summary><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>Code <code>${esc(box.src.split('#')[0])}</code><a class="open-ed" hidden>Open in VS Code</a></summary><div class="code-box"><div class="code-note">Reading the code…</div></div></details>`
        : box.ext ? '<div class="insp-why">Outside this code base.</div>' : ''}
      ${pageT ? `<div class="insp-actions">${pageT ? `<button type="button" data-act="open">Open ${esc(titleOf(pageT))}</button>` : ''}</div>` : ''}`;
    inspBody.scrollTop = 0;
    wireChangeSection();
    const form = inspBody.querySelector('.insp-comment'); const ta = form.querySelector('textarea'); const add = form.querySelector('button');
    ta.placeholder = `Comment on ${box.label}, or ask about it`;
    ta.addEventListener('input', () => { add.disabled = !ta.value.trim(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); form.requestSubmit(); } });
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = ta.value.trim(); if (!text) return;
      state.notes.push({ id: `n${Date.now().toString(36)}`, page: state.page, kind: 'element', label: box.label, src: box.src || '', excerpt: (box.detail?.[0]?.text || box.desc || '').slice(0, 400), text, selector: box.id ? `#${CSS.escape(box.id)}` : '', rect: null });
      renderNotes(); syncFrameNotes();
      panelWasClosed = false; closeInspector(); input.focus();
    };
    const widen = () => app.classList.toggle('wide-panel', !!inspBody.querySelector('.insp-code[open], .insp-change details[open]'));
    for (const d of inspBody.querySelectorAll('details')) d.addEventListener('toggle', widen);
    widen();
    const code = inspBody.querySelector('.insp-code');
    if (code) code.addEventListener('toggle', () => { if (code.open && !code.dataset.loaded) { code.dataset.loaded = '1'; loadCode(box, code.querySelector('.code-box'), seq); } });
    inspBody.querySelector('.open-ed')?.addEventListener('click', (e) => e.stopPropagation());
    inspBody.onclick = (ev) => {
      const chip = ev.target.closest('[data-box]');
      if (chip) { toFrame({ type: 'open-box', id: chip.dataset.box }); return; }
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'open') { closeInspector(); if (page.id) state.pendingFocus = { type: 'focus', items: [page.id] }; go(page.page); }
      else if (act === 'links') pointAt([box.id, ...box.to.map((c) => c.id), ...box.from.map((c) => c.id)], '', '');
    };
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !inspecting() || !menu.hidden || !$('moreMenu').hidden) return;
    if (e.target.closest?.('.insp-comment') && e.target.value) return;
    closeInspector(); toFrame({ type: 'clear-focus' }); e.stopPropagation();
  }, true);

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

  // ---------- changes: what changed since a base, by box ----------
  const tabs = { convo: $('tabConvo'), changes: $('tabChanges') };
  const BASES = { turn: 'Since the agent’s last turn began', plan: 'Since you approved the plan', head: 'Uncommitted changes', main: 'This branch vs main' };
  const ch = { base: store.get('truemap.base') || 'auto', data: null, names: new Map() };
  const showingChanges = () => panelEl.classList.contains('show-changes');
  function setTab(which) {
    panelEl.classList.toggle('show-changes', which === 'changes');
    tabs.convo.setAttribute('aria-selected', String(which !== 'changes'));
    tabs.changes.setAttribute('aria-selected', String(which === 'changes'));
    closeInspector();
    if (which === 'changes') { renderChanges(); loadChanges(); }
    sendChangeMarks(); sendMarks();
  }
  tabs.convo.onclick = () => setTab('convo');
  tabs.changes.onclick = () => setTab('changes');
  let loadingChanges = false;
  async function loadChanges() {
    if (state.conn !== 'live' || loadingChanges) return;
    loadingChanges = true;
    let r = null;
    try { r = await fetch(`/api/changes?base=${encodeURIComponent(ch.base)}&t=${encodeURIComponent(TOKEN)}`).then((x) => x.json()); } catch { r = null; }
    loadingChanges = false;
    if (!r) return;
    ch.data = r;
    const n = r.error ? 0 : r.files;
    $('changesCount').hidden = !n; $('changesCount').textContent = n ? String(n) : '';
    if (showingChanges()) renderChanges();
    sendChangeMarks();
  }
  function sendChangeMarks() {
    const on = showingChanges() && ch.data && !ch.data.error;
    toFrame({ type: 'changes', on: !!on, items: on ? ch.data.boxes.filter((b) => b.pages.includes(state.page)).map((b) => ({ src: b.src, add: b.add, del: b.del })) : [] });
  }
  const delta = (a, d) => `<span class="delta">${a == null ? 'binary' : `<span class="a">+${a}</span> <span class="d">−${d}</span>`}</span>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function renderChanges() {
    const el = $('changes'); const r = ch.data;
    if (!r) { el.innerHTML = '<p class="ch-empty">Reading the working tree…</p>'; return; }
    if (r.error) { el.innerHTML = `<p class="ch-empty">Changes need a git repository with at least one commit (${esc(r.error)}).</p>`; return; }
    const opts = r.bases.map((k) => `<option value="${k}"${k === r.base.kind ? ' selected' : ''}>${esc(k === r.base.kind ? r.base.label : BASES[k])}</option>`).join('');
    let html = `<div class="ch-base"><select id="chBase" aria-label="Compare with">${opts}</select></div>`;
    html += `<p class="ch-sum">${r.files ? `${plural(r.files, 'file')} changed ${delta(r.add, r.del)}` : 'Nothing changed.'}${r.base.at ? ` Measured from ${esc(timeOf(r.base.at))}.` : ''}</p>`;
    if (r.plan) {
      const done = r.plan.planned.filter((p) => p.changed).length; const missing = r.plan.planned.filter((p) => !p.changed);
      html += `<div class="ch-plan"><div class="ch-h">Plan: ${esc(r.plan.title)}</div><p class="ch-sum">${done} of ${r.plan.planned.length} planned boxes changed${r.plan.unplanned.length ? `, ${plural(r.plan.unplanned.length, 'box')} changed outside the plan` : ''}.</p>`;
      if (missing.length) html += `<ul class="ch-missing">${missing.map((p) => `<li><b>${esc(p.name || ch.names.get(p.src) || p.box)}</b> planned, no changes yet${p.what ? `<small>${esc(p.what)}</small>` : ''}</li>`).join('')}</ul>`;
      html += '</div>';
    }
    const planned = new Set((r.plan?.planned || []).map((p) => p.src).filter(Boolean));
    if (r.boxes.length) {
      html += '<div class="ch-h">On the map</div>';
      for (const b of r.boxes) {
        const here = b.pages.includes(state.page);
        const name = ch.names.get(b.src) || b.src.split('#')[1] || b.src.split('/').pop();
        const other = here ? '' : `, on ${titleOf(state.pages.find((p) => p.page === b.pages[0]) || { page: b.pages[0] })}`;
        const offPlan = r.plan && !planned.has(b.src) ? '<span class="off-plan">not in the plan</span>' : '';
        html += `<button type="button" class="ch-row" data-src="${esc(b.src)}" data-page="${esc(here ? state.page : b.pages[0])}"><b>${esc(name)}${offPlan}</b>${delta(b.add, b.del)}<small>${esc(b.files.map((f) => f.path).join(', ') + other)}</small></button>`;
      }
    }
    if (r.unmapped.length) {
      const n = r.unmapped.reduce((k, g) => k + g.files.length, 0);
      html += `<div class="ch-h">Not on the map: ${plural(n, 'file')}</div>`;
      for (const g of r.unmapped) {
        html += `<details class="ch-folder"><summary><b>${esc(g.folder)}</b><span>${plural(g.files.length, 'file')}</span></summary>${g.files.map((f) => `<button type="button" class="ch-file" data-path="${esc(f.path)}"><span>${esc(f.path)}</span>${delta(f.add, f.del)}</button>`).join('')}</details>`;
      }
      html += '<div class="ch-act"><button type="button" data-act="map">Ask the agent to map these</button></div>';
    }
    if (!r.files) html += r.base.kind !== 'head' ? '<div class="ch-act"><button type="button" data-act="head">Show uncommitted changes instead</button></div>' : '<p class="ch-empty">It updates by itself while the agent works.</p>';
    el.innerHTML = html;
  }
  function diffHtml(text) {
    const rows = [];
    for (const l of String(text || '').split('\n')) {
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue;
      const cls = l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';
      rows.push(`<span class="${cls}">${esc(l) || ' '}</span>`);
    }
    return rows.length ? `<pre>${rows.join('')}</pre>` : '<div class="code-note">No text changes (binary or mode only).</div>';
  }
  async function loadDiff(path, holder) {
    holder.innerHTML = '<div class="code-note">Reading the diff…</div>';
    let r = {};
    try { r = await fetch(`/api/diff?base=${encodeURIComponent(ch.data?.base?.kind || ch.base)}&path=${encodeURIComponent(path)}&t=${encodeURIComponent(TOKEN)}`).then((x) => x.json()); } catch { r = { error: 'Could not read the diff' }; }
    holder.innerHTML = r.error ? `<div class="code-note">${esc(r.error)}</div>` : diffHtml(r.text);
  }
  $('changes').addEventListener('change', (e) => {
    if (e.target.id !== 'chBase') return;
    ch.base = e.target.value; store.set('truemap.base', ch.base); ch.data = null; renderChanges(); loadChanges();
  });
  $('changes').addEventListener('click', (e) => {
    const row = e.target.closest('.ch-row');
    if (row) {
      if (row.dataset.page !== state.page) { state.pendingOpen = row.dataset.src; go(row.dataset.page); } else toFrame({ type: 'open-box', src: row.dataset.src });
      return;
    }
    const file = e.target.closest('.ch-file');
    if (file) {
      const next = file.nextElementSibling;
      if (next?.classList.contains('ch-diff')) { next.remove(); return; }
      const box = document.createElement('div'); box.className = 'ch-diff code-box'; file.after(box); loadDiff(file.dataset.path, box);
      return;
    }
    if (e.target.closest('[data-act="head"]')) { ch.base = 'head'; store.set('truemap.base', 'head'); ch.data = null; renderChanges(); loadChanges(); return; }
    if (e.target.closest('[data-act="map"]')) {
      const files = ch.data.unmapped.flatMap((g) => g.files.map((f) => f.path));
      setTab('convo');
      send(`These changed files are not on any page yet. Add boxes for the ones that matter (or say why they don't need one): ${files.slice(0, 40).join(', ')}${files.length > 40 ? ', …' : ''}`, { context: [], noNotes: true });
    }
  });
  // The inspector shows what changed in a box while you review changes.
  function changeSection(box) {
    if (!showingChanges() || !ch.data?.boxes) return '';
    const b = ch.data.boxes.find((x) => x.src === box.src);
    if (!b) return '';
    return `<div class="insp-change"><div><span>${esc(ch.data.base.label)}</span>${delta(b.add, b.del)}</div>${b.files.map((f, i) => `<details${i === 0 ? ' open' : ''} data-path="${esc(f.path)}"><summary><span>${esc(f.path)}${f.shared ? `<span class="shared">shared with ${plural(f.shared, 'other box')}</span>` : ''}</span>${delta(f.add, f.del)}</summary><div class="code-box"></div></details>`).join('')}</div>`;
  }
  function wireChangeSection() {
    for (const d of inspBody.querySelectorAll('.insp-change details')) {
      const load = () => { if (d.open && !d.dataset.loaded) { d.dataset.loaded = '1'; loadDiff(d.dataset.path, d.querySelector('.code-box')); } };
      d.addEventListener('toggle', load); load();
    }
  }
  setInterval(() => { if (document.visibilityState === 'visible') loadChanges(); }, 10_000);

  // ---------- plan review: the agent's plan on the map, approve or ask for changes ----------
  // Requesting changes is a mode of the composer: a heading says so, Send sends the request (comments included).
  function setRequest(on) {
    planRequest = !!on;
    const el = $('about');
    if (on) {
      el.hidden = false;
      el.innerHTML = '<span><b>Requesting changes to the plan</b></span><button type="button" aria-label="Cancel">×</button>';
      el.querySelector('button').onclick = () => setRequest(false);
      input.placeholder = 'What should change? (comments above go along)';
      input.focus(); scrollChat();
    } else { renderAbout(); input.placeholder = state.notes.length ? S.placeholderNotes : S.placeholder; }
    renderNotes();
  }
  const planBar = $('planbar');
  let planRequest = false; // the next message asks for plan changes
  function sendPlan() { toFrame({ type: 'plan', plan: state.plan && state.plan.page === state.page ? state.plan : null }); }
  function renderPlan() {
    const p = state.plan;
    if (!p || p.status === 'done' || state.planHidden === `${p.slug}:${p.status}`) { planBar.hidden = true; planBar.innerHTML = ''; return; }
    planBar.hidden = false;
    const counts = [p.add.length && `${p.add.length} new`, p.touch.length && `${p.touch.length} changing`, p.remove.length && `${p.remove.length} removed`].filter(Boolean).join(', ');
    const here = p.page === state.page;
    let html = `<div class="pb-text"><b>Plan</b><span class="pb-title">${esc(p.title)}</span><span class="pb-meta">${esc(counts)}${p.revision > 1 && p.status === 'review' ? ', revised' : ''}</span></div>`;
    if (p.status === 'review') {
      html += `<div class="pb-acts">${here ? '' : '<button type="button" class="pb-btn" data-pb="open">Show on the map</button>'}<button type="button" class="pb-btn" data-pb="request">Request changes</button><button type="button" class="pb-btn primary" data-pb="approve">Approve</button></div>`;
    } else if (p.status === 'revise') {
      html += `<div class="pb-acts"><span class="pb-wait">Waiting for the revised plan</span></div>`;
    } else if (p.status === 'approved') {
      const building = state.agent.state === 'working' && state.conn === 'live';
      html += `<div class="pb-acts"><span class="pb-wait">${building ? `Approved. ${esc(agentName())} is building it.` : `Approved. Waiting for ${esc(agentName())} to pick it up.`}</span><button type="button" class="pb-btn" data-pb="changes">See what changed</button><button type="button" class="pb-x" data-pb="hide" aria-label="Hide">×</button></div>`;
    }
    planBar.innerHTML = html;
  }
  planBar.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-pb]')?.dataset.pb;
    const p = state.plan; if (!act || !p) return;
    if (act === 'open') go(p.page);
    else if (act === 'hide') { state.planHidden = `${p.slug}:${p.status}`; renderPlan(); }
    else if (act === 'changes') { ch.base = 'plan'; ch.data = null; setPanel(true); setTab('changes'); }
    else if (act === 'request') { setPanel(true); setTab('convo'); setRequest(true); }
    else if (act === 'approve') {
      // comments written before approving still go to the agent, first
      if (state.notes.length || input.value.trim()) { const t = input.value; input.value = ''; autosize(); await send(t); }
      await api('/api/plan', { action: 'approve' });
    }
  });

  // ---------- projects: every truemap project running on this machine ----------
  const projMenu = $('projMenu');
  let projList = [];
  const PSTATE = { listening: 'Agent listening', working: 'Agent working', idle: 'Agent stopped listening', offline: 'No agent' };
  const needsYou = (p) => !p.self && (p.unread || p.asking || p.plan?.status === 'review');
  function renderProjects() {
    const self = projList.find((p) => p.self);
    if (self) $('projName').textContent = self.name;
    const n = projList.filter(needsYou).length;
    $('projCount').hidden = !n; $('projCount').textContent = n ? `${n} waiting` : '';
    $('projBtn').title = n ? `${n} other project${n > 1 ? 's' : ''} need${n > 1 ? '' : 's'} you` : 'Projects';
    const p = state.pages.find((x) => x.page === state.page);
    document.title = `${n ? `(${n}) ` : ''}${p ? `${titleOf(p)} – ` : ''}${self ? self.name : 'truemap'}`;
    if (projMenu.hidden) return;
    projMenu.innerHTML = projList.map((x) => {
      const why = x.plan?.status === 'review' ? `<em>Plan to review</em> ${esc(x.plan.title)}` : x.asking ? '<em>Waiting for your decision</em>' : x.unread ? '<em>New reply</em>' : esc(PSTATE[x.agent] || '');
      return `<a class="proj-item${x.self ? ' self' : ''}" role="menuitem" ${x.self ? '' : `href="${esc(x.url)}" target="truemap-${esc(x.name)}" rel="noopener"`} data-self="${x.self ? 1 : ''}"><i class="${esc(x.agent || '')}"></i><b>${esc(x.name)}</b><small>${why}</small></a>`;
    }).join('') + `<div class="proj-foot">Projects with truemap running. Run <code>${esc(state.cmd)}</code> in another repo to add it.</div>`;
  }
  async function loadProjects() {
    try { projList = (await fetch(`/api/projects?t=${encodeURIComponent(TOKEN)}`).then((r) => r.json())).projects || []; } catch { return; }
    renderProjects();
  }
  $('projBtn').onclick = (e) => {
    e.stopPropagation();
    if (!projMenu.hidden) { projMenu.hidden = true; $('projBtn').setAttribute('aria-expanded', 'false'); return; }
    projMenu.hidden = false; $('projBtn').setAttribute('aria-expanded', 'true'); renderProjects(); loadProjects();
  };
  projMenu.addEventListener('click', (e) => { const a = e.target.closest('.proj-item'); if (a?.dataset.self) e.preventDefault(); projMenu.hidden = true; $('projBtn').setAttribute('aria-expanded', 'false'); });
  document.addEventListener('click', (e) => { if (!projMenu.hidden && !e.target.closest('.projects')) { projMenu.hidden = true; $('projBtn').setAttribute('aria-expanded', 'false'); } });
  setInterval(() => { if (state.conn === 'live') loadProjects(); }, 15_000);

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
    $('agentLabel').textContent = S.state[shown] || shown;
    $('agent').title = S.stateLong[shown] ? S.stateLong[shown](agentName()) : '';
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
    renderWorking(); renderNotice(); if (typeof renderPlan === "function" && state.plan) renderPlan();
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
      html = `<b>No agent is listening</b>Messages wait here. To get answers, ask your agent to run${listen}`;
    } else if (s === 'idle') {
      html = `<b>${esc(agentName())} stopped listening</b>Messages wait here. To continue, ask it to run${listen}`;
    } else if (s === 'working' && isStale()) {
      html = `<b>No reply for ${Math.round(STALE_MS / 60000)} minutes</b>${esc(agentName())} may have stopped, or be waiting for you in the terminal. Check there, or ask it to run:${listen}<p class="after">If it no longer knows your last comments, send them again.</p>`;
    }
    const atEnd = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 40;
    n.innerHTML = html; n.hidden = !html;
    if (atEnd) scrollChat();
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
    if (planRequest && !extra.answer) { extra = { ...extra, plan: 'request' }; setRequest(false); }
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
    if (!text.trim() && !state.notes.length && !planRequest) { input.focus(); return; }
    input.value = ''; autosize();
    send(text);
  });

  $('drawBlueprint').onclick = () => { setPanel(true); send(S.drawPrompt, { context: [], noNotes: true }); };
  $('checkChip').onclick = () => {
    const r = resultFor(state.page);
    if (!r || (!r.counts.changed && !r.counts.broken)) return;
    const stale = r.anchors.filter((a) => a.state !== 'ok');
    const broken = stale.filter((a) => a.state === 'broken').length;
    pointAt(stale.map((a) => a.src), broken ? 'These boxes no longer match the code.' : 'The code under these boxes changed after this page was written.', 'truemap');
    setPanel(true); setTab('convo');
    if (!input.value.trim()) { input.value = `Update this page: ${stale.map((a) => a.src.split('#')[1] || a.path).join(', ')} ${broken ? 'no longer match the code' : 'changed in the code'}.`; autosize(); }
    input.focus();
  };

  // A decision only counts as the user's if the user actually moved focus into the page.
  window.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement === frame) state.frameFocusAt = Date.now(); }, 0); });
  const userIsInFrame = () => document.activeElement === frame && state.frameFocusAt > 0;

  // ---------- messages from the page frame ----------
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== CONTENT || !e.data || !e.data.__truemap) return;
    const d = e.data;
    if (d.type === 'press' || d.type === 'deselect') {
      closeInspector();
    } else if (d.type === 'nav') {
      navigate(d.dir);
    } else if (d.type === 'peek') {
      if (d.box) openInspector(d.box);
    } else if (d.type === 'loaded') {
      if (d.page && d.page !== state.page) setCurrent(d.page);
      closeInspector();
      if (state.pendingFocus) { const pf = state.pendingFocus; state.pendingFocus = null; setTimeout(() => toFrame({ type: 'focus', note: '', who: agentName(), ...pf }), 60); }
      renderHeader(); sendMarks(); sendChangeMarks(); sendPlan(); renderPlan();
      if (state.pendingOpen) { const src = state.pendingOpen; state.pendingOpen = null; setTimeout(() => toFrame({ type: 'open-box', src }), 80); }
      syncFrameNotes();
      const y = state.scroll[d.page]; if (y) toFrame({ type: 'scroll', y });
    } else if (d.type === 'scroll') {
      state.scroll[d.page] = d.y;
    } else if (d.type === 'note' || d.type === 'note-update') {
      const n = d.note || {};
      const note = { id: String(n.id), page: d.page, kind: n.kind === 'text' ? 'text' : 'element', label: String(n.label || '').slice(0, 80), src: String(n.src || ''), excerpt: String(n.excerpt || '').slice(0, 400), text: String(n.text || '').slice(0, 4000), selector: String(n.selector || ''), rect: n.rect && typeof n.rect === 'object' ? { left: +n.rect.left || 0, top: +n.rect.top || 0, right: +n.rect.right || 0, bottom: +n.rect.bottom || 0 } : null };
      const i = state.notes.findIndex((x) => x.id === note.id);
      if (i >= 0) state.notes[i] = note; else state.notes.push(note);
      renderNotes(); syncFrameNotes();
      if (d.send) send(input.value).then(() => { input.value = ''; autosize(); });
      else if (!panelOpen() && !narrow()) setPanel(true, false);
    } else if (d.type === 'focus-state') {
      const n = Number(d.count) || 0;
      $('litPill').hidden = !n || !!d.transient;
      $('litText').textContent = n === 1 ? '1 box lit' : `${n} boxes lit`;
    } else if (d.type === 'focus-cleared') {
      $('litPill').hidden = true;
    } else if (d.type === 'changes-names') {
      for (const it of d.items || []) if (it && it.src) ch.names.set(String(it.src), String(it.name || '').slice(0, 80));
      if (showingChanges()) renderChanges();
    } else if (d.type === 'note-remove') {
      state.notes = state.notes.filter((x) => x.id !== d.id); renderNotes(); syncFrameNotes();
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

  $('litClear').onclick = () => { toFrame({ type: 'clear-focus' }); $('litPill').hidden = true; };

  // ---------- live events from the server ----------
  let closedTimer = null;
  function setConn(c) {
    if (state.conn === c) return;
    state.conn = c; app.dataset.conn = c;
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
        $('ver').textContent = `truemap ${d.version}`;
        loadProjects();
        $('project').textContent = String(d.root || '').split(/[\\/]/).filter(Boolean).pop() || '';
        state.agent = { state: d.agent?.state || 'offline', name: d.agent?.name || '', since: d.agent?.since || 0 };
        state.plan = d.plan || null;
        renderAll(); renderAgent(); renderNotes(); loadChanges(); renderPlan();
        const last = [...state.history].reverse().find((h) => h.role === 'agent');
        if (!panelOpen() && !narrow() && (state.plan?.status === 'review' || (last?.ask && !state.history.some((h) => h.kind === 'answer' && h.at > last.at)))) setPanel(true, false);
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
        if (d.page && state.pages.some((p) => p.page === d.page)) go(d.page, { force: true });
        renderHeader();
      } else if (d.type === 'show') {
        if (d.clear) toFrame({ type: 'clear-focus' });
        else pointAt(d.focus || [], d.note || '', AGENTS[d.agent] || agentName(), d.page);
      } else if (d.type === 'plan') {
        state.plan = d.plan || null; renderPlan(); sendPlan();
      } else if (d.type === 'changes-base') {
        loadChanges();
      } else if (d.type === 'view') {
        if (d.view === 'changes') { if (d.base) { ch.base = d.base; ch.data = null; } setPanel(true); setTab('changes'); }
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
