// Draws the wires of every .tm-map from data-to="id id:label". Used by the page SDK and by exported pages.
// Plain script, no dependencies: defines window.truemapWires.draw().
//
// Rules that keep the map honest:
//  - a wire only touches its own two boxes; layers in between are crossed through free columns
//  - every horizontal run in a gap between layers gets its own track (wires from the same box may share one)
//  - a gap grows when it needs more tracks
//  - exits leave from the middle of a box, entries arrive in its left third (upward ones: right third)
(() => {
  if (window.truemapWires) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const LANE = 9; const R = 7;

  // An orthogonal path through the given points with rounded corners.
  function ortho(points) {
    const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1]; const [x, y] = pts[i]; const [nx, ny] = pts[i + 1];
      const l1 = Math.hypot(x - px, y - py); const l2 = Math.hypot(nx - x, ny - y);
      if (!l1 || !l2 || (px === x && x === nx) || (py === y && y === ny)) continue;
      const rr = Math.min(R, l1 / 2, l2 / 2);
      d += ` L${x - ((x - px) / l1) * rr},${y - ((y - py) / l1) * rr} Q${x},${y} ${x + ((nx - x) / l2) * rr},${y + ((ny - y) / l2) * rr}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L${last[0]},${last[1]}`;
  }

  function drawMap(map) {
    map.querySelector(':scope > svg.tm-wires')?.remove();
    const sources = [...map.querySelectorAll('[data-to]')];
    if (!sources.length) return false;
    // Coordinates live in the map's scroll space, so wires scroll with the boxes.
    const box = map.getBoundingClientRect();
    const ox = box.left + map.clientLeft - map.scrollLeft; const oy = box.top + map.clientTop - map.scrollTop;
    const rel = (r) => ({ l: r.left - ox, r: r.right - ox, t: r.top - oy, b: r.bottom - oy, cx: (r.left + r.right) / 2 - ox, cy: (r.top + r.bottom) / 2 - oy });
    const rects = [...map.querySelectorAll('.tm-node, .tm-step')].map((n) => ({ n, ...rel(n.getBoundingClientRect()) }));
    const rectOf = new Map(rects.map((o) => [o.n, o]));

    // Rows: boxes that overlap vertically. Gap i lies between row i and row i+1.
    const rows = [];
    for (const o of [...rects].sort((p, q) => p.t - q.t)) {
      const row = rows.find((w) => o.t < w.b - 2 && o.b > w.t + 2);
      if (row) { row.t = Math.min(row.t, o.t); row.b = Math.max(row.b, o.b); row.items.push(o); } else rows.push({ t: o.t, b: o.b, items: [o] });
    }
    rows.sort((p, q) => p.t - q.t);
    const rowOf = (o) => rows.findIndex((w) => w.items.includes(o));

    const edges = [];
    for (const src of sources) {
      for (const spec of src.getAttribute('data-to').split(/[\s,]+/).filter(Boolean)) {
        const [id, ...labelParts] = spec.split(':');
        const dst = document.getElementById(id);
        if (!dst || dst === src || !map.contains(dst) || !rectOf.has(src) || !rectOf.has(dst)) continue;
        const a = rectOf.get(src); const b = rectOf.get(dst);
        const ra = rowOf(a); const rb = rowOf(b);
        edges.push({ src, dst, a, b, ra, rb, dir: rb > ra ? 'down' : rb < ra ? 'up' : 'same', label: labelParts.join(':').replace(/\\_/g, '\u0001').replace(/_/g, ' ').replace(/\u0001/g, '_') });
      }
    }
    const group = (key, pick) => {
      const m = new Map();
      for (const e of edges.filter(pick)) (m.get(e[key]) || m.set(e[key], []).get(e[key])).push(e);
      for (const l of m.values()) l.sort((p, q) => (key === 'src' ? p.b.cx - q.b.cx : p.a.cx - q.a.cx));
      return m;
    };
    const downOut = group('src', (e) => e.dir === 'down'); const downIn = group('dst', (e) => e.dir === 'down');
    const upOut = group('src', (e) => e.dir === 'up'); const upIn = group('dst', (e) => e.dir === 'up');
    const slot = (list, e) => list.indexOf(e) - (list.length - 1) / 2;

    // Free vertical columns through rows lo..hi (exclusive of the wire's own boxes), one wire per column.
    const columns = [];
    function column(e, lo, hi, prefer) {
      const blockers = rects.filter((o) => { const r = rowOf(o); return r > lo && r < hi; });
      const free = (x) => !blockers.some((o) => x > o.l - 7 && x < o.r + 7)
        && !columns.some((c) => Math.abs(c.x - x) < 8 && c.src !== e.src && c.lo < hi && c.hi > lo);
      const cands = [prefer[0], prefer[1], ...blockers.flatMap((o) => [o.l - 13, o.r + 13])];
      for (const c of [...cands]) for (let k = 1; k <= 4; k++) cands.push(c + k * 9, c - k * 9);
      const x = cands.filter(free).sort((p, q) => Math.abs(p - prefer[0]) + Math.abs(p - prefer[1]) - Math.abs(q - prefer[0]) - Math.abs(q - prefer[1]))[0] ?? prefer[0];
      columns.push({ x, lo, hi, src: e.src });
      return x;
    }

    // Plan every wire. Horizontal runs in a gap are recorded as lane requests and get their y later.
    const lanes = new Map(); // gap index -> [{x1, x2, src, ref}]
    const lane = (gap, x1, x2, e) => { const ref = { y: null, gap }; ref.item = { x1: Math.min(x1, x2), x2: Math.max(x1, x2), src: e.src, ref }; (lanes.get(gap) || lanes.set(gap, []).get(gap)).push(ref.item); return ref; };
    const plans = [];
    for (const e of edges) {
      const { a, b } = e;
      if (e.dir === 'down') {
        const sx = a.cx + slot(downOut.get(e.src), e) * 14; const sy = a.b; const ty = b.t - 6;
        const ins = downIn.get(e.dst); const ti = ins.indexOf(e);
        const straight = ins.length === 1 && Math.abs(a.cx - b.cx) < 4;
        const tx = straight ? b.cx : Math.min(b.l + 26 + ti * 14, b.cx - 14);
        if (e.rb === e.ra + 1) {
          if (Math.abs(sx - tx) < 1) plans.push({ e, pts: [[sx, sy], [tx, ty]], head: 'down', tx, ty, label: { x: sx + 6, y: sy + 13 } });
          else { const y = lane(e.ra, sx, tx, e); plans.push({ e, pts: [[sx, sy], [sx, y], [tx, y], [tx, ty]], head: 'down', tx, ty, label: { x: sx + 6, y: sy + 13 } }); }
        } else {
          const x = column(e, e.ra, e.rb, [sx, tx]);
          const y1 = lane(e.ra, sx, x, e); const y2 = lane(e.rb - 1, x, tx, e);
          plans.push({ e, pts: [[sx, sy], [sx, y1], [x, y1], [x, y2], [tx, y2], [tx, ty]], head: 'down', tx, ty, label: { x: sx + 6, y: sy + 13 } });
        }
      } else if (e.dir === 'up') {
        const sx = a.r - 26 - (slot(upOut.get(e.src), e) + (upOut.get(e.src).length - 1) / 2) * 14; const sy = a.t;
        const tx = b.r - 26 - upIn.get(e.dst).indexOf(e) * 14; const ty = b.b + 6;
        if (e.rb === e.ra - 1) {
          const y = lane(e.rb, sx, tx, e);
          plans.push({ e, pts: [[sx, sy], [sx, y], [tx, y], [tx, ty]], head: 'up', tx, ty, label: { x: sx + 6, y: sy - 6 } });
        } else {
          const x = column(e, e.rb, e.ra, [sx, tx]);
          const y1 = lane(e.ra - 1, sx, x, e); const y2 = lane(e.rb, x, tx, e);
          plans.push({ e, pts: [[sx, sy], [sx, y1], [x, y1], [x, y2], [tx, y2], [tx, ty]], head: 'up', tx, ty, label: { x: sx + 6, y: sy - 6 } });
        }
      } else {
        const blocked = rects.some((o) => o.n !== e.src && o.n !== e.dst && rowOf(o) === e.ra && o.l >= Math.min(a.r, b.r) - 1 && o.r <= Math.max(a.l, b.l) + 1);
        if (!blocked) { // side by side
          const right = b.l >= a.r; const sx = right ? a.r : a.l; const tx = right ? b.l - 6 : b.r + 6;
          plans.push({ e, pts: [[sx, a.cy], [(sx + tx) / 2, a.cy], [(sx + tx) / 2, b.cy], [tx, b.cy]], head: right ? 'right' : 'left', tx, ty: b.cy, label: { x: (sx + tx) / 2, y: Math.min(a.t, b.t) - 6, middle: true } });
        } else { // boxes in between: over the row (under it for the first row)
          const over = e.ra > 0;
          const sx = a.cx + (b.cx > a.cx ? 18 : -18); const tx = b.cx + (b.cx > a.cx ? -18 : 18);
          const sy = over ? a.t : a.b; const ty = over ? b.t - 6 : b.b + 6;
          const y = lane(over ? e.ra - 1 : e.ra, sx, tx, e);
          plans.push({ e, pts: [[sx, sy], [sx, y], [tx, y], [tx, ty]], head: over ? 'down' : 'up', tx, ty, label: { x: sx + 6, y: over ? sy - 6 : sy + 13 } });
        }
      }
    }

    // Entries keep clear of unrelated vertical lines in the same gap (at least 18px), sliding within the
    // target box, so an entry never looks like the continuation of another box's exit.
    const stems = [];
    for (const p of plans) {
      const P = p.pts;
      if (P.length === 2 && P[0][0] === P[1][0] && p.head === 'down') { stems.push({ p, kind: 'straight', gap: p.e.ra, x: () => P[0][0] }); continue; }
      if (P.length < 4 || typeof P[1][1] !== 'object') continue;
      stems.push({ p, kind: 'exit', gap: P[1][1].gap, x: () => P[0][0] });
      stems.push({ p, kind: 'entry', gap: P[P.length - 2][1].gap, x: () => P[P.length - 1][0] });
    }
    const shares = (p, q) => [p.e.src, p.e.dst].some((n) => n === q.e.src || n === q.e.dst);
    for (const s of stems.filter((t) => t.kind === 'entry')) {
      const clash = (x) => stems.some((o) => o.p !== s.p && !shares(o.p, s.p) && o.gap === s.gap && Math.abs(o.x() - x) < 18);
      const x0 = s.x(); if (!clash(x0)) continue;
      const b = s.p.e.b; const cands = [];
      for (let k = 1; k <= 16; k++) cands.push(x0 + k * 7, x0 - k * 7);
      const nx = cands.find((x) => x > b.l + 10 && x < b.r - 10 && !clash(x));
      if (nx === undefined) continue;
      const P = s.p.pts; P[P.length - 1][0] = nx; P[P.length - 2][0] = nx; s.p.tx = nx;
      const item = P[P.length - 2][1].item; item.x1 = Math.min(item.x1, nx); item.x2 = Math.max(item.x2, nx);
    }

    // Tracks: interval colouring per gap. Wires from the same box may share a track.
    let grow = false;
    for (const [gap, items] of lanes) {
      items.sort((p, q) => p.x1 - q.x1);
      const tracks = [];
      for (const it of items) {
        let t = tracks.find((k) => k.srcs.has(it.src) || k.end < it.x1 - 10);
        if (!t) { t = { end: -Infinity, srcs: new Set() }; tracks.push(t); }
        if (!(t.srcs.has(it.src) || t.end < it.x1 - 10)) { t.srcs.clear(); }
        t.end = Math.max(t.end, it.x2); t.srcs.add(it.src); it.track = tracks.indexOf(t);
      }
      const top = gap >= 0 && gap < rows.length - 1 ? rows[gap].b : rows[0].t - 40;
      const bottom = gap >= 0 && gap < rows.length - 1 ? rows[gap + 1].t : rows[0].t;
      const need = tracks.length * LANE + 22;
      if (gap >= 0 && gap < rows.length - 1 && bottom - top < need) {
        // Make room: push the next layer down.
        const layer = rows[gap + 1].items[0].n.closest('.tm-layer');
        if (layer) {
          const cur = parseFloat(getComputedStyle(layer).marginTop) || 0;
          layer.dataset.tmGrown = '1';
          layer.style.marginTop = `${cur + (need - (bottom - top))}px`;
          grow = true;
        }
      }
      const mid = (top + bottom) / 2;
      for (const it of items) it.ref.y = mid + (it.track - (tracks.length - 1) / 2) * LANE;
    }
    if (grow) return true; // layout changed: draw again

    // Draw.
    const w = map.scrollWidth; const h = map.scrollHeight;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'tm-wires'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const placed = []; const labelsBy = new Map();
    for (const p of plans) {
      const { e } = p;
      const key = e.src.classList.contains('is-key') && e.dst.classList.contains('is-key');
      const ext = e.dst.classList.contains('is-ext') || e.src.classList.contains('is-ext');
      const pts = p.pts.map(([x, y]) => [x, typeof y === 'object' ? y.y : y]);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', ortho(pts)); path.setAttribute('class', `tm-wire${key ? ' is-key' : ''}${ext ? ' is-ext' : ''}`);
      const { tx, ty } = p;
      const head = { down: `M${tx - 4.5},${ty - 1} L${tx + 4.5},${ty - 1} L${tx},${ty + 6} Z`, up: `M${tx - 4.5},${ty + 1} L${tx + 4.5},${ty + 1} L${tx},${ty - 6} Z`,
        right: `M${tx - 1},${ty - 4.5} L${tx - 1},${ty + 4.5} L${tx + 6},${ty} Z`, left: `M${tx + 1},${ty - 4.5} L${tx + 1},${ty + 4.5} L${tx - 6},${ty} Z` }[p.head];
      const arrow = document.createElementNS(SVGNS, 'path');
      arrow.setAttribute('d', head); arrow.setAttribute('class', `tm-wire-head${key ? ' is-key' : ''}`);
      for (const el of [path, arrow]) { el.dataset.from = e.src.id; el.dataset.to = e.dst.id; }
      svg.appendChild(path); svg.appendChild(arrow);
      // A label never leaves its own wire: it sits beside the stem where the wire leaves its box (on the
      // left when the map edge is near); several labels from one box stack along the stem. Only main-path
      // labels show by default; the rest appear when their box is hovered or their path is lit (kit CSS).
      const used = labelsBy.get(e.src) || labelsBy.set(e.src, { texts: [], n: 0 }).get(e.src);
      if (e.label && !used.texts.includes(e.label)) {
        const lw = e.label.length * 6.4;
        let x; let y; let anchor = 'start';
        if (p.label.middle) { x = p.label.x; y = p.label.y; anchor = 'middle'; } else {
          const sx = p.pts[0][0];
          y = p.label.y + (p.head === 'up' ? -used.n : used.n) * 13;
          if (sx + 6 + lw > w - 4) { x = sx - 6; anchor = 'end'; } else x = sx + 6;
        }
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('class', `tm-wire-label${key ? ' is-key' : ''}`); t.setAttribute('x', x); t.setAttribute('y', y);
        if (anchor !== 'start') t.setAttribute('text-anchor', anchor);
        t.dataset.from = e.src.id; t.dataset.to = e.dst.id;
        t.textContent = e.label; svg.appendChild(t);
        used.n++; used.texts.push(e.label);
      }
    }
    // key wires on top, labels above every wire
    [...svg.querySelectorAll('.tm-wire.is-key, .tm-wire-head.is-key')].forEach((el) => svg.appendChild(el));
    [...svg.querySelectorAll('.tm-wire-label')].forEach((el) => svg.appendChild(el));
    map.insertBefore(svg, map.firstChild);
    markScroll(map);
    return false;
  }

  function drawWires() {
    document.documentElement.style.setProperty('--tm-vw', `${document.documentElement.clientWidth}px`);
    for (const map of document.querySelectorAll('.tm-map, .tm-blueprint')) {
      // Start from the authored spacing, then let gaps grow as the tracks require.
      for (const l of map.querySelectorAll('.tm-layer[data-tm-grown]')) { l.style.marginTop = ''; delete l.dataset.tmGrown; }
      for (let pass = 0; pass < 4 && drawMap(map); pass++) { /* re-layout */ }
      if (map.querySelector(':scope > svg.tm-wires') === null && map.querySelector('[data-to]')) drawMap(map);
    }
  }
  // A map wider than the window fades at the edge it can scroll towards.
  function markScroll(map) {
    map.classList.toggle('tm-scrolls', map.scrollWidth - map.clientWidth - map.scrollLeft > 4);
    if (!map.__tmScroll) { map.__tmScroll = true; map.addEventListener('scroll', () => markScroll(map), { passive: true }); }
  }
  // Hover and path buttons without the truemap workspace (used by exported pages; the SDK has its own).
  function interact() {
    let hot = null; let lit = [];
    const mark = () => {
      const ids = new Set(lit);
      for (const el of document.querySelectorAll('.tm-wire, .tm-wire-head, .tm-wire-label')) {
        el.classList.toggle('is-hot', !!hot && (el.dataset.from === hot.id || el.dataset.to === hot.id));
        el.classList.toggle('is-focus', ids.has(el.dataset.from) && ids.has(el.dataset.to));
      }
    };
    document.addEventListener('mousemove', (e) => {
      const box = e.target.closest?.('.tm-map .tm-node, .tm-blueprint .tm-node') || null;
      if (box !== hot) { hot = box; mark(); }
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-tm-flow]'); if (!btn) return;
      const ids = btn.getAttribute('data-tm-flow').split(/[\s,]+/).filter(Boolean);
      const same = lit.length && ids.join() === lit.join();
      lit = same ? [] : ids;
      document.documentElement.toggleAttribute('data-tm-focusing', !!lit.length);
      for (const el of document.querySelectorAll('[data-tm-focus]')) el.removeAttribute('data-tm-focus');
      for (const id of lit) document.getElementById(id)?.setAttribute('data-tm-focus', '');
      for (const b of document.querySelectorAll('[data-tm-flow]')) b.setAttribute('aria-pressed', String(!same && b === btn));
      mark();
    });
    window.truemapWires.mark = mark;
  }
  window.truemapWires = { draw: drawWires, interact };
})();
