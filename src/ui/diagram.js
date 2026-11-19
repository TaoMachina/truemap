// truemap diagrams: the agent declares groups, nodes and edges; this lays them out (dagre, left to right) and
// draws them. Used by the page SDK and by exported pages. Plain script; needs window.dagre.
//
//   <figure class="tm-diagram" data-direction="LR">
//     <section class="tm-group" id="core" data-label="Hub core">
//       <div class="tm-node" id="runs" data-name="Runs" data-tag="routing" data-src="server/routing.ts#Runs"
//            data-to="acp:execute store:writes">
//         <div class="tm-detail">…shown in the inspector…</div>
//       </div>
//     </section>
//     <ol class="tm-flows"><li data-path="web api runs acp" data-note="…">A message reaches an agent</li></ol>
//   </figure>
(() => {
  if (window.truemapDiagram) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const viaOf = (s) => s.replace(/\\_/g, '\u0001').replace(/_/g, ' ').replace(/\u0001/g, '_');
  const textOf = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim();

  function nameOf(n) {
    return n.getAttribute('data-name') || n.querySelector(':scope > b, :scope > strong')?.textContent.trim() || textOf(n) || n.id;
  }

  // Turn the declared markup into the drawable structure once.
  function prepare(fig) {
    if (fig.__tm) return fig.__tm;
    const stage = document.createElement('div'); stage.className = 'tm-dg-stage';
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'tm-dg-edges'); svg.setAttribute('aria-hidden', 'true');
    stage.appendChild(svg);
    const groups = [];
    const nodes = [];
    const take = (n, group) => {
      n.dataset.group = group?.id || '';
      const name = nameOf(n);
      const detail = n.querySelector(':scope > .tm-detail');
      // the visible face of the node: name and an optional tag; the rest stays for the inspector
      for (const c of [...n.childNodes]) if (c !== detail) c.remove();
      const face = document.createElement('span'); face.className = 'tm-dg-face';
      face.innerHTML = '<span class="tm-dg-name"></span>';
      face.firstChild.textContent = name;
      if (n.dataset.tag) { const t = document.createElement('span'); t.className = 'tm-dg-tag'; t.textContent = n.dataset.tag; face.appendChild(t); }
      n.insertBefore(face, n.firstChild);
      n.dataset.name = name;
      nodes.push(n); stage.appendChild(n);
    };
    for (const sec of [...fig.querySelectorAll(':scope > .tm-group')]) {
      if (!sec.id) sec.id = `g-${groups.length}`;
      const box = document.createElement('div'); box.className = 'tm-dg-group'; box.dataset.group = sec.id;
      const label = document.createElement('span'); label.className = 'tm-dg-glabel'; label.textContent = sec.getAttribute('data-label') || '';
      box.appendChild(label);
      stage.insertBefore(box, svg.nextSibling);
      groups.push({ id: sec.id, el: box });
      for (const n of [...sec.querySelectorAll(':scope > .tm-node')]) take(n, sec);
      sec.remove();
    }
    for (const n of [...fig.querySelectorAll(':scope > .tm-node')]) take(n, null);
    // flows become tabs above the drawing
    const flowsList = fig.querySelector(':scope > .tm-flows');
    let tabs = null;
    if (flowsList) {
      tabs = document.createElement('div'); tabs.className = 'tm-dg-tabs'; tabs.setAttribute('role', 'tablist');
      for (const li of flowsList.querySelectorAll(':scope > li')) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tm-dg-tab'; b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', 'false');
        b.setAttribute('data-path', li.getAttribute('data-path') || '');
        b.setAttribute('data-note', li.getAttribute('data-note') || '');
        b.textContent = li.getAttribute('data-title') || li.textContent.trim();
        tabs.appendChild(b);
      }
      flowsList.remove();
    }
    if (tabs) fig.appendChild(tabs);
    fig.appendChild(stage);
    fig.__tm = { stage, svg, groups, nodes, tabs };
    return fig.__tm;
  }

  // A smooth curve through dagre's bend points.
  function curve(pts) {
    if (pts.length < 3) return `M${pts[0].x},${pts[0].y} L${pts[pts.length - 1].x},${pts[pts.length - 1].y}`;
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2; const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q${pts[i].x},${pts[i].y} ${i === pts.length - 2 ? pts[i + 1].x : mx},${i === pts.length - 2 ? pts[i + 1].y : my}`;
    }
    return d;
  }

  // One dagre run. Labels are not layout nodes (that doubles the ranks and the width); instead the gap
  // between ranks is wide enough for the longest label when ranks run left to right.
  function run(m, edges, dir, labelW) {
    const g = new window.dagre.graphlib.Graph({ compound: true, multigraph: true });
    const ranksep = dir === 'LR' || dir === 'RL' ? Math.max(56, Math.min(150, labelW + 30)) : 54;
    g.setGraph({ rankdir: dir, nodesep: dir === 'LR' || dir === 'RL' ? 18 : 28, ranksep, edgesep: 12, marginx: 16, marginy: 38, ranker: 'network-simplex' });
    g.setDefaultEdgeLabel(() => ({}));
    for (const gr of m.groups) g.setNode(`g:${gr.id}`, {});
    for (const n of m.nodes) {
      g.setNode(n.id, { width: n.offsetWidth, height: n.offsetHeight });
      if (n.dataset.group) g.setParent(n.id, `g:${n.dataset.group}`);
    }
    for (const e of edges) g.setEdge(e.back ? e.to : e.from, e.back ? e.from : e.to, { minlen: 1 }, e.name);
    window.dagre.layout(g);
    return g;
  }

  function layout(fig) {
    const m = prepare(fig);
    if (!window.dagre) return;
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    // The author's order is the reading order: groups left to right (or top to bottom), nodes inside a
    // group in order. An edge that points back against it is a callback; it never pulls a box forward.
    const gIndex = new Map(m.groups.map((gr, i) => [gr.id, i]));
    const order = (n) => (gIndex.get(n.dataset.group) ?? m.groups.length) * 1000 + m.nodes.indexOf(n);
    const probe = document.createElement('span'); probe.className = 'tm-dg-label tm-dg-probe'; m.stage.appendChild(probe);
    const edges = [];
    let labelW = 0;
    for (const src of m.nodes) {
      for (const spec of (src.getAttribute('data-to') || '').split(/[\s,]+/).filter(Boolean)) {
        const [id, ...lab] = spec.split(':');
        if (!byId.has(id) || id === src.id) continue;
        const label = viaOf(lab.join(':'));
        if (label) { probe.textContent = label; labelW = Math.max(labelW, probe.offsetWidth); }
        edges.push({ from: src.id, to: id, label, name: `${src.id}>${id}`, back: order(src) > order(byId.get(id)) });
      }
    }
    probe.remove();
    // Direction: the author's, or left to right when it fits the column, else top to bottom.
    const room = fig.clientWidth || 860;
    const asked = (fig.getAttribute('data-direction') || '').toUpperCase();
    let g = run(m, edges, asked || 'LR', labelW);
    if (!asked && g.graph().width > room) {
      const tb = run(m, edges, 'TB', labelW);
      if (tb.graph().width < g.graph().width) g = tb;
    }
    fig.dataset.laidOut = g.graph().rankdir;
    fig.dataset.widths = `${g.graph().width}/${room}`;

    // nodes
    for (const n of m.nodes) {
      const v = g.node(n.id);
      n.style.left = `${v.x - v.width / 2}px`; n.style.top = `${v.y - v.height / 2}px`;
    }
    // groups: the cluster box, with room for its label
    for (const gr of m.groups) {
      const v = g.node(`g:${gr.id}`);
      if (!v || !v.width) { gr.el.hidden = true; continue; }
      gr.el.hidden = false;
      gr.box = { l: v.x - v.width / 2 - 6, t: v.y - v.height / 2 - 30, w: v.width + 12, h: v.height + 36 };
      Object.assign(gr.el.style, { left: `${gr.box.l}px`, top: `${gr.box.t}px`, width: `${gr.box.w}px`, height: `${gr.box.h}px` });
    }
    const gw = g.graph().width; const gh = g.graph().height;
    m.stage.style.width = `${gw + 8}px`; m.stage.style.height = `${gh + 8}px`;
    // edges
    const svg = m.svg; svg.innerHTML = '';
    svg.setAttribute('width', gw + 8); svg.setAttribute('height', gh + 8); svg.setAttribute('viewBox', `0 0 ${gw + 8} ${gh + 8}`);
    for (const lab of m.stage.querySelectorAll('.tm-dg-label')) lab.remove();
    const isKey = (id) => byId.get(id)?.classList.contains('is-key');
    const placed = [];
    for (const e of edges) {
      const ed = g.edge({ v: e.back ? e.to : e.from, w: e.back ? e.from : e.to, name: e.name });
      if (!ed?.points?.length) continue;
      const pts = ed.points.slice();
      if (e.back) pts.reverse();
      // stop short of the target so the arrowhead sits outside the box
      const a = pts[pts.length - 2]; const b = pts[pts.length - 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const tip = { x: b.x, y: b.y }; pts[pts.length - 1] = { x: b.x - ((b.x - a.x) / len) * 7, y: b.y - ((b.y - a.y) / len) * 7 };
      const key = isKey(e.from) && isKey(e.to);
      const ext = byId.get(e.from)?.classList.contains('is-ext') || byId.get(e.to)?.classList.contains('is-ext');
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', curve(pts));
      path.setAttribute('class', `tm-dg-edge${key ? ' is-main' : ''}${ext ? ' is-ext' : ''}${e.back ? ' is-back' : ''}`);
      const ux = (tip.x - a.x) / len; const uy = (tip.y - a.y) / len;
      const head = document.createElementNS(SVGNS, 'path');
      head.setAttribute('d', `M${tip.x},${tip.y} L${tip.x - ux * 7 - uy * 4},${tip.y - uy * 7 + ux * 4} L${tip.x - ux * 7 + uy * 4},${tip.y - uy * 7 - ux * 4} Z`);
      head.setAttribute('class', `tm-dg-head${key ? ' is-main' : ''}`);
      for (const el of [path, head]) { el.dataset.from = e.from; el.dataset.to = e.to; }
      svg.appendChild(path); svg.appendChild(head);
      if (e.label) placed.push({ e, path, key });
    }
    const boxes = m.nodes.map((n) => { const v = g.node(n.id); return { l: v.x - v.width / 2 - 3, r: v.x + v.width / 2 + 3, t: v.y - v.height / 2 - 3, b: v.y + v.height / 2 + 3 }; });
    const taken = [];
    const hits = (a, list) => list.some((o) => a.l < o.r && a.r > o.l && a.t < o.b && a.b > o.t);
    // points along every edge, so a group label can keep off the wires
    const dots = [];
    for (const p of svg.querySelectorAll('.tm-dg-edge')) { const L = p.getTotalLength(); for (let d = 0; d <= L; d += 5) { const q = p.getPointAtLength(d); dots.push({ l: q.x - 1, r: q.x + 1, t: q.y - 1, b: q.y + 1 }); } }
    const crowd = (r) => (hits(r, boxes) ? 100 : 0) + (hits(r, taken) ? 100 : 0) + dots.filter((o) => r.l < o.r && r.r > o.l && r.t < o.b && r.b > o.t).length;
    for (const gr of m.groups) {
      if (!gr.box) continue;
      const lab = gr.el.firstChild; lab.style.left = '0px'; lab.style.top = '0px';
      const w = lab.offsetWidth + 6; const h = lab.offsetHeight + 4; const { l, t, w: W, h: H } = gr.box;
      const spots = [[l + 10, t + 6], [l + W - 10 - w, t + 6], [l + 10, t + H - 6 - h], [l + W - 10 - w, t + H - 6 - h]];
      let best = null; let bestScore = Infinity;
      for (const [x, y] of spots) { const r = { l: x, r: x + w, t: y, b: y + h }; const sc = crowd(r); if (sc < bestScore) { best = r; bestScore = sc; } if (!sc) break; }
      lab.style.left = `${best.l - l + 3}px`; lab.style.top = `${best.t - t + 2}px`;
      taken.push(best);
    }
    // Edge labels sit on their own edge, at the first spot along it that covers no box and no other label.
    // The same word on several edges from one box is said once, on the most important of them.
    const seen = new Set();
    placed.sort((x, y) => (y.key - x.key));
    for (const pl of placed) { const k = `${pl.e.from}|${pl.e.label}`; pl.dup = seen.has(k); seen.add(k); }
    for (const { e, path, key, dup } of placed) {
      const t = document.createElement('span'); t.className = `tm-dg-label${key ? ' is-main' : ''}${dup ? ' is-dup' : ''}`; t.textContent = e.label;
      t.dataset.from = e.from; t.dataset.to = e.to;
      m.stage.appendChild(t);
      const w = t.offsetWidth; const h = t.offsetHeight; const L = path.getTotalLength();
      let best = null;
      for (const f of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82]) {
        const p = path.getPointAtLength(L * f);
        const r = { l: p.x - w / 2, r: p.x + w / 2, t: p.y - h / 2, b: p.y + h / 2 };
        if (!best) best = r;
        if (!hits(r, boxes) && !hits(r, taken)) { best = r; break; }
      }
      if (!dup) taken.push(best);
      t.style.left = `${(best.l + best.r) / 2}px`; t.style.top = `${(best.t + best.b) / 2}px`;
    }
    // main-path edges on top
    for (const el of [...svg.querySelectorAll('.is-main')]) svg.appendChild(el);
    // Still wider than the column: shrink a little, then scroll rather than make text unreadable.
    const k = Math.max(0.82, Math.min(1, room / (gw + 8)));
    m.stage.style.transform = k < 1 ? `scale(${k})` : '';
    m.stage.style.marginBottom = k < 1 ? `${-(gh + 8) * (1 - k)}px` : '';
    fig.classList.toggle('is-wide', (gw + 8) * k > room + 1);
    markFlow(fig);
  }

  // A lit flow: numbered steps in order along its edges; the other boxes keep their shape, only their text dims.
  function markFlow(fig) {
    const m = fig.__tm; if (!m) return;
    for (const b of m.stage.querySelectorAll('.tm-dg-step')) b.remove();
    const active = m.tabs?.querySelector('[aria-selected="true"]');
    const ids = active ? active.getAttribute('data-path').split(/[\s,]+/).filter(Boolean) : [];
    fig.toggleAttribute('data-flow', ids.length > 0);
    const on = new Set(ids);
    for (const n of m.nodes) n.toggleAttribute('data-in-flow', on.has(n.id));
    const pairs = new Map(); ids.forEach((id, i) => { if (i < ids.length - 1) pairs.set(`${id}>${ids[i + 1]}`, i + 1); });
    for (const el of m.stage.querySelectorAll('.tm-dg-edge, .tm-dg-head, .tm-dg-label')) {
      const k = `${el.dataset.from}>${el.dataset.to}`;
      el.classList.toggle('is-flow', pairs.has(k));
    }
    // step numbers sit on the edge's midpoint (or on its label)
    for (const [k, n] of pairs) {
      const p = m.svg.querySelector(`.tm-dg-edge[data-from="${CSS.escape(k.split('>')[0])}"][data-to="${CSS.escape(k.split('>')[1])}"]`);
      if (!p) continue;
      const [from, to] = k.split('>');
      const lab = [...m.stage.querySelectorAll('.tm-dg-label')].find((l) => l.dataset.from === from && l.dataset.to === to);
      const s = document.createElement('span'); s.className = 'tm-dg-step'; s.textContent = String(n);
      if (lab) { // the number leads its label
        s.style.left = `${parseFloat(lab.style.left) - lab.offsetWidth / 2 - 11}px`; s.style.top = lab.style.top;
      } else {
        const mid = p.getPointAtLength(p.getTotalLength() / 2);
        s.style.left = `${mid.x}px`; s.style.top = `${mid.y}px`;
      }
      m.stage.appendChild(s);
    }
    const note = m.tabs && fig.querySelector(':scope > .tm-dg-note');
    if (active && active.getAttribute('data-note')) {
      const el = note || document.createElement('p');
      el.className = 'tm-dg-note'; el.textContent = active.getAttribute('data-note');
      if (!note) m.tabs.after(el);
    } else note?.remove();
  }

  function draw() {
    for (const fig of document.querySelectorAll('figure.tm-diagram')) {
      try { layout(fig); } catch (e) { console.warn('truemap diagram:', e); }
    }
  }
  function setFlow(fig, btn) {
    const m = fig.__tm; if (!m?.tabs) return;
    const was = btn?.getAttribute('aria-selected') === 'true';
    for (const b of m.tabs.querySelectorAll('.tm-dg-tab')) b.setAttribute('aria-selected', String(!!btn && b === btn && !was));
    markFlow(fig);
  }
  // Generic hover and tab handling (the SDK adds the inspector; exported pages get this alone).
  function interact() {
    document.addEventListener('click', (e) => {
      const tab = e.target.closest?.('.tm-dg-tab');
      if (tab) { setFlow(tab.closest('figure.tm-diagram'), tab); return; }
      const fig = e.target.closest?.('figure.tm-diagram');
      if (fig && !e.target.closest('.tm-node, .tm-dg-tabs')) setFlow(fig, null); // empty space returns to the plain map
    });
    let hot = null;
    document.addEventListener('mouseover', (e) => {
      const n = e.target.closest?.('figure.tm-diagram .tm-node') || null;
      if (n === hot) return; hot = n;
      for (const el of document.querySelectorAll('.tm-dg-edge, .tm-dg-head, .tm-dg-label')) {
        el.classList.toggle('is-hot', !!n && (el.dataset.from === n.id || el.dataset.to === n.id));
      }
    });
  }
  window.truemapDiagram = { draw, interact, setFlow, nameOf };
})();
