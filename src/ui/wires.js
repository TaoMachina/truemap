// Draws the wires of every .tm-map from data-to="id id:label". Used by the page SDK and by exported pages.
// Plain script, no dependencies: defines window.truemapWires.draw().
(() => {
  if (window.truemapWires) return;
  // ---------- wires: <div class="tm-node" id="orders" data-to="payments payments-db:reads"> ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Is any other box sitting in the row between these two?
  function between(map, src, dst) {
    const s = src.getBoundingClientRect(); const t = dst.getBoundingClientRect();
    const gapL = Math.min(s.right, t.right) - 1; const gapR = Math.max(s.left, t.left) + 1; // the span between the two boxes
    return [...map.querySelectorAll('.tm-node, .tm-step')].some((n) => {
      if (n === src || n === dst) return false;
      const r = n.getBoundingClientRect();
      return r.left >= gapL && r.right <= gapR && r.bottom > s.top && r.top < s.bottom;
    });
  }
  // An orthogonal path through the given points with rounded corners.
  function ortho(points, r) {
    const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1]; const [x, y] = pts[i]; const [nx, ny] = pts[i + 1];
      const l1 = Math.hypot(x - px, y - py); const l2 = Math.hypot(nx - x, ny - y);
      if (!l1 || !l2 || (px === x && x === nx) || (py === y && y === ny)) continue;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      d += ` L${x - ((x - px) / l1) * rr},${y - ((y - py) / l1) * rr} Q${x},${y} ${x + ((nx - x) / l2) * rr},${y + ((ny - y) / l2) * rr}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L${last[0]},${last[1]}`;
  }
  const overTop = new Map();
  function drawWires() {
    overTop.clear();
    document.documentElement.style.setProperty('--tm-vw', `${document.documentElement.clientWidth}px`);
    for (const map of document.querySelectorAll('.tm-map, .tm-blueprint')) {
      map.querySelector(':scope > svg.tm-wires')?.remove();
      const sources = [...map.querySelectorAll('[data-to]')];
      if (!sources.length) continue;
      // Coordinates live in the map's scroll space, so wires scroll with the boxes.
      const box = map.getBoundingClientRect();
      const ox = box.left + map.clientLeft - map.scrollLeft; const oy = box.top + map.clientTop - map.scrollTop;
      const w = map.scrollWidth; const h = map.scrollHeight;
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'tm-wires'); svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const rel = (r) => ({ l: r.left - ox, r: r.right - ox, t: r.top - oy, b: r.bottom - oy, cx: (r.left + r.right) / 2 - ox, cy: (r.top + r.bottom) / 2 - oy });
      // Collect edges first so wires sharing a box get their own exit, entry and track (no merged lines).
      const edges = [];
      for (const src of sources) {
        for (const spec of src.getAttribute('data-to').split(/[\s,]+/).filter(Boolean)) {
          const [id, ...labelParts] = spec.split(':');
          const dst = document.getElementById(id);
          if (!dst || dst === src || !map.contains(dst)) continue;
          edges.push({ src, dst, label: labelParts.join(':').replace(/_/g, ' '), a: rel(src.getBoundingClientRect()), b: rel(dst.getBoundingClientRect()) });
        }
      }
      const down = (e) => e.b.t >= e.a.b - 2;
      const slot = (list, e) => { const i = list.indexOf(e); return i - (list.length - 1) / 2; };
      const outOf = new Map(); const into = new Map();
      for (const e of edges.filter(down)) {
        (outOf.get(e.src) || outOf.set(e.src, []).get(e.src)).push(e);
        (into.get(e.dst) || into.set(e.dst, []).get(e.dst)).push(e);
      }
      for (const l of [...outOf.values(), ...into.values()]) l.sort((p, q) => p.b.cx - q.b.cx || p.a.cx - q.a.cx);
      const rects = [...map.querySelectorAll('.tm-node, .tm-step')].map((n) => ({ n, ...rel(n.getBoundingClientRect()) }));
      const labelsBy = new Map(); const placed = [];
      for (const e of edges) {
          const { src, dst, a, b } = e;
          const key = src.classList.contains('is-key') && dst.classList.contains('is-key');
          const ext = dst.classList.contains('is-ext') || src.classList.contains('is-ext');
          let d; let head; let mid;
          const r = 7;
          if (down(e)) { // below: leave from the bottom, enter at the top
            const so = slot(outOf.get(src), e);
            const sx = a.cx + so * 14; const sy = a.b; const ty = b.t - 6;
            // Exits leave from the middle of a box, entries arrive in its left third, so an exit and an
            // unrelated entry can never line up into one line. Only a box straight above, as the single
            // caller, enters in the middle.
            const ins = into.get(dst);
            const straight = ins.length === 1 && Math.abs(a.cx - b.cx) < 4;
            const ti = ins.indexOf(e);
            const tx = straight ? b.cx : Math.min(b.l + 26 + ti * 14, b.cx - 14);
            // Boxes in layers between source and target are obstacles: go round them through a free column.
            const blockers = rects.filter((o) => o.n !== src && o.n !== dst && o.t > a.b + 1 && o.b < b.t - 1);
            let pts;
            if (!blockers.length) {
              const my = sy + Math.max(12, Math.min(22, (ty - sy) / 2)) + (straight ? 0 : ti * 6);
              pts = [[sx, sy], [sx, my], [tx, my], [tx, ty]];
            } else {
              const free = (x) => !blockers.some((o) => x > o.l - 7 && x < o.r + 7);
              const cands = [sx, tx, ...blockers.flatMap((o) => [o.l - 13, o.r + 13])].filter(free);
              const x = cands.sort((p, q) => Math.abs(p - sx) + Math.abs(p - tx) - Math.abs(q - sx) - Math.abs(q - tx))[0] ?? sx;
              const y1 = sy + 12 + Math.abs(so) * 5; const y2 = b.t - 16 - ti * 6;
              pts = [[sx, sy], [sx, y1], [x, y1], [x, y2], [tx, y2], [tx, ty]];
            }
            d = ortho(pts, r);
            head = `M${tx - 4.5},${ty - 1} L${tx + 4.5},${ty - 1} L${tx},${ty + 6} Z`;
            // the label sits by the box the wire leaves, so it is clear which wire it names
            mid = { x: sx - 2, y: sy + 10 };
          } else if (b.b <= a.t + 2) { // above
            // Upward wires (a callback, a reply) leave from the top-right and arrive at the bottom-right third,
            // away from the middle where downward wires run, and go round boxes in between like downward ones.
            const sx = a.r - 26; const sy = a.t; const tx = b.r - 26; const ty = b.b + 6;
            const blockers = rects.filter((o) => o.n !== src && o.n !== dst && o.t > b.b + 1 && o.b < a.t - 1);
            let pts;
            if (!blockers.length) {
              const my = sy - Math.max(12, Math.min(22, (sy - ty) / 2));
              pts = [[sx, sy], [sx, my], [tx, my], [tx, ty]];
            } else {
              const free = (x) => !blockers.some((o) => x > o.l - 7 && x < o.r + 7);
              const cands = [sx, tx, ...blockers.flatMap((o) => [o.l - 13, o.r + 13])].filter(free);
              const x = cands.sort((p, q) => Math.abs(p - sx) + Math.abs(p - tx) - Math.abs(q - sx) - Math.abs(q - tx))[0] ?? sx;
              pts = [[sx, sy], [sx, sy - 12], [x, sy - 12], [x, b.b + 18], [tx, b.b + 18], [tx, ty]];
            }
            d = ortho(pts, r);
            head = `M${tx - 4.5},${ty + 1} L${tx + 4.5},${ty + 1} L${tx},${ty - 6} Z`;
            mid = { x: sx - 2, y: sy - 18 };
          } else if (between(map, src, dst, a, b)) { // same row, boxes in between: arc over the top of the row
            const sx = a.cx + (b.cx > a.cx ? 18 : -18); const tx = b.cx + (b.cx > a.cx ? -18 : 18);
            const top = Math.min(a.t, b.t) - 16 - (overTop.get(src) || 0); overTop.set(src, (overTop.get(src) || 0) + 6);
            const ty = b.t - 6; const dir = tx > sx ? 1 : -1;
            d = `M${sx},${a.t} V${top + r} Q${sx},${top} ${sx + dir * r},${top} H${tx - dir * r} Q${tx},${top} ${tx},${top + r} V${ty}`;
            head = `M${tx - 4.5},${ty - 1} L${tx + 4.5},${ty - 1} L${tx},${ty + 6} Z`;
            mid = { x: sx - 2, y: a.t - 9 }; // by the box the wire leaves
          } else { // same row: side to side
            const right = b.l >= a.r;
            const sx = right ? a.r : a.l; const tx = right ? b.l - 6 : b.r + 6;
            const sy = a.cy; const ty = b.cy; const mx = (sx + tx) / 2;
            d = Math.abs(ty - sy) < 2 ? `M${sx},${sy} H${tx}` : `M${sx},${sy} H${mx} V${ty} H${tx}`;
            head = right ? `M${tx - 1},${ty - 4.5} L${tx - 1},${ty + 4.5} L${tx + 6},${ty} Z` : `M${tx + 1},${ty - 4.5} L${tx + 1},${ty + 4.5} L${tx - 6},${ty} Z`;
            mid = { x: mx, y: Math.min(a.t, b.t) - 10, middle: true }; // in the gap above the row, not between boxes
          }
          const path = document.createElementNS(SVGNS, 'path');
          path.setAttribute('d', d); path.setAttribute('class', `tm-wire${key ? ' is-key' : ''}${ext ? ' is-ext' : ''}`);
          const arrow = document.createElementNS(SVGNS, 'path');
          arrow.setAttribute('d', head); arrow.setAttribute('class', `tm-wire-head${key ? ' is-key' : ''}`);
          svg.appendChild(path);
          svg.appendChild(arrow);
          // One label per text per source box; different labels from the same box sit side by side.
          const used = labelsBy.get(src) || labelsBy.set(src, { texts: [], x: null }).get(src);
          if (e.label && !used.texts.includes(e.label)) {
            const t = document.createElementNS(SVGNS, 'text');
            const w = e.label.length * 6.4; const y = mid.y + 4;
            let x = mid.middle ? mid.x - w / 2 : Math.max(mid.x + 8, used.x ?? -Infinity);
            // never on top of another label: slide right until clear
            const hits = (lx) => placed.some((p) => lx < p.r + 8 && lx + w > p.l - 8 && Math.abs(p.y - y) < 12)
              || rects.some((o) => lx < o.r && lx + w > o.l && y > o.t && y - 10 < o.b);
            for (let i = 0; i < 40 && hits(x); i++) x += 12;
            t.setAttribute('class', 'tm-wire-label'); t.setAttribute('x', x); t.setAttribute('y', y);
            t.textContent = e.label; svg.appendChild(t);
            placed.push({ l: x, r: x + w, y });
            if (!mid.middle) used.x = x + w + 12;
            used.texts.push(e.label);
          }
      }
      // key wires on top, labels above every wire
      [...svg.querySelectorAll('.tm-wire.is-key, .tm-wire-head.is-key')].forEach((el) => svg.appendChild(el));
      [...svg.querySelectorAll('.tm-wire-label')].forEach((el) => svg.appendChild(el));
      map.insertBefore(svg, map.firstChild);
      markScroll(map);
    }
  }
  // A map wider than the window fades at the edge it can scroll towards.
  function markScroll(map) {
    map.classList.toggle('tm-scrolls', map.scrollWidth - map.clientWidth - map.scrollLeft > 4);
    if (!map.__tmScroll) { map.__tmScroll = true; map.addEventListener('scroll', () => markScroll(map), { passive: true }); }
  }
  window.truemapWires = { draw: drawWires };
})();
