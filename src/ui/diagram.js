// truemap diagrams: the agent declares groups, nodes and edges; this lays them out (layered, groups as bands)
// and draws them. Used by the page SDK and by exported pages. Plain script, no dependencies.
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

  // A node element becomes drawable: its face is the name and an optional tag; the detail stays for the inspector.
  function adopt(m, n, groupId) {
    n.dataset.group = groupId || '';
    const name = nameOf(n);
    const detail = n.querySelector(':scope > .tm-detail');
    for (const c of [...n.childNodes]) if (c !== detail) c.remove();
    const face = document.createElement('span'); face.className = 'tm-dg-face';
    face.innerHTML = '<span class="tm-dg-name"></span>';
    face.firstChild.textContent = name;
    if (n.dataset.tag) { const t = document.createElement('span'); t.className = 'tm-dg-tag'; t.textContent = n.dataset.tag; face.appendChild(t); }
    n.insertBefore(face, n.firstChild);
    n.dataset.name = name;
    m.nodes.push(n); m.stage.appendChild(n);
  }

  // Turn the declared markup into the drawable structure once.
  function prepare(fig) {
    if (fig.__tm) return fig.__tm;
    const stage = document.createElement('div'); stage.className = 'tm-dg-stage';
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('class', 'tm-dg-edges'); svg.setAttribute('aria-hidden', 'true');
    stage.appendChild(svg);
    const groups = [];
    const nodes = [];
    const m0 = { stage, nodes };
    const take = (n, group) => adopt(m0, n, group?.id);
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
    fig.__tm = Object.assign(m0, { svg, groups, tabs });
    return fig.__tm;
  }

  // Orthogonal polyline with rounded corners.
  function roundPath(pts, r = 7) {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y); const l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const k = Math.min(r, l1 / 2, l2 / 2);
      if (k < 0.5) { d += ` L${b.x},${b.y}`; continue; }
      const p1 = { x: b.x - ((b.x - a.x) / l1) * k, y: b.y - ((b.y - a.y) / l1) * k };
      const p2 = { x: b.x + ((c.x - b.x) / l2) * k, y: b.y + ((c.y - b.y) / l2) * k };
      d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
    }
    const z = pts[pts.length - 1];
    return `${d} L${z.x},${z.y}`;
  }
  const simplify = (pts) => pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const a = pts[i - 1]; const c = pts[i + 1];
    if (Math.abs(a.x - p.x) < 0.5 && Math.abs(a.y - p.y) < 0.5) return false;
    return !((Math.abs(a.x - p.x) < 0.5 && Math.abs(p.x - c.x) < 0.5) || (Math.abs(a.y - p.y) < 0.5 && Math.abs(p.y - c.y) < 0.5));
  });

  // The layered layout, computed top to bottom ("rows"); left to right is the same picture turned.
  //  - Groups are bands of rows in the author's order: a group never shares a row with another, so groups
  //    never overlap or interleave.
  //  - Inside a group a box sits one row below the boxes that call it (longest path).
  //  - A connection that skips rows reserves a narrow slot in each row it crosses.
  //  - Order within rows: barycenter sweeps, keeping the order with the fewest crossings.
  //  - Positions: as close to the connected boxes as the ordering and spacing allow (block merging).
  //  - Connections run only through the gaps between rows and through their reserved slots, so they
  //    never cross a box.
  function layered(m, edges, dir, labelW) {
    const lr = dir === 'LR';
    const nodes = m.nodes;
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const S = nodes.map((n) => (lr ? { w: n.offsetHeight, h: n.offsetWidth } : { w: n.offsetWidth, h: n.offsetHeight }));
    const NODESEP = lr ? 18 : 24; const SLOT = 12;
    // Top to bottom, groups are swimlanes with their label in a left gutter; left to right, columns with
    // the label above the boxes.
    const gutter = Math.max(72, ...m.groups.map((gr) => (gr.el.firstChild?.offsetWidth || 0) + 30));
    const GAP = lr ? Math.max(60, Math.min(170, labelW + 48)) : 44;
    const HEAD = 0; const BANDPAD = lr ? 12 : 12; const GAPB = lr ? 14 : 12;
    const MX = lr ? 34 : gutter; const MY = lr ? 6 : 4;
    const gOf = nodes.map((n) => { const k = m.groups.findIndex((gr) => gr.id === n.dataset.group); return k < 0 ? m.groups.length : k; });
    const E = edges.map((e) => ({ e, a: idx.get(e.back ? e.to : e.from), b: idx.get(e.back ? e.from : e.to) }));
    // 1. rows
    const rank = new Array(nodes.length).fill(0);
    const bands = [];
    let base = 0;
    for (const g of [...new Set(gOf)].sort((x, y) => x - y)) {
      const members = nodes.map((_, i) => i).filter((i) => gOf[i] === g);
      const local = new Map(members.map((i) => [i, 0]));
      for (const i of members) for (const x of E) if (x.a === i && gOf[x.b] === g) local.set(x.b, Math.max(local.get(x.b), local.get(i) + 1));
      let top = base;
      for (const i of members) { rank[i] = base + local.get(i); top = Math.max(top, rank[i]); }
      bands.push({ g, from: base, to: top });
      base = top + 1;
    }
    const R = base;
    const rows = Array.from({ length: R }, () => []);
    const item = nodes.map((_, i) => { const it = { node: i, w: S[i].w, h: S[i].h, order: i }; rows[rank[i]].push(it); return it; });
    for (const x of E) {
      x.chain = [item[x.a]];
      for (let r = rank[x.a] + 1; r < rank[x.b]; r++) { const d = { dummy: x, w: SLOT, h: 0, order: x.a + 0.5, row: r }; rows[r].push(d); x.chain.push(d); }
      x.chain.push(item[x.b]);
    }
    for (let r = 0; r < R; r++) for (const it of rows[r]) it.row = r;
    const up = new Map(); const down = new Map();
    const link = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    for (const x of E) for (let k = 0; k + 1 < x.chain.length; k++) { link(down, x.chain[k], x.chain[k + 1]); link(up, x.chain[k + 1], x.chain[k]); }
    // 2. order within rows
    const number = () => { for (const row of rows) row.forEach((it, k) => { it.k = k; }); };
    for (const row of rows) row.sort((p, q) => p.order - q.order);
    number();
    const crossings = () => {
      let c = 0;
      for (let r = 0; r + 1 < R; r++) {
        const segs = [];
        for (const it of rows[r]) for (const q of down.get(it) || []) segs.push([it.k, q.k]);
        for (let s = 0; s < segs.length; s++) for (let t = s + 1; t < segs.length; t++) if ((segs[s][0] - segs[t][0]) * (segs[s][1] - segs[t][1]) < 0) c++;
      }
      return c;
    };
    let best = rows.map((row) => row.slice()); let bestC = crossings();
    for (let iter = 0; iter < 16 && bestC > 0; iter++) {
      const downward = iter % 2 === 0;
      const seq = downward ? [...rows.keys()].slice(1) : [...rows.keys()].reverse().slice(1);
      for (const r of seq) {
        const nb = downward ? up : down;
        for (const it of rows[r]) { const ns = nb.get(it) || []; it.bc = ns.length ? ns.reduce((s, q) => s + q.k, 0) / ns.length : it.k; }
        rows[r].sort((p, q) => p.bc - q.bc || p.k - q.k);
        rows[r].forEach((it, k) => { it.k = k; });
      }
      const c = crossings();
      if (c < bestC) { bestC = c; best = rows.map((row) => row.slice()); }
    }
    for (let r = 0; r < R; r++) rows[r] = best[r];
    number();
    // 3. positions across the rows
    const sep = (p, q) => (p.dummy || q.dummy ? 10 : NODESEP);
    function settle(row, want) {
      const blocks = [];
      row.forEach((it, k) => {
        blocks.push({ items: [k], off: [0], sum: want[k], n: 1, pos: want[k] });
        while (blocks.length > 1) {
          const B = blocks[blocks.length - 1]; const A = blocks[blocks.length - 2];
          const la = row[A.items[A.items.length - 1]]; const fb = row[B.items[0]];
          const gap = la.w / 2 + sep(la, fb) + fb.w / 2;
          const aEnd = A.pos + A.off[A.off.length - 1];
          if (aEnd + gap <= B.pos + 0.01) break;
          const b0 = A.off[A.off.length - 1] + gap;
          for (let j = 0; j < B.items.length; j++) { A.items.push(B.items[j]); A.off.push(b0 + B.off[j]); }
          A.sum += B.sum - B.n * b0; A.n += B.n; A.pos = A.sum / A.n;
          blocks.pop();
        }
      });
      for (const b of blocks) b.items.forEach((k, j) => { row[k].x = b.pos + b.off[j]; });
    }
    for (const row of rows) { let x = 0; row.forEach((it, k) => { if (k) x += sep(row[k - 1], it); it.x = x + it.w / 2; x += it.w; }); const c = x / 2; for (const it of row) it.x -= c; }
    for (let it = 0; it < 10; it++) {
      const seq = it % 2 === 0 ? [...rows.keys()] : [...rows.keys()].reverse();
      for (const r of seq) {
        const want = rows[r].map((p) => {
          const ns = [...(up.get(p) || []), ...(down.get(p) || [])];
          return ns.length ? ns.reduce((s, q) => s + q.x, 0) / ns.length : p.x;
        });
        settle(rows[r], want);
      }
    }
    let minX = Infinity; let maxX = -Infinity;
    for (const row of rows) for (const it of row) { minX = Math.min(minX, it.x - it.w / 2); maxX = Math.max(maxX, it.x + it.w / 2); }
    for (const row of rows) for (const it of row) it.x += MX - minX;
    const W = maxX - minX + MX + 12;
    const rowH = rows.map((row) => Math.max(1, ...row.map((it) => it.h)));
    const bandOf = (r) => bands.find((b) => r >= b.from && r <= b.to);
    const ys = []; const gapAfter = []; let y = MY + (lr ? 0 : BANDPAD);
    for (let r = 0; r < R; r++) {
      const b = bandOf(r);
      if (b.from === r) y += HEAD;
      ys[r] = y + rowH[r] / 2; y += rowH[r];
      if (r + 1 < R) { const g = bandOf(r + 1) !== b ? BANDPAD * 2 + GAPB : GAP; gapAfter[r] = { top: y, bottom: y + g }; y += g; }
    }
    y += BANDPAD + MY;
    const H = y;
    // 4. routes
    const out = new Map(); const inc = new Map();
    for (const x of E) {
      x.label = x.e.label; x.bundle = `${x.a}|${x.e.back ? '<' : '>'}|${x.label}`;
      if (!out.has(x.a)) out.set(x.a, []); out.get(x.a).push(x);
      if (!inc.has(x.b)) inc.set(x.b, []); inc.get(x.b).push(x);
    }
    const portX = (it, list, keyOf, otherX) => {
      const keys = [...new Set(list.map(keyOf))];
      keys.sort((p, q) => otherX(p) - otherX(q));
      const step = Math.min(16, (it.w * 0.7) / Math.max(1, keys.length));
      return new Map(keys.map((k, i) => [k, it.x + (i - (keys.length - 1) / 2) * step]));
    };
    for (const [a, list] of out) {
      const it = item[a];
      const ports = portX(it, list, (x) => x.bundle, (k) => { const x = list.find((z) => z.bundle === k); return x.chain[1].x; });
      for (const x of list) x.exit = ports.get(x.bundle);
    }
    for (const [b, list] of inc) {
      const it = item[b];
      const ports = portX(it, list, (x) => x.e.name, (k) => { const x = list.find((z) => z.e.name === k); return x.chain[x.chain.length - 2].x; });
      for (const x of list) x.entry = ports.get(x.e.name);
    }
    // horizontal runs share a gap: give each its own lane (a bundle shares one)
    const lanes = new Map(); // row -> [{key, lo, hi}]
    const hops = [];
    for (const x of E) {
      const pts = [];
      for (let k = 0; k + 1 < x.chain.length; k++) {
        const p = x.chain[k]; const q = x.chain[k + 1];
        const px = k === 0 ? x.exit : p.x; const qx = k + 1 === x.chain.length - 1 ? x.entry : q.x;
        hops.push({ x, k, row: p.row, px, qx, key: k === 0 ? `${x.bundle}` : `${x.e.name}:${k}` });
      }
      x.pts = pts;
    }
    for (const h of hops) {
      if (Math.abs(h.px - h.qx) < 1) continue;
      if (!lanes.has(h.row)) lanes.set(h.row, new Map());
      const L = lanes.get(h.row);
      const cur = L.get(h.key);
      if (cur) { cur.lo = Math.min(cur.lo, h.px, h.qx); cur.hi = Math.max(cur.hi, h.px, h.qx); } else L.set(h.key, { lo: Math.min(h.px, h.qx), hi: Math.max(h.px, h.qx) });
    }
    const laneY = new Map();
    for (const [row, L] of lanes) {
      const g = gapAfter[row]; const list = [...L.entries()].sort((p, q) => p[1].lo - q[1].lo);
      const span = g.bottom - g.top; const step = Math.min(7, (span - 18) / Math.max(1, list.length));
      list.forEach(([key], i) => laneY.set(`${row}|${key}`, g.top + span / 2 + (i - (list.length - 1) / 2) * step));
    }
    for (const x of E) {
      const pts = [{ x: x.exit, y: ys[rank[x.a]] + item[x.a].h / 2 }];
      for (const h of hops.filter((z) => z.x === x)) {
        const ly = laneY.get(`${h.row}|${h.key}`) ?? (gapAfter[h.row].top + gapAfter[h.row].bottom) / 2;
        const nextRow = h.row + 1;
        const q = x.chain[h.k + 1];
        pts.push({ x: h.px, y: ly }, { x: h.qx, y: ly });
        if (q.dummy) pts.push({ x: h.qx, y: ys[nextRow] - rowH[nextRow] / 2 }, { x: h.qx, y: ys[nextRow] + rowH[nextRow] / 2 });
        else pts.push({ x: h.qx, y: ys[nextRow] - q.h / 2 });
      }
      x.pts = simplify(pts);
    }
    // 5. back to screen coordinates
    const T = lr ? (p) => ({ x: p.y, y: p.x }) : (p) => p;
    const pos = nodes.map((n, i) => { const c = T({ x: item[i].x, y: ys[rank[i]] }); return { x: c.x, y: c.y, w: n.offsetWidth, h: n.offsetHeight }; });
    const bandBoxes = bands.map((b) => {
      const top = ys[b.from] - rowH[b.from] / 2 - HEAD - (lr ? 0 : BANDPAD) + (lr ? 0 : 0); const bottom = ys[b.to] + rowH[b.to] / 2 + BANDPAD;
      const box = lr ? { l: top, t: 4, w: bottom - top, h: W - 8 } : { l: 4, t: top, w: W - 8, h: bottom - top };
      return { g: b.g, box };
    });
    const routes = new Map(E.map((x) => {
      let pts = x.pts.map(T);
      if (x.e.back) pts = pts.reverse();
      return [x.e.name, pts];
    }));
    return { width: lr ? H : W, height: lr ? W : H, pos, bands: bandBoxes, routes, dir, gutter: lr ? 0 : gutter };
  }

  function layout(fig) {
    const m = prepare(fig);
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    // The author's order is the reading order: groups first to last, boxes inside a group in order.
    // A connection that points back against it is a callback; it never pulls a box forward.
    const gIndex = new Map(m.groups.map((gr, i) => [gr.id, i]));
    const order = (n) => (gIndex.get(n.dataset.group) ?? m.groups.length) * 1000 + m.nodes.indexOf(n);
    const probe = document.createElement('span'); probe.className = 'tm-dg-label tm-dg-probe'; m.stage.appendChild(probe);
    const edges = [];
    let labelW = 0;
    for (const src of m.nodes) {
      for (const spec of (src.getAttribute('data-to') || '').split(/[\s,]+/).filter(Boolean)) {
        const [id, ...lab] = spec.split(':');
        if (!byId.has(id) || id === src.id || edges.some((e) => e.from === src.id && e.to === id)) continue;
        const label = viaOf(lab.join(':'));
        if (label) { probe.textContent = label; labelW = Math.max(labelW, probe.offsetWidth); }
        edges.push({ from: src.id, to: id, label, name: `${src.id}>${id}`, back: order(src) > order(byId.get(id)) });
      }
    }
    probe.remove();
    // Direction: the author's, or left to right when it fits the column, else top to bottom.
    const room = fig.clientWidth || 860;
    const asked = (fig.getAttribute('data-direction') || '').toUpperCase();
    let L = layered(m, edges, asked === 'TB' ? 'TB' : 'LR', labelW);
    if (!asked && L.width > room) L = layered(m, edges, 'TB', labelW);
    fig.dataset.laidOut = L.dir;
    if (L.dir === 'TB' && L.width < room) {
      const dx = (room - L.width) / 2;
      for (const v of L.pos) v.x += dx;
      for (const pts of L.routes.values()) for (const p of pts) p.x += dx;
      for (const b of L.bands) b.box.w = room - 8;
      L.width = room;
    }
    const gw = L.width; const gh = L.height;
    m.nodes.forEach((n, i) => { const v = L.pos[i]; n.style.left = `${v.x - v.w / 2}px`; n.style.top = `${v.y - v.h / 2}px`; });
    for (const gr of m.groups) gr.box = null;
    for (const b of L.bands) {
      const gr = m.groups[b.g];
      if (!gr) continue;
      gr.box = b.box;
    }
    for (const gr of m.groups) {
      gr.el.hidden = !gr.box;
      if (gr.box) Object.assign(gr.el.style, { left: `${gr.box.l}px`, top: `${gr.box.t}px`, width: `${gr.box.w}px`, height: `${gr.box.h}px` });
    }
    m.stage.style.width = `${gw}px`; m.stage.style.height = `${gh}px`;
    const svg = m.svg; svg.innerHTML = '';
    svg.setAttribute('width', gw); svg.setAttribute('height', gh); svg.setAttribute('viewBox', `0 0 ${gw} ${gh}`);
    for (const lab of m.stage.querySelectorAll('.tm-dg-label')) lab.remove();
    const isKey = (id) => byId.get(id)?.classList.contains('is-key');
    const placed = [];
    for (const e of edges) {
      const pts = L.routes.get(e.name)?.map((p) => ({ ...p }));
      if (!pts || pts.length < 2) continue;
      // stop short of the target so the arrowhead sits outside the box
      const a = pts[pts.length - 2]; const b = pts[pts.length - 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len; const uy = (b.y - a.y) / len;
      const tip = { x: b.x, y: b.y }; pts[pts.length - 1] = { x: b.x - ux * 7, y: b.y - uy * 7 };
      const key = isKey(e.from) && isKey(e.to);
      const ext = byId.get(e.from)?.classList.contains('is-ext') || byId.get(e.to)?.classList.contains('is-ext');
      const planned = byId.get(e.from)?.getAttribute('data-plan') === 'new' || byId.get(e.to)?.getAttribute('data-plan') === 'new';
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', roundPath(pts));
      path.setAttribute('class', `tm-dg-edge${key ? ' is-main' : ''}${ext ? ' is-ext' : ''}${e.back ? ' is-back' : ''}${planned ? ' is-plan' : ''}`);
      const head = document.createElementNS(SVGNS, 'path');
      head.setAttribute('d', `M${tip.x},${tip.y} L${tip.x - ux * 7 - uy * 4},${tip.y - uy * 7 + ux * 4} L${tip.x - ux * 7 + uy * 4},${tip.y - uy * 7 - ux * 4} Z`);
      head.setAttribute('class', `tm-dg-head${key ? ' is-main' : ''}${planned ? ' is-plan' : ''}`);
      for (const el of [path, head]) { el.dataset.from = e.from; el.dataset.to = e.to; }
      svg.appendChild(path); svg.appendChild(head);
      if (e.label) placed.push({ e, path, key });
    }
    const boxes = L.pos.map((v) => ({ l: v.x - v.w / 2 - 3, r: v.x + v.w / 2 + 3, t: v.y - v.h / 2 - 3, b: v.y + v.h / 2 + 3 }));
    const taken = [];
    const hits = (a, list) => list.some((o) => a.l < o.r && a.r > o.l && a.t < o.b && a.b > o.t);
    // points along every edge, so a group label can keep off the wires
    const dots = [];
    for (const p of svg.querySelectorAll('.tm-dg-edge')) { const L = p.getTotalLength(); for (let d = 0; d <= L; d += 5) { const q = p.getPointAtLength(d); dots.push({ l: q.x - 1, r: q.x + 1, t: q.y - 1, b: q.y + 1 }); } }
    const crowd = (r) => (hits(r, boxes) ? 100 : 0) + (hits(r, taken) ? 100 : 0) + dots.filter((o) => r.l < o.r && r.r > o.l && r.t < o.b && r.b > o.t).length;
    for (const gr of m.groups) {
      if (!gr.box) continue;
      const lab = gr.el.firstChild; lab.style.left = '0px'; lab.style.top = '0px';
      if (L.dir === 'TB') { lab.style.left = '14px'; lab.style.top = '12px'; continue; }
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
    const bundleSize = new Map();
    for (const pl of placed) { const k = `${pl.e.from}|${pl.e.label}`; bundleSize.set(k, (bundleSize.get(k) || 0) + 1); }
    for (const { e, path, key, dup } of placed) {
      const t = document.createElement('span'); t.className = `tm-dg-label${key ? ' is-main' : ''}${dup ? ' is-dup' : ''}`; t.textContent = e.label;
      t.dataset.from = e.from; t.dataset.to = e.to;
      m.stage.appendChild(t);
      const w = t.offsetWidth; const h = t.offsetHeight; const L = path.getTotalLength();
      let best = null;
      const trunk = bundleSize.get(`${e.from}|${e.label}`) > 1;
      const fr = trunk ? [0.14, 0.2, 0.1, 0.26, 0.32] : [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
      for (const f of fr) {
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
    const k = Math.max(0.8, Math.min(1, room / gw));
    m.stage.style.transform = k < 1 ? `scale(${k})` : '';
    m.stage.style.marginBottom = k < 1 ? `${-gh * (1 - k)}px` : '';
    m.stage.style.marginRight = k < 1 ? `${-gw * (1 - k)}px` : '';
    fig.classList.toggle('is-wide', gw * k > room + 1);
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
  // A plan's new boxes, drawn dashed in their group until the plan is built.
  function setGhosts(fig, adds) {
    const m = prepare(fig);
    for (const n of m.nodes.filter((x) => x.dataset.ghost)) n.remove();
    m.nodes = m.nodes.filter((x) => !x.dataset.ghost);
    for (const n of m.nodes) if (n.dataset.toOrig !== undefined) { n.setAttribute('data-to', n.dataset.toOrig); delete n.dataset.toOrig; }
    const groupOf = (g) => {
      const k = String(g || '').toLowerCase();
      return m.groups.find((gr) => gr.id.toLowerCase() === k || (gr.el.firstChild?.textContent || '').toLowerCase() === k) || m.groups[0] || null;
    };
    for (const a of adds || []) {
      if (!a || !a.id || document.getElementById(a.id)) continue;
      const n = document.createElement('div');
      n.className = 'tm-node'; n.id = a.id; n.dataset.ghost = '1'; n.setAttribute('data-plan', 'new'); n.setAttribute('tabindex', '0');
      n.setAttribute('data-name', a.name || a.id);
      if (a.tag) n.setAttribute('data-tag', a.tag);
      if (a.to) n.setAttribute('data-to', a.to);
      const det = document.createElement('div'); det.className = 'tm-detail';
      if (a.why) { const p = document.createElement('p'); p.textContent = a.why; det.appendChild(p); }
      n.appendChild(det);
      adopt(m, n, groupOf(a.group)?.id);
      for (const spec of a.from || []) {
        const [src, ...lab] = String(spec).split(':');
        const from = m.nodes.find((x) => x.id === src);
        if (!from) continue;
        if (from.dataset.toOrig === undefined) from.dataset.toOrig = from.getAttribute('data-to') || '';
        from.setAttribute('data-to', `${from.getAttribute('data-to') || ''} ${a.id}${lab.length ? `:${lab.join(':')}` : ''}`.trim());
      }
    }
    layout(fig);
  }
  window.truemapDiagram = { draw, interact, setFlow, nameOf, setGhosts };
})();
