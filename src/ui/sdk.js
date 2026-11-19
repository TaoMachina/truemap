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
    [data-tm-mark="broken"] { outline: 2px dashed var(--tm-broken, #c0392b) !important; outline-offset: 3px; }
    svg [data-tm-mark] { outline: none !important; }
    .tm-diagram .tm-node[data-tm-mark] { outline: none !important; }
    .tm-diagram .tm-node[data-tm-mark]::before { content: ""; position: absolute; top: 7px; left: -4px; width: 7px; height: 7px; border-radius: 50%; background: var(--tm-changed, #a35f00); box-shadow: 0 0 0 2px var(--tm-paper, #fff); }
    .tm-diagram .tm-node[data-tm-mark="broken"]::before { background: var(--tm-broken, #c0392b); }
    html[data-tm-annotate] body { cursor: default; }
    html[data-tm-annotate] [data-tm-hover] { cursor: pointer; }
    html[data-tm-annotate] a, html[data-tm-annotate] label { cursor: pointer; }
    @keyframes tm-flash { 0%,100% { outline-color: transparent } 35% { outline-color: var(--tm-route, #141413) } }
    [data-tm-flash] { outline: 2px solid var(--tm-route, #141413) !important; outline-offset: 4px; animation: tm-flash 1.1s ease 2; }
    @media (prefers-reduced-motion: reduce) { [data-tm-flash] { animation: none; } }
    ::highlight(tm-note) { background-color: color-mix(in oklab, var(--tm-route, #141413) 20%, transparent); }
    /* Every box can be opened: click shows its code and connections. */
    .tm-node, .tm-step, [data-src] { cursor: pointer; }
    .tm-node:focus-visible, .tm-step:focus-visible { outline: 2px solid var(--tm-route, #141413); outline-offset: 3px; }
    /* The agent points at the map: everything else steps back. */
    html[data-tm-focusing] .tm-node:not([data-tm-focus]), html[data-tm-focusing] .tm-step:not([data-tm-focus]) { opacity: .34; }
    html[data-tm-focusing] .tm-wire:not(.is-focus), html[data-tm-focusing] .tm-wire-head:not(.is-focus) { opacity: .16; }
    html[data-tm-focusing] .tm-wire-label:not(.is-focus) { opacity: 0; }
    .tm-node, .tm-step, .tm-wire, .tm-wire-head, .tm-wire-label { transition: opacity .18s ease, stroke .12s ease, fill .12s ease; }
    @media (prefers-reduced-motion: reduce) { .tm-node, .tm-step, .tm-wire, .tm-wire-head, .tm-wire-label { transition: none; } }
  `;
  (document.head || document.documentElement).appendChild(style);

  const drawWires = () => { window.truemapDiagram?.draw(); window.truemapWires?.draw(); markWires(); };
  let wireTimer = null;
  const scheduleWires = () => { clearTimeout(wireTimer); wireTimer = setTimeout(() => { drawWires(); placePins(); placePlanAct(); }, 40); };

  // ---------- focus: the agent (or a chat link) points at boxes ----------
  let focusSet = []; let focusNote = null; let hotBox = null;
  function findItems(items) {
    const all = [...document.querySelectorAll('[data-src], .tm-node[id], .tm-step[id]')];
    const out = [];
    for (const it of items || []) {
      const s = String(it);
      const el = (/^[\w-]+$/.test(s) && document.getElementById(s))
        || all.find((x) => x.getAttribute('data-src') === s)
        || (!s.includes('#') && all.find((x) => (x.getAttribute('data-src') || '').split('#')[0].replace(/\/$/, '') === s.replace(/\/$/, '')))
        || all.find((x) => (x.getAttribute('data-src') || '').endsWith(`#${s.split('#').pop()}`) && s.includes('#'));
      if (el && !out.includes(el)) out.push(el);
    }
    return out;
  }
  // Classes on wires follow the focused / hovered boxes; re-applied after every redraw.
  function markWires() {
    const ids = new Set(focusSet.map((e) => e.id).filter(Boolean));
    const hot = hotBox?.id;
    for (const w of document.querySelectorAll('.tm-wire, .tm-wire-head')) {
      const { from, to } = w.dataset;
      w.classList.toggle('is-focus', ids.has(from) && ids.has(to));
      w.classList.toggle('is-hot', !!hot && (from === hot || to === hot));
    }
    for (const w of document.querySelectorAll('.tm-dg-edge, .tm-dg-head, .tm-dg-label')) {
      w.classList.toggle('is-focus', ids.has(w.dataset.from) && ids.has(w.dataset.to));
    }
    // labels are placed afresh for what is now visible
    window.truemapWires?.labels?.({ hot: hot || null, focus: [...ids] });
  }
  // Brings elements into view by scrolling the page itself; scrollIntoView would also scroll a map's own
  // clipped box sideways and hide part of it.
  function reveal(els, how = 'center') {
    const rs = els.filter((el) => el.isConnected).map((el) => el.getBoundingClientRect());
    if (!rs.length) return;
    const top = Math.min(...rs.map((r) => r.top)); const bottom = Math.max(...rs.map((r) => r.bottom));
    const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (how === 'nearest' && top >= 8 && bottom <= innerHeight - 8) return;
    const dy = bottom - top > innerHeight - 80 ? top - 60 : (top + bottom) / 2 - innerHeight / 2;
    window.scrollBy({ top: dy, behavior: smooth });
  }
  function applyFocus(items, note, who, scroll = 'center', transient = false) {
    clearFocus(false);
    for (const btn of document.querySelectorAll('[data-tm-flow]')) btn.setAttribute('aria-pressed', 'false');
    focusSet = findItems(items);
    focusNote = note ? { text: String(note), who: who || 'Agent' } : null;
    if (focusSet.length) {
      document.documentElement.setAttribute('data-tm-focusing', '');
      for (const el of focusSet) el.setAttribute('data-tm-focus', '');
      if (scroll) reveal(focusSet, scroll);
    } else if (focusNote) window.scrollTo({ top: 0 });
    // the page scrolls smoothly to the group: place the note again once it has settled
    markWires(); paintRings(); setTimeout(paintRings, 350); setTimeout(paintRings, 900);
    post({ type: 'focus-state', count: focusSet.length, transient });
  }
  function clearFocus(repaint = true) {
    document.documentElement.removeAttribute('data-tm-focusing');
    for (const el of document.querySelectorAll('[data-tm-focus]')) el.removeAttribute('data-tm-focus');
    if (repaint) for (const btn of document.querySelectorAll('[data-tm-flow]')) btn.setAttribute('aria-pressed', 'false');
    const had = focusSet.length;
    focusSet = []; focusNote = null;
    markWires(); if (repaint) paintRings();
    if (had && repaint) post({ type: 'focus-state', count: 0 });
  }

  // ---------- peek: click a box to see what it is in the code ----------
  const boxSel = '.tm-node, .tm-step, .tm-card[data-src], [data-src]';
  function boxInfo(el) {
    const txt = (sel) => clean(el.querySelector(sel)?.textContent, 300);
    const nameOf = (n) => clean(n.getAttribute('data-name') || n.querySelector?.('.tm-node-title,b,strong,h3,h4')?.textContent || n.textContent, 60);
    // Same label rules as the map: underscores are spaces, \_ is a real underscore.
    const viaOf = (s) => s.replace(/\\_/g, '\u0001').replace(/_/g, ' ').replace(/\u0001/g, '_');
    const to = [];
    for (const spec of (el.getAttribute('data-to') || '').split(/[\s,]+/).filter(Boolean)) {
      const [id, ...lab] = spec.split(':'); const n = document.getElementById(id);
      if (n) to.push({ id, label: nameOf(n), via: viaOf(lab.join(':')) });
    }
    const from = [];
    if (el.id) {
      for (const n of document.querySelectorAll('[data-to]')) {
        const spec = n.getAttribute('data-to').split(/[\s,]+/).find((x) => x.split(':')[0] === el.id);
        if (spec && n.id) from.push({ id: n.id, label: nameOf(n), via: viaOf(spec.split(':').slice(1).join(':')) });
      }
    }
    const href = el.matches('a[href]') ? el.getAttribute('href') : (el.querySelector('a[href$=".html"], a[href*=".html#"]')?.getAttribute('href') || '');
    const det = el.querySelector(':scope > .tm-detail');
    const detail = det ? [...det.querySelectorAll(':scope > p:not(.tm-why), :scope > ul > li, :scope > ol > li')].slice(0, 14).map((n) => ({ t: n.tagName === 'LI' ? 'li' : 'p', text: clean(n.textContent, 500) })) : [];
    return {
      id: el.id || '', label: clean(el.getAttribute('data-name'), 60) || labelOf(el), tag: clean(el.getAttribute('data-tag'), 60), plan: el.getAttribute('data-plan') || '', detail,
      sub: txt('.tm-node-sub'), desc: det ? '' : txt('.tm-node-desc') || (el.matches('.tm-node,.tm-step') ? '' : clean(el.innerText, 300)),
      src: el.closest('[data-src]')?.getAttribute('data-src') || '', href: /^[\w./-]+\.html?(#[\w-]*)?$/i.test(href) ? href : '',
      ext: el.classList.contains('is-ext'), to, from, mark: el.getAttribute('data-tm-mark') || '', planNote: clean(el.getAttribute('data-plan-note'), 400), why: clean(el.getAttribute('data-why') || det?.querySelector('.tm-why')?.textContent, 600),
    };
  }
  let selected = null;
  function select(el) {
    if (selected === el) return;
    selected?.removeAttribute('data-tm-selected');
    selected = el || null; selected?.setAttribute('data-tm-selected', '');
    // the selected box's own lines stay lit while its inspector is open
    for (const w of document.querySelectorAll('.tm-dg-edge, .tm-dg-head, .tm-dg-label')) w.classList.toggle('is-sel', !!el?.id && (w.dataset.from === el.id || w.dataset.to === el.id));
    if (!el && document.activeElement?.matches?.('.tm-node, .tm-step')) document.activeElement.blur();
  }
  // Click a box: a small card beside it with what it is and a comment field, so your eyes stay on the map.
  // If the inspector is already open on the right, it follows the box.
  function openBox(box) {
    // a second click on the selected box lets go of it
    if (selected === box) { select(null); post({ type: 'deselect' }); return; }
    select(box);
    post({ type: 'peek-if-open', page: pagePath(), box: boxInfo(box) });
  }
  function cardFor(box) {
    select(box);
    const existing = [...notes.values()].find((n) => n.el === box);
    openCard({ target: box, noteId: existing?.id || null });
  }
  function peek(el) {
    select(el);
    const r = el.getBoundingClientRect();
    post({ type: 'peek', page: pagePath(), box: boxInfo(el), rect: { l: r.left, t: r.top, r: r.right, b: r.bottom }, sy: scrollY });
  }

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
    for (const el of focusSet) if (!el.closest('.tm-diagram')) ring(el, 'agent'); // diagram boxes get the highlighter instead
    if (focusNote) {
      mount();
      const b = document.createElement('div'); b.className = 'bubble'; b.setAttribute('role', 'note');
      b.innerHTML = '<div class="bubble-who"></div><div class="bubble-text"></div><button class="bubble-x" type="button" aria-label="Dismiss">×</button>';
      b.querySelector('.bubble-who').textContent = focusNote.who;
      b.querySelector('.bubble-text').textContent = focusNote.text;
      b.querySelector('.bubble-x').onclick = (ev) => { ev.stopPropagation(); clearFocus(); post({ type: 'focus-cleared' }); };
      rings.appendChild(b);
      // The note sits beside the whole lit group (never on one of its boxes): right of it, else below it.
      const vw = document.documentElement.clientWidth; const w = 300;
      const live = focusSet.filter((el) => el.isConnected).map(extentOf);
      if (live.length) {
        const g = { l: Math.min(...live.map((x) => x.left)), t: Math.min(...live.map((x) => x.top)), r: Math.max(...live.map((x) => x.left + x.width)), b: Math.max(...live.map((x) => x.top + x.height)) };
        // right of the group if there is room; otherwise above it (the page's own controls usually sit below
        // a map); below it only when there is no room above.
        const fitsRight = g.r + 14 + w < scrollX + vw - 8;
        const bh = b.offsetHeight || 90;
        const above = g.t - bh - 12 > scrollY + 4;
        b.style.left = `${fitsRight ? g.r + 14 : Math.max(scrollX + 8, Math.min(g.l, scrollX + vw - w - 8))}px`;
        b.style.top = `${fitsRight ? g.t : above ? g.t - bh - 12 : g.b + 12}px`;
      } else { b.style.left = `${scrollX + vw - 320}px`; b.style.top = `${scrollY + 16}px`; }
    }
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
    .card { position: absolute; z-index: 10; width: 360px; background: #fff; color: #141413; border: 1px solid #d2d2cb; border-radius: 10px;
      box-shadow: 0 12px 32px -12px rgba(20,20,19,.28); font: 14px/1.45 "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif; padding: 12px; }
    .what { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin: 0 2px 6px; }
    .card.viewing { width: 320px; }
    .card.viewing textarea, .card.viewing .suggest, .card.viewing [data-act="add"], .card.viewing [data-act="cancel"], .card.viewing .hint { display: none; }
    .card:not(.viewing) [data-act="comment"] { display: none; }
    .card.viewing .foot { justify-content: flex-start; margin-top: 4px; }
    .card.viewing .sum { margin-bottom: 6px; }
    .sum { margin: 0 2px 10px; font-size: 13px; line-height: 1.45; color: #4a4a45; }
    .sum .flag { margin-top: 4px; font-size: 12px; color: #a35f00; }
    @media (prefers-color-scheme: dark) { .sum { color: #c4c4bd; } .sum .flag { color: #e0a548; } }
    .what b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .what code { font: 11.5px "Commit Mono", ui-monospace, Consolas, monospace; color: #9a9a92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
    textarea { width: 100%; min-height: 72px; max-height: 220px; resize: none; font: inherit; color: inherit; background: #fafaf9; border: 1px solid #e6e6e1; border-radius: 7px; padding: 9px 10px; outline: none; }
    textarea:focus { border-color: #141413; background: #fff; }
    .suggest { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 2px 0; }
    .suggest button { all: unset; cursor: pointer; font-size: 12.5px; color: #141413; }
    .suggest button:hover { text-decoration: underline; text-underline-offset: 3px; }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .foot .btn { white-space: nowrap; }
    .foot [data-act="details"] { padding-left: 2px; text-decoration: underline; text-underline-offset: 3px; }
    .hint { flex: 1; font-size: 11.5px; color: #9a9a92; line-height: 1.3; }
    .btn { all: unset; cursor: pointer; font: 500 13px/1 "Instrument Sans", system-ui, sans-serif; padding: 8px 11px; border-radius: 6px; color: #6c6c65; }
    .btn:hover { background: #f2f2ef; color: #141413; }
    .btn.primary { background: #141413; color: #fff; }
    .btn.primary:hover { background: #3a3a36; }
    .btn.danger { color: #c0392b; }
    .btn:focus-visible { outline: 2px solid #141413; outline-offset: 2px; }
    .ring { position: absolute; border: 1.5px solid #141413; border-radius: 8px; pointer-events: none; }
    .ring.active { border-width: 2px; }
    .ring.agent { border: 2px solid #141413; border-radius: 9px; }
    .bubble { position: absolute; width: 300px; background: #141413; color: #fafaf9; border-radius: 10px; padding: 10px 30px 11px 12px; box-shadow: 0 14px 34px -14px rgba(20,20,19,.5); font: 13.5px/1.5 "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif; pointer-events: auto; }
    .bubble-who { font-size: 11.5px; font-weight: 600; color: #ffe27a; margin-bottom: 3px; }
    .bubble-text { white-space: pre-wrap; }
    .bubble-x { all: unset; position: absolute; top: 6px; right: 8px; cursor: pointer; color: #a0a098; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
    .bubble-x:hover { color: #fff; background: rgba(255,255,255,.1); }
    .ring.noted { border-color: rgba(20, 20, 19, .35); }
    @media (prefers-color-scheme: dark) { .ring { border-color: #f2f2ee; } .ring.noted { border-color: rgba(242, 242, 238, .45); } }
    .pin { position: absolute; width: 20px; height: 20px; border-radius: 50%; background: #ffe27a; color: #141413;
      font: 600 11px/20px "Commit Mono", ui-monospace, Consolas, monospace; text-align: center; cursor: pointer; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(20,20,19,.25); }
    .select-btn { position: absolute; all: unset; position: absolute; cursor: pointer; background: #141413; color: #fff; font: 500 12.5px/1 "Instrument Sans", system-ui, sans-serif; padding: 7px 10px; border-radius: 6px; box-shadow: 0 6px 18px -8px rgba(20,20,19,.5); }
    .select-btn:hover { background: #141413; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1b1b1a; color: #f2f2ee; border-color: #44443f; box-shadow: 0 12px 32px -12px rgba(0,0,0,.6); }
      textarea { background: #161615; border-color: #2f2f2c; }
      textarea:focus { background: #161615; border-color: #f2f2ee; }
      .suggest button { color: #f2f2ee; }
      .btn { color: #a0a098; } .btn:hover { background: #252523; color: #f2f2ee; }
      .btn.primary { background: #f2f2ee; color: #141413; }
      .pin { border-color: #161615; }
    }
      .planact { position: absolute; display: flex; gap: 4px; padding: 4px; background: #fff; border: 1px solid #d2d2cb; border-radius: 999px; box-shadow: 0 8px 22px -10px rgba(20,20,19,.4); pointer-events: auto; z-index: 3; animation: pa-in .22s cubic-bezier(.2,.8,.3,1.2) both; }
    @keyframes pa-in { from { opacity: 0; transform: translateY(4px) scale(.92); } to { opacity: 1; transform: none; } }
    .planact button { all: unset; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; color: #141413; transition: transform .12s ease, background-color .12s ease; }
    .planact button:hover { background: #f2f2ef; transform: scale(1.1); }
    .planact button.ok { background: #141413; color: #fff; }
    .planact button.ok:hover { background: #3a3a36; }
    .planact button:focus-visible { outline: 2px solid #141413; outline-offset: 2px; }
    .planact svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .planact .wait { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; color: #2f7a4f; }
    .planact .wait.revise { color: #6c6c65; animation: pa-pulse 1.4s ease-in-out infinite; }
    @keyframes pa-pulse { 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .planact, .planact .wait.revise { animation: none; } .planact button { transition: none; } }
    @media (prefers-color-scheme: dark) {
      .planact { background: #1b1b1a; border-color: #44443f; }
      .planact button { color: #f2f2ee; } .planact button:hover { background: #252523; }
      .planact button.ok { background: #f2f2ee; color: #141413; }
      .planact .wait { color: #7cc49c; }
    }
  </style><div id="rings"></div><div id="pins"></div><div id="slot"></div><div id="planact"></div>`;
  const pinsEl = shadow.getElementById('pins');
  const slot = shadow.getElementById('slot');
  const planActEl = shadow.getElementById('planact');
  let planNow = null;
  const ICON = {
    ok: '<svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
    no: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    ask: '<svg viewBox="0 0 16 16"><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z"/></svg>',
  };
  // The plan's actions sit next to the boxes it adds or changes, where your eyes already are.
  function placePlanAct() {
    planActEl.innerHTML = '';
    const p = planNow;
    if (!p || !['review', 'revise', 'approved'].includes(p.status)) return;
    const els = [...document.querySelectorAll('[data-plan]')].filter((el) => el.isConnected && el.getBoundingClientRect().width);
    if (!els.length) return;
    mount();
    const rs = els.map((el) => el.getBoundingClientRect());
    const u = { l: Math.min(...rs.map((r) => r.left)) + scrollX, t: Math.min(...rs.map((r) => r.top)) + scrollY, r: Math.max(...rs.map((r) => r.right)) + scrollX, b: Math.max(...rs.map((r) => r.bottom)) + scrollY };
    const box = document.createElement('div'); box.className = 'planact'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Plan');
    if (p.status === 'review') box.innerHTML = `<button class="ok" data-pa="approve" title="Approve the plan" aria-label="Approve the plan">${ICON.ok}</button><button data-pa="reject" title="Reject the plan" aria-label="Reject the plan">${ICON.no}</button><button data-pa="ask" title="Ask or comment on the plan" aria-label="Ask or comment on the plan">${ICON.ask}</button>`;
    else box.innerHTML = p.status === 'revise' ? `<span class="wait revise" title="Waiting for the revised plan">${ICON.ask}</span>` : `<span class="wait" title="Approved">${ICON.ok}</span>`;
    box.title = p.title;
    planActEl.appendChild(box);
    const vw = document.documentElement.clientWidth; const w = box.offsetWidth; const h = box.offsetHeight;
    let left = u.r + 10; let top = u.t - h / 2;
    if (left + w > scrollX + vw - 8) { left = Math.max(scrollX + 8, u.r - w); top = u.t - h - 14; }
    if (top < scrollY + 4) top = u.b + 10;
    box.style.left = `${left}px`; box.style.top = `${top}px`;
    box.onclick = (e) => {
      const act = e.target.closest('[data-pa]')?.dataset.pa; if (!act) return;
      if (act === 'ask') { const r = box.getBoundingClientRect(); openCard({ text: p.title, rect: docRect(r), planComment: true }); return; }
      post({ type: 'plan-act', act });
    };
  }
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

  function openCard({ target = null, text = null, rect, noteId = null, planComment = false, view = false }) {
    closeCard(); hideSelectBtn(); mount(); setHover(null);
    const existing = noteId ? notes.get(noteId) : null;
    const sel = getSelection();
    const range = existing ? existing.range || null : (text && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null);
    const label = existing?.label || (target ? clean(target.getAttribute('data-name'), 60) || labelOf(target) : clean(text, 60));
    const src = existing?.src ?? (target ? target.closest('[data-src]')?.getAttribute('data-src') || '' : (text && rangeSrc()) || '');
    const el = document.createElement('div');
    el.className = view ? 'card viewing' : 'card'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', view ? 'About this box' : 'Comment');
    el.innerHTML = `<div class="what"><b></b><code></code></div><div class="sum"></div><textarea rows="3"></textarea>
      <div class="suggest"></div>
      <div class="foot">${view ? '<button class="btn primary" data-act="comment" type="button" title="Or double-click the box">Comment</button>' : ''}${target ? '<button class="btn" data-act="details" type="button">Details</button>' : ''}<span class="hint"></span>${existing ? `<button class="btn danger" data-act="remove" type="button">${T.remove}</button>` : `<button class="btn" data-act="cancel" type="button">${T.cancel}</button>`}<button class="btn primary" data-act="add" type="button">${planComment ? 'Send' : existing ? T.save : T.add}</button></div>`;
    el.querySelector('b').textContent = text ? `“${label}”` : label;
    el.querySelector('code').textContent = target?.getAttribute('data-tag') || src;
    // what it is, in a line or two; what a plan or a change says about it
    if (target) {
      const det = target.querySelector(':scope > .tm-detail');
      const first = clean(det?.querySelector('p')?.textContent || target.querySelector('.tm-node-desc')?.textContent || '', 220);
      const extra = [
        target.getAttribute('data-plan-note') && `Plan: ${clean(target.getAttribute('data-plan-note'), 160)}`,
        target.getAttribute('data-plan') === 'new' && 'New in this plan',
        target.getAttribute('data-tm-delta') && `Changed: ${target.getAttribute('data-tm-delta')} lines`,
        target.getAttribute('data-tm-mark') && (target.getAttribute('data-tm-mark') === 'broken' ? 'No longer matches the code' : 'The code changed since this box was checked'),
      ].filter(Boolean);
      const sumEl = el.querySelector('.sum');
      sumEl.textContent = first;
      for (const x of extra) { const d = document.createElement('div'); d.className = 'flag'; d.textContent = x; sumEl.appendChild(d); }
      if (!first && !extra.length) sumEl.remove();
    } else el.querySelector('.sum').remove();
el.querySelector('.hint').textContent = ''; el.querySelector('[data-act="add"]').title = T.hint;
    const ta = el.querySelector('textarea'); ta.placeholder = T.placeholder; ta.value = existing?.text || '';
    const sug = el.querySelector('.suggest');
    if (planComment) { el.querySelector('b').textContent = `Plan: ${label}`; ta.placeholder = 'Ask a question or say what should change'; }
    if (!existing && !planComment) for (const [lbl, prompt] of T.suggest) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = lbl;
      b.onclick = () => { ta.value = prompt; ta.focus(); };
      sug.appendChild(b);
    } else sug.remove();
    slot.appendChild(el);
    // position: below the target, kept inside the viewport
    const r = rect || docRect(target.getBoundingClientRect());
    const w = 360; const vw = document.documentElement.clientWidth;
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
      if (act === 'add') finish(planComment);
      else if (act === 'details') peek(target);
      else if (act === 'comment') { el.classList.remove('viewing'); el.setAttribute('aria-label', 'Comment'); ta.focus({ preventScroll: true }); }
      else if (act === 'cancel') closeCard();
      else if (act === 'remove') { removeNote(noteId, true); closeCard(); }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCard(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(e.ctrlKey || e.metaKey); }
    });
    if (!view) setTimeout(() => ta.focus({ preventScroll: true }), 0);
    else el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCard(); } });
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
    const t = e.target instanceof Element ? e.target : null;
    if (!annotating) {
      // Reading mode: hovering a box lights up its own wires.
      const box = t?.closest('.tm-map .tm-node, .tm-blueprint .tm-node') || null;
      if (box !== hotBox) { hotBox = box; markWires(); }
      return;
    }
    if (card) return;
    setHover(annotTarget(t));
  }, { passive: true });
  document.addEventListener('mouseleave', () => { setHover(null); if (hotBox) { hotBox = null; markWires(); } });

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (e.composedPath().includes(host)) return;
    const t = e.target instanceof Element ? e.target : null;
    if (card) { closeCard(); if (!annotating) return; }
    if (!t) return;
    // A flow button lights up a whole path across the map (works in both modes).
    const flow = t.closest('[data-tm-flow]');
    if (flow) {
      e.preventDefault(); e.stopPropagation();
      const ids = flow.getAttribute('data-tm-flow').split(/[\s,]+/).filter(Boolean);
      const same = focusSet.length && ids.every((id) => focusSet.some((el) => el.id === id));
      if (same) clearFocus(); else applyFocus(ids, flow.getAttribute('data-note') || '', clean(flow.textContent, 60));
      for (const b of document.querySelectorAll('[data-tm-flow]')) b.setAttribute('aria-pressed', String(!same && b === flow));
      return;
    }
    if (!annotating) {
      // A box opens the inspector (what it is, its code, its connections). Real links and controls inside work as usual.
      const box = t.closest(boxSel);
      const inner = t.closest('a[href],button,input,select,textarea,label,summary,.tm-ask,[role=tab]');
      if (String(getSelection?.() || '').trim().length > 1) return;
      if (!box) {
        // Empty space: back to the plain map.
        if (!inner) {
          if (focusSet.length || focusNote) { clearFocus(); post({ type: 'focus-cleared' }); }
          if (selected) { select(null); post({ type: 'deselect' }); }
          for (const fig of document.querySelectorAll('figure.tm-diagram[data-flow]')) window.truemapDiagram?.setFlow(fig, null);
        }
        return;
      }
      if (inner && inner !== box && box.contains(inner)) return;
      e.preventDefault(); e.stopPropagation();
      openBox(box);
      return;
    }
    if (String(getSelection?.() || '').trim().length > 1) return;
    const el = annotTarget(t);
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const existing = [...notes.values()].find((n) => n.el === el);
    openCard({ target: el, noteId: existing?.id || null });
  }, true);

  // A double click on a box goes straight to writing a comment (a single click only looks).
  document.addEventListener('dblclick', (e) => {
    if (!e.isTrusted || e.composedPath().includes(host)) return;
    const t = e.target instanceof Element ? e.target : null;
    const box = t?.closest(boxSel);
    if (!box || t.closest('a[href],button,input,select,textarea,label,summary,.tm-ask,[role=tab]')) return;
    e.preventDefault();
    getSelection()?.removeAllRanges();
    cardFor(box);
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

  // Escape anywhere in the page closes the inspector and the workspace's menus.
  document.addEventListener('mouseup', (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); post({ type: 'nav', dir: e.button === 3 ? 'back' : 'forward' }); } }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { select(null); post({ type: 'press' }); for (const fig of document.querySelectorAll('figure.tm-diagram[data-flow]')) window.truemapDiagram?.setFlow(fig, null); }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); post({ type: 'nav', dir: e.key === 'ArrowLeft' ? 'back' : 'forward' }); return; }
    const typing = e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]');
    if (e.key === 'Escape' && card) { closeCard(); return; }
    if (e.key === 'Escape' && (focusSet.length || focusNote)) { clearFocus(); post({ type: 'focus-cleared' }); return; }
    if ((e.key === 'Enter' || e.key === ' ') && !annotating && e.target instanceof Element && e.target.matches?.('.tm-node, .tm-step') && !typing) { e.preventDefault(); cardFor(e.target); return; }
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
    } else if (d.type === 'focus') {
      applyFocus(d.items, d.note, d.who, d.scroll === undefined ? 'center' : d.scroll, !!d.transient);
    } else if (d.type === 'select') {
      select(d.id ? document.getElementById(d.id) : null);
    } else if (d.type === 'plan') {
      planNow = d.plan || null;
      // A plan drawn on the map: what it touches, adds (dashed, in its group) and removes.
      for (const el of document.querySelectorAll('[data-plan-overlay], [data-plan-revised]')) { el.removeAttribute('data-plan'); el.removeAttribute('data-plan-note'); el.removeAttribute('data-plan-overlay'); el.removeAttribute('data-plan-revised'); }
      clearFocus();
      const p = d.plan;
      document.documentElement.toggleAttribute('data-tm-plan', !!p);
      const fig = document.querySelector('figure.tm-diagram');
      if (fig && window.truemapDiagram?.setGhosts) window.truemapDiagram.setGhosts(fig, p ? p.add : []);
      else if (p) post({ type: 'plan-unsupported' }); // an old-format map: the plan can't be drawn on it
      const markPlan = (box, kind, note) => {
        const el = findItems([box])[0];
        if (!el || el.getAttribute('data-plan') === 'new') return;
        el.setAttribute('data-plan', kind); el.setAttribute('data-plan-overlay', ''); if (note) el.setAttribute('data-plan-note', note);
      };
      if (p) { for (const t of p.touch || []) markPlan(t.box, 'change', t.what); for (const r of p.remove || []) markPlan(r.box, 'remove', r.why); }
      for (const id of p?.revised || []) findItems([id])[0]?.setAttribute('data-plan-revised', '');
      setTimeout(placePlanAct, 60);
      for (const b of document.querySelectorAll('.tm-node, .tm-step')) { if (!b.hasAttribute('tabindex') && !b.matches('a[href]')) b.setAttribute('tabindex', '0'); }
      markWires();
    } else if (d.type === 'changes') {
      // Review mode: changed boxes carry their +/- lines; the rest of the map goes quiet.
      document.documentElement.toggleAttribute('data-tm-changes', !!d.on);
      for (const el of document.querySelectorAll('[data-tm-change], [data-tm-unbuilt]')) { el.removeAttribute('data-tm-change'); el.removeAttribute('data-tm-delta'); el.removeAttribute('data-tm-unbuilt'); el.removeAttribute('data-tm-new'); }
      for (const u of d.unbuilt || []) { const el = findItems([u.src || u.box, u.box])[0]; if (el) el.setAttribute('data-tm-unbuilt', ''); }
      const names = [];
      for (const it of d.items || []) {
        for (const el of document.querySelectorAll('[data-src]')) {
          if (el.getAttribute('data-src') !== it.src) continue;
          el.setAttribute('data-tm-change', '');
          el.setAttribute('data-tm-delta', (it.isNew ? 'New ' : '') + (it.add == null ? 'binary' : [it.add ? '+' + it.add : '', it.del ? '−' + it.del : ''].filter(Boolean).join(' ') || '±0'));
          el.toggleAttribute('data-tm-new', !!it.isNew);
          names.push({ src: it.src, name: clean(el.getAttribute('data-name'), 60) || labelOf(el) });
        }
      }
      if (names.length) post({ type: 'changes-names', items: names });
    } else if (d.type === 'open-box') {
      const el = d.id ? document.getElementById(d.id) : [...document.querySelectorAll('[data-src]')].find((x) => x.getAttribute('data-src') === d.src);
      if (el) { reveal([el], 'nearest'); select(el); peek(el); }
    } else if (d.type === 'clear-focus') {
      clearFocus();
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

  window.truemapDiagram?.interact();
  const ready = () => {
    drawWires();
    // index.html#runs: arriving from a draft's box link lights that box on the map
    const hashId = decodeURIComponent((location.hash || '').slice(1));
    if (hashId && /^[\w-]+$/.test(hashId) && document.getElementById(hashId)) setTimeout(() => applyFocus([hashId], '', '', 'center'), 250);
    // Boxes are reachable from the keyboard too.
    for (const b of document.querySelectorAll('.tm-node, .tm-step')) { if (!b.hasAttribute('tabindex') && !b.matches('a[href]')) b.setAttribute('tabindex', '0'); }
    if ('ResizeObserver' in window) new ResizeObserver(scheduleWires).observe(document.body);
    document.fonts?.ready?.then(scheduleWires);
    const meta = document.querySelector('meta[name="truemap-annotate"]')?.getAttribute('content');
    post({ type: 'loaded', page: pagePath(), title: document.title || '', annotate: meta ? /^(on|true|1)$/i.test(meta) : null });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
