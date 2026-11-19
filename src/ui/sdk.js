// Injected into every .truemap page by the local server (never saved into the page file).
// Runs inside a sandboxed iframe: click/select = context for the chat, decision forms = answers,
// and shows check marks on elements whose data-src no longer matches the code.
(() => {
  if (window.__truemapSdk) return;
  window.__truemapSdk = true;
  const parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  const PARENT = '__TRUEMAP_PARENT__';
  const post = (msg) => parentWin.postMessage({ __truemap: true, ...msg }, PARENT);
  const T = { sent: 'Sent ✓', changed: 'Code changed after this page was written', broken: 'The code this points to is gone' };

  const style = document.createElement('style');
  style.textContent = `
    [data-src] { cursor: pointer; }
    [data-src]:hover { outline: 1.5px solid color-mix(in oklab, #2c5a8c 45%, transparent); outline-offset: 3px; }
    [data-tm-selected] { outline: 2px solid #2c5a8c !important; outline-offset: 3px; border-radius: 4px; }
    svg [data-tm-selected] { outline: none !important; filter: drop-shadow(0 0 3px #2c5a8c) drop-shadow(0 0 1px #2c5a8c); }
    [data-tm-mark="changed"] { outline: 2px dashed #9c6c12 !important; outline-offset: 3px; }
    [data-tm-mark="broken"] { outline: 2px dashed #a23b2c !important; outline-offset: 3px; }
    svg [data-tm-mark="changed"] { outline: none !important; filter: drop-shadow(0 0 3px #9c6c12); }
    svg [data-tm-mark="broken"] { outline: none !important; filter: drop-shadow(0 0 3px #a23b2c); }
    @keyframes tm-flash { 0%,100% { outline-color: transparent } 30% { outline-color: #2c5a8c } }
    [data-tm-flash] { outline: 3px solid #2c5a8c; outline-offset: 4px; animation: tm-flash 1.2s ease 2; }
  `;
  (document.head || document.documentElement).appendChild(style);

  const pagePath = () => decodeURIComponent(location.pathname.replace(/^\/pages\//, ''));
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[contenteditable],[role=button],[data-tm-action]';

  function labelOf(el) {
    return clean(el.getAttribute('data-label') || el.getAttribute('aria-label') || el.getAttribute('title')
      || el.querySelector?.('.tm-node-title,h1,h2,h3,h4,strong,b')?.textContent || el.textContent, 60) || el.tagName.toLowerCase();
  }

  function pickTarget(t) {
    const anchored = t.closest('[data-src]');
    if (anchored) return anchored;
    const block = t.closest('h1,h2,h3,h4,h5,h6,p,li,td,th,figure,pre,blockquote,.tm-card,.tm-node,.tm-step,.tm-callout,.tm-ask,section,article');
    if (block && block !== document.body) return block;
    return null;
  }

  let selected = [];
  function setSelected(list) {
    for (const el of selected) el.removeAttribute('data-tm-selected');
    selected = list;
    for (const el of selected) el.setAttribute('data-tm-selected', '');
    post({
      type: 'select',
      page: pagePath(),
      items: selected.map((el) => ({
        kind: 'element', label: labelOf(el), src: el.closest('[data-src]')?.getAttribute('data-src') || '',
        excerpt: clean(el.innerText || el.textContent, 400),
      })),
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest(INTERACTIVE)) return;
    if (String(window.getSelection?.() || '').trim().length > 1) return; // text selection handled on mouseup
    const el = pickTarget(t);
    if (!el) { if (!e.ctrlKey && !e.metaKey) setSelected([]); return; }
    if (e.ctrlKey || e.metaKey) {
      setSelected(selected.includes(el) ? selected.filter((x) => x !== el) : [...selected, el]);
    } else {
      setSelected(selected.length === 1 && selected[0] === el ? [] : [el]);
    }
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!e.isTrusted) return;
    setTimeout(() => {
      const sel = window.getSelection?.();
      const text = clean(sel?.toString(), 600);
      if (!text || text.length < 2) return;
      const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      post({ type: 'select-text', page: pagePath(), item: { kind: 'text', label: clean(text, 60), src: node?.closest?.('[data-src]')?.getAttribute('data-src') || '', excerpt: text } });
    }, 0);
  });

  // Decision forms: <form class="tm-ask" data-tm-ask="question"> … <button type="submit">
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-tm-ask')) return;
    e.preventDefault();
    const fd = new FormData(form);
    const values = {};
    let note = '';
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
    if (btn && !btn.dataset.tmLabel) { btn.dataset.tmLabel = btn.textContent; }
    if (btn) btn.textContent = T.sent;
    post({ type: 'answer', page: pagePath(), trusted: e.isTrusted, question, choice, note, src: form.closest('[data-src]')?.getAttribute('data-src') || '' });
  }, true);

  // Pages may also talk to the agent directly (marked as coming from the page, not the user).
  window.truemap = { send: (text) => post({ type: 'page-send', page: pagePath(), text: clean(text, 4000) }) };

  window.addEventListener('message', (e) => {
    if (e.source !== parentWin || e.origin !== PARENT || !e.data || !e.data.__truemap) return;
    const d = e.data;
    if (d.type === 'marks') {
      document.querySelectorAll('[data-tm-mark]').forEach((el) => { el.removeAttribute('data-tm-mark'); });
      for (const m of d.items || []) {
        document.querySelectorAll('[data-src]').forEach((el) => {
          if (el.getAttribute('data-src') !== m.src) return;
          el.setAttribute('data-tm-mark', m.state);
          if (!el.hasAttribute('title')) el.setAttribute('title', m.state === 'broken' ? T.broken : T.changed);
        });
      }
    } else if (d.type === 'scroll') {
      window.scrollTo(0, d.y || 0);
    } else if (d.type === 'clear-selection') {
      setSelected([]);
    } else if (d.type === 'highlight') {
      const el = [...document.querySelectorAll('[data-src]')].find((x) => x.getAttribute('data-src') === d.src);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.setAttribute('data-tm-flash', ''); setTimeout(() => el.removeAttribute('data-tm-flash'), 2600); }
    }
  });

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => post({ type: 'scroll', page: pagePath(), y: window.scrollY }), 120);
  }, { passive: true });

  const ready = () => post({ type: 'loaded', page: pagePath(), title: document.title || '' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
