// Injected into every .truemap page by the local server (never saved into the page file).
// Runs inside the sandboxed page frame:
//  - draws the wires of .tm-map from data-to
//  - annotate mode: click a box or select text, write a comment, the workspace collects it
//  - decision forms become answers; check marks show boxes whose code moved
(() => {
  if (window.__truemapSdk) return;
  window.__truemapSdk = true;
  const parentWin = window.parent;
  const framed = parentWin && parentWin !== window;
  const PARENT = '__TRUEMAP_PARENT__';
  const post = (msg) => { if (framed) parentWin.postMessage({ __truemap: true, ...msg }, PARENT); };
  const pagePath = () => decodeURIComponent(location.pathname.replace(/^\/pages\//, ''));
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const T = {
    sent: 'Sent', changed: 'The code changed after this was written', broken: 'The code this points to is gone',
    placeholder: 'Comment or question', add: 'Add comment', save: 'Save', remove: 'Remove', cancel: 'Cancel',
    hint: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘Enter sends now' : 'Ctrl+Enter sends now',
    suggest: [['Explain this', 'Explain how this works.'], ['What depends on it', 'What depends on this, and what does it depend on?'], ['Why this way', 'Why is it built this way? What are the trade-offs?']],
    comment: 'Comment',
  };

  // ---------- page styles for truemap states ----------
  const style = document.createElement('style');
  style.textContent = `
    [data-tm-mark="changed"] { outline: 2px dashed var(--tm-changed, #a2690a) !important; outline-offset: 3px; }
    [data-tm-mark="broken"] { outline: 2px dashed var(--tm-broken, #b03a2e) !important; outline-offset: 3px; }
    svg [data-tm-mark] { outline: none !important; }
    html[data-tm-annotate] body { cursor: default; }
    html[data-tm-annotate] [data-tm-hover] { cursor: pointer; }
    html[data-tm-annotate] a, html[data-tm-annotate] label { cursor: pointer; }
    @keyframes tm-flash { 0%,100% { outline-color: transparent } 35% { outline-color: var(--tm-route, #2453c4) } }
    [data-tm-flash] { outline: 2px solid var(--tm-route, #2453c4) !important; outline-offset: 4px; animation: tm-flash 1.1s ease 2; }
    @media (prefers-reduced-motion: reduce) { [data-tm-flash] { animation: none; } }
    ::highlight(tm-note) { background-color: color-mix(in oklab, var(--tm-route, #2453c4) 20%, transparent); }
  `;
  (document.head || document.documentElement).appendChild(style);

  const drawWires = () => window.truemapWires?.draw();
  let wireTimer = null;
  const scheduleWires = () => { clearTimeout(wireTimer); wireTimer = setTimeout(() => { drawWires(); placePins(); }, 40); };

  // ---------- annotate ----------
  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[contenteditable],[role=button]';
  let annotating = false;
  let hovered = null;
  const notes = new Map(); // id -> { id, kind, el, rect, label, src, excerpt, text, n }

  function labelOf(el) {
    return clean(el.getAttribute('data-label') || el.getAttribute('aria-label')
      || el.querySelector?.('.tm-node-title,h1,h2,h3,h4,strong,b')?.textContent || el.getAttribute('title') || el.textContent, 60) || el.tagName.toLowerCase();
  }
  function pickTarget(t) {
    if (!t || t.closest?.('#truemap-layer')) return null;
    const anchored = t.closest('[data-src]');
    if (anchored) return anchored;
    const block = t.closest('.tm-node,.tm-step,.tm-card,.tm-callout,.tm-ask,.tm-option,.tm-link,h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,figure,pre,blockquote,svg g,svg');
    if (block && block !== document.body && block !== document.documentElement) return block;
    return null;
  }
  function cssPath(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(' > ');
  }
  let rings = null;
  function setHover(el) {
    if (hovered === el) return;
    hovered?.removeAttribute('data-tm-hover');
    hovered = el; el?.setAttribute('data-tm-hover', '');
    paintRings();
  }

  // Highlights are drawn in the top layer, never as CSS outlines, so a scrolling or clipped container
  // can't cut them off. A ring covers the element and everything inside it (a badge that sticks out too).
  function extentOf(el) {
    const r0 = el.getBoundingClientRect();
    let l = r0.left; let t = r0.top; let r = r0.right; let b = r0.bottom;
    const kids = [...el.querySelectorAll('*')].slice(0, 400);
    // Content scrolled out of view inside a scrolling block (a long code line, a map) doesn't count.
    const clips = [el, ...kids].filter((n) => { const s = getComputedStyle(n); return s.overflowX !== 'visible' || s.overflowY !== 'visible'; });
    for (const kid of kids) {
      const k = kid.getBoundingClientRect();
      if (!k.width || !k.height) continue;
      let kl = k.left; let kt = k.top; let kr = k.right; let kb = k.bottom;
      for (const c of clips) {
        if (c === kid || !c.contains(kid)) continue;
        const cr = c.getBoundingClientRect();
        kl = Math.max(kl, cr.left); kt = Math.max(kt, cr.top); kr = Math.min(kr, cr.right); kb = Math.min(kb, cr.bottom);
      }
      if (kr <= kl || kb <= kt) continue;
      l = Math.min(l, kl); t = Math.min(t, kt); r = Math.max(r, kr); b = Math.max(b, kb);
    }
    // An element half scrolled out of its own scrolling parent is cut at that parent's edge too.
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      l = Math.max(l, ar.left - 2); t = Math.max(t, ar.top - 2); r = Math.min(r, ar.right + 2); b = Math.min(b, ar.bottom + 2);
    }
    return { left: l + scrollX - 4, top: t + scrollY - 4, width: r - l + 8, height: b - t + 8 };
  }
  function paintRings() {
    if (!rings) return;
    rings.innerHTML = '';
    const ring = (el, cls) => {
      if (!el?.isConnected) return;
      mount();
      const x = extentOf(el); const d = document.createElement('div');
      d.className = `ring ${cls}`;
      Object.assign(d.style, { left: `${x.left}px`, top: `${x.top}px`, width: `${x.width}px`, height: `${x.height}px` });
      rings.appendChild(d);
    };
    for (const n of notes.values()) if (n.el && n.el !== card?.target) ring(n.el, 'noted');
    if (card?.target) ring(card.target, 'active');
    else if (annotating && hovered) ring(hovered, 'hover');
  }
  function setAnnotate(on) {
    annotating = !!on;
    document.documentElement.toggleAttribute('data-tm-annotate', annotating);
    if (!annotating) { setHover(null); }
    paintRings();
  }

  // Shadow layer for the comment card, pins and the selection button: page CSS can't touch it.
  const host = document.createElement('div');
  host.id = 'truemap-layer';
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card { position: absolute; width: 340px; background: #fff; color: #17202b; border: 1px solid #c2c8c1; border-radius: 10px;
      box-shadow: 0 12px 32px -12px rgba(23,32,43,.28); font: 14px/1.45 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; padding: 12px; }
    .what { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin: 0 2px 8px; }
    .what b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .what code { font: 11.5px "IBM Plex Mono", ui-monospace, Consolas, monospace; color: #8a939e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
    textarea { width: 100%; min-height: 72px; max-height: 220px; resize: none; font: inherit; color: inherit; background: #f6f7f4; border: 1px solid #dde1db; border-radius: 7px; padding: 9px 10px; outline: none; }
    textarea:focus { border-color: #2453c4; background: #fff; }
    .suggest { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 2px 0; }
    .suggest button { all: unset; cursor: pointer; font-size: 12.5px; color: #2453c4; }
    .suggest button:hover { text-decoration: underline; text-underline-offset: 3px; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .hint { flex: 1; font-size: 11.5px; color: #8a939e; line-height: 1.3; }
    .btn { all: unset; cursor: pointer; font: 500 13px/1 "IBM Plex Sans", system-ui, sans-serif; padding: 8px 11px; border-radius: 6px; color: #5b6573; }
    .btn:hover { background: #eef0ec; color: #17202b; }
    .btn.primary { background: #2453c4; color: #fff; }
    .btn.primary:hover { background: #1b3f96; }
    .btn.danger { color: #b03a2e; }
    .btn:focus-visible { outline: 2px solid #2453c4; outline-offset: 2px; }
    .ring { position: absolute; border: 1.5px solid #2453c4; border-radius: 8px; pointer-events: none; }
    .ring.active { border-width: 2px; }
    .ring.noted { border-color: rgba(36, 83, 196, .5); }
    @media (prefers-color-scheme: dark) { .ring { border-color: #7ea3ff; } .ring.noted { border-color: rgba(126, 163, 255, .55); } }
    .pin { position: absolute; width: 20px; height: 20px; border-radius: 50%; background: #2453c4; color: #fff;
      font: 600 11px/20px "IBM Plex Mono", ui-monospace, Consolas, monospace; text-align: center; cursor: pointer; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(23,32,43,.25); }
    .select-btn { position: absolute; all: unset; position: absolute; cursor: pointer; background: #17202b; color: #fff; font: 500 12.5px/1 "IBM Plex Sans", system-ui, sans-serif; padding: 7px 10px; border-radius: 6px; box-shadow: 0 6px 18px -8px rgba(23,32,43,.5); }
    .select-btn:hover { background: #2453c4; }
    @media (prefers-color-scheme: dark) {
      .card { background: #191d23; color: #edf0f3; border-color: #3d4651; box-shadow: 0 12px 32px -12px rgba(0,0,0,.6); }
      textarea { background: #121519; border-color: #2a3039; }
      textarea:focus { background: #121519; border-color: #7ea3ff; }
      .suggest button { color: #7ea3ff; }
      .btn { color: #9ba4af; } .btn:hover { background: #1f242b; color: #edf0f3; }
      .btn.primary { background: #2453c4; color: #fff; }
      .pin { border-color: #121519; }
    }
  </style><div id="rings"></div><div id="pins"></div><div id="slot"></div>`;
  const pinsEl = shadow.getElementById('pins');
  const slot = shadow.getElementById('slot');
  rings = shadow.getElementById('rings');
  const mount = () => { if (!host.isConnected) document.body.appendChild(host); };

  let card = null; // { el, target, textRange, noteId }
  // Text comments keep their words highlighted (CSS Custom Highlight API where available).
  function paintHighlights() {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
    const ranges = [...notes.values()].map((n) => n.range).filter(Boolean);
    if (card?.range) ranges.push(card.range);
    if (ranges.length) CSS.highlights.set('tm-note', new Highlight(...ranges)); else CSS.highlights.delete('tm-note');
  }
  function closeCard() {
    if (!card) return;
    card.target?.removeAttribute('data-tm-active');
    card.el.remove(); card = null;
    paintHighlights(); paintRings();
  }
  function docRect(r) { return { left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY, width: r.width, height: r.height }; }

  function openCard({ target = null, text = null, rect, noteId = null }) {
    closeCard(); hideSelectBtn(); mount(); setHover(null);
    const existing = noteId ? notes.get(noteId) : null;
    const sel = getSelection();
    const range = existing ? existing.range || null : (text && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null);
    const label = existing?.label || (target ? labelOf(target) : clean(text, 60));
    const src = existing?.src ?? (target ? target.closest('[data-src]')?.getAttribute('data-src') || '' : (text && rangeSrc()) || '');
    const el = document.createElement('div');
    el.className = 'card'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Comment');
    el.innerHTML = `<div class="what"><b></b><code></code></div><textarea rows="3"></textarea>
      <div class="suggest"></div>
      <div class="foot"><span class="hint"></span>${existing ? `<button class="btn danger" data-act="remove" type="button">${T.remove}</button>` : `<button class="btn" data-act="cancel" type="button">${T.cancel}</button>`}<button class="btn primary" data-act="add" type="button">${existing ? T.save : T.add}</button></div>`;
    el.querySelector('b').textContent = text ? `“${label}”` : label;
    el.querySelector('code').textContent = src;
    el.querySelector('.hint').textContent = T.hint;
    const ta = el.querySelector('textarea'); ta.placeholder = T.placeholder; ta.value = existing?.text || '';
    const sug = el.querySelector('.suggest');
    if (!existing) for (const [lbl, prompt] of T.suggest) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = lbl;
      b.onclick = () => { ta.value = prompt; ta.focus(); };
      sug.appendChild(b);
    } else sug.remove();
    slot.appendChild(el);
    // position: below the target, kept inside the viewport
    const r = rect || docRect(target.getBoundingClientRect());
    const w = 340; const vw = document.documentElement.clientWidth;
    let left = Math.min(Math.max(8 + scrollX, r.left), scrollX + vw - w - 12);
    let top = r.bottom + 10;
    const h = el.offsetHeight || 220;
    if (top + h > scrollY + innerHeight - 8 && r.top - h - 10 > scrollY) top = r.top - h - 10;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    target?.setAttribute('data-tm-active', '');
    card = { el, target, text, noteId, label, src, rect: r, range };
    paintHighlights(); paintRings();
    const finish = (sendNow) => {
      const value = ta.value.trim();
      if (!value) { ta.focus(); return; }
      const id = noteId || `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const note = {
        id, kind: target ? 'element' : 'text', label, src, text: value,
        excerpt: clean(target ? (target.innerText || target.textContent) : text, 400),
        selector: target ? cssPath(target) : '', rect: target ? null : r,
      };
      notes.set(id, { ...note, el: target, range });
      post({ type: existing ? 'note-update' : 'note', page: pagePath(), note: { ...note, rect: note.rect ? { left: note.rect.left, top: note.rect.top, right: note.rect.right, bottom: note.rect.bottom } : null }, send: !!sendNow });
      closeCard(); placePins();
      getSelection()?.removeAllRanges();
    };
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add') finish(false);
      else if (act === 'cancel') closeCard();
      else if (act === 'remove') { removeNote(noteId, true); closeCard(); }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCard(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(e.ctrlKey || e.metaKey); }
    });
    setTimeout(() => ta.focus({ preventScroll: true }), 0);
  }

  function rangeSrc() {
    const sel = getSelection();
    const node = sel?.anchorNode?.nodeType === 1 ? sel.anchorNode : sel?.anchorNode?.parentElement;
    return node?.closest?.('[data-src]')?.getAttribute('data-src') || '';
  }

  function removeNote(id, tellParent) {
    const n = notes.get(id); if (!n) return;
    notes.delete(id);
    if (tellParent) post({ type: 'note-remove', page: pagePath(), id });
    placePins();
  }

  function placePins() {
    paintHighlights();
    pinsEl.innerHTML = '';
    for (const el of document.querySelectorAll('[data-tm-noted]')) el.removeAttribute('data-tm-noted');
    paintRings();
    if (!notes.size) return;
    mount();
    let i = 0;
    for (const n of notes.values()) {
      i++;
      let r = null;
      if (n.el && !n.el.isConnected && n.selector) { try { n.el = document.querySelector(n.selector); } catch { n.el = null; } }
      if (n.el?.isConnected) { const x = extentOf(n.el); r = { left: x.left + 4, top: x.top + 4 }; n.el.setAttribute('data-tm-noted', ''); }
      else if (n.rect) r = n.rect;
      if (!r) continue;
      const pin = document.createElement('div');
      pin.className = 'pin'; pin.textContent = String(n.num || i); pin.title = n.text;
      pin.style.left = `${r.left - 10}px`; pin.style.top = `${r.top - 10}px`;
      pin.onclick = (e) => { e.stopPropagation(); openCard({ target: n.el?.isConnected ? n.el : null, text: n.el ? null : n.label, rect: r, noteId: n.id }); };
      pinsEl.appendChild(pin);
    }
  }

  // Floating "Comment" button for a text selection (works in any mode).
  let selectBtn = null;
  function hideSelectBtn() { selectBtn?.remove(); selectBtn = null; }
  function showSelectBtn(text, rect) {
    hideSelectBtn(); mount();
    selectBtn = document.createElement('button');
    selectBtn.className = 'select-btn'; selectBtn.type = 'button'; selectBtn.textContent = T.comment;
    selectBtn.style.left = `${rect.left}px`; selectBtn.style.top = `${Math.max(scrollY + 4, rect.top - 38)}px`;
    selectBtn.onmousedown = (e) => e.preventDefault();
    selectBtn.onclick = () => openCard({ text, rect });
    slot.appendChild(selectBtn);
  }

  // What a click would comment on. Hover shows exactly this, so the outline never lies.
  // Form controls keep working while annotating (decisions are answered, not annotated).
  function annotTarget(t) {
    if (!t || t.closest('input,select,textarea,button,label,summary,.tm-ask')) return null;
    return t.closest('a.tm-node,a.tm-link') || pickTarget(t);
  }
  document.addEventListener('mousemove', (e) => {
    if (!annotating || card) return;
    const t = e.target instanceof Element ? e.target : null;
    setHover(annotTarget(t));
  }, { passive: true });
  document.addEventListener('mouseleave', () => setHover(null));

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (e.composedPath().includes(host)) return;
    const t = e.target instanceof Element ? e.target : null;
    if (card) { closeCard(); if (!annotating) return; }
    if (!annotating || !t) return;
    if (String(getSelection?.() || '').trim().length > 1) return;
    const el = annotTarget(t);
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const existing = [...notes.values()].find((n) => n.el === el);
    openCard({ target: el, noteId: existing?.id || null });
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!e.isTrusted || e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = clean(sel?.toString(), 600);
      if (!text || text.length < 2 || !sel.rangeCount) { if (!card) hideSelectBtn(); return; }
      const r = docRect(sel.getRangeAt(0).getBoundingClientRect());
      if (annotating) openCard({ text, rect: r }); else showSelectBtn(text, r);
    }, 0);
  });
  document.addEventListener('selectionchange', () => { if (!String(getSelection() || '').trim()) hideSelectBtn(); });

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]');
    if (e.key === 'Escape' && card) { closeCard(); return; }
    if (e.key === 'Escape' && annotating && !typing && !e.defaultPrevented && !e.composedPath().includes(host)) { post({ type: 'annotate-off' }); return; }
    if (!typing && !e.composedPath().includes(host) && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') {
      post({ type: 'toggle-annotate' });
    }
  });

  // ---------- decisions: <form class="tm-ask" data-tm-ask="question"> ----------
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-tm-ask')) return;
    e.preventDefault();
    const fd = new FormData(form);
    const values = {}; let note = '';
    for (const [k, v] of fd.entries()) {
      if (typeof v !== 'string') continue;
      if (k === 'note') { note = v.trim(); continue; }
      (values[k] ||= []).push(v);
    }
    const question = form.getAttribute('data-tm-ask') || clean(form.querySelector('h3,legend,h2,h4')?.textContent, 200);
    const choice = Object.values(values).flat().join(', ');
    if (!choice && !note) return;
    form.setAttribute('data-tm-sent', '');
    const btn = form.querySelector('button[type=submit],button:not([type])');
    if (btn) btn.textContent = T.sent;
    post({ type: 'answer', page: pagePath(), trusted: e.isTrusted, question, choice, note, src: form.closest('[data-src]')?.getAttribute('data-src') || '' });
  }, true);

  // Pages may also talk to the agent directly (marked as coming from the page, not the user).
  window.truemap = { send: (text) => post({ type: 'page-send', page: pagePath(), text: clean(text, 4000) }) };

  // ---------- messages from the workspace ----------
  window.addEventListener('message', (e) => {
    if (e.source !== parentWin || e.origin !== PARENT || !e.data || !e.data.__truemap) return;
    const d = e.data;
    if (d.type === 'marks') {
      document.querySelectorAll('[data-tm-mark]').forEach((el) => el.removeAttribute('data-tm-mark'));
      for (const m of d.items || []) {
        document.querySelectorAll('[data-src]').forEach((el) => {
          if (el.getAttribute('data-src') !== m.src) return;
          el.setAttribute('data-tm-mark', m.state);
          if (!el.hasAttribute('title')) el.setAttribute('title', m.state === 'broken' ? T.broken : T.changed);
        });
      }
    } else if (d.type === 'annotate') {
      setAnnotate(d.on); if (!d.on) closeCard();
    } else if (d.type === 'notes') {
      // the workspace owns unsent notes; restore pins after a reload, renumber after removals
      const keep = new Map();
      (d.items || []).forEach((n, i) => {
        const old = notes.get(n.id);
        let el = old?.el || null;
        if (!el && n.selector) { try { el = document.querySelector(n.selector); } catch { el = null; } }
        keep.set(n.id, { ...n, el, rect: old?.rect || n.rect || null, range: old?.range || null, num: i + 1 });
      });
      notes.clear(); for (const [k, v] of keep) notes.set(k, v);
      placePins();
    } else if (d.type === 'focus-note') {
      const n = notes.get(d.id);
      const el = n?.el?.isConnected ? n.el : null;
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.setAttribute('data-tm-flash', ''); setTimeout(() => el.removeAttribute('data-tm-flash'), 2400); }
      else if (n?.rect) window.scrollTo({ top: n.rect.top - innerHeight / 3, behavior: 'smooth' });
    } else if (d.type === 'scroll') {
      window.scrollTo(0, d.y || 0);
    } else if (d.type === 'highlight') {
      const el = [...document.querySelectorAll('[data-src]')].find((x) => x.getAttribute('data-src') === d.src);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.setAttribute('data-tm-flash', ''); setTimeout(() => el.removeAttribute('data-tm-flash'), 2400); }
    }
  });

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => post({ type: 'scroll', page: pagePath(), y: window.scrollY }), 120);
  }, { passive: true });
  window.addEventListener('resize', scheduleWires);
  // Rings follow their element when anything scrolls, including a map scrolling sideways.
  document.addEventListener('scroll', () => { if (rings && (hovered || card || notes.size)) { placePins(); } }, { capture: true, passive: true });

  const ready = () => {
    drawWires();
    if ('ResizeObserver' in window) new ResizeObserver(scheduleWires).observe(document.body);
    document.fonts?.ready?.then(scheduleWires);
    const meta = document.querySelector('meta[name="truemap-annotate"]')?.getAttribute('content');
    post({ type: 'loaded', page: pagePath(), title: document.title || '', annotate: meta ? /^(on|true|1)$/i.test(meta) : null });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
