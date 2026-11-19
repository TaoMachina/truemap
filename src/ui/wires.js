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
      for (const e of edges) {
          const { src, dst, a, b } = e;
          const key = src.classList.contains('is-key') && dst.classList.contains('is-key');
          const ext = dst.classList.contains('is-ext') || src.classList.contains('is-ext');
          let d; let head; let mid;
          const r = 7;
          if (down(e)) { // below: leave from the bottom, enter at the top
            const so = slot(outOf.get(src), e); const ti = slot(into.get(dst), e);
            const sx = a.cx + so * 14; const sy = a.b; const tx = b.cx + ti * 14; const ty = b.t - 6;
            const my = sy + Math.max(12, Math.min(22, (ty - sy) / 2)) + ti * 7;
            if (Math.abs(tx - sx) < 2) d = `M${sx},${sy} V${ty}`;
            else {
              const dir = tx > sx ? 1 : -1; const rr = Math.min(r, Math.abs(tx - sx) / 2);
              d = `M${sx},${sy} V${my - rr} Q${sx},${my} ${sx + dir * rr},${my} H${tx - dir * rr} Q${tx},${my} ${tx},${my + rr} V${ty}`;
            }
            head = `M${tx - 4.5},${ty - 1} L${tx + 4.5},${ty - 1} L${tx},${ty + 6} Z`;
            // the label sits by the box the wire leaves, so it is clear which wire it names
            mid = { x: sx - 2, y: Math.min(sy + 10, my - 6) };
          } else if (b.b <= a.t + 2) { // above
            const sx = a.cx; const sy = a.t; const tx = b.cx; const ty = b.b + 6;
            const my = sy - Math.max(12, Math.min(22, (sy - ty) / 2));
            const dir = tx > sx ? 1 : -1;
            d = Math.abs(tx - sx) < 2 ? `M${sx},${sy} V${ty}` : `M${sx},${sy} V${my + r} Q${sx},${my} ${sx + dir * r},${my} H${tx - dir * r} Q${tx},${my} ${tx},${my - r} V${ty}`;
            head = `M${tx - 4.5},${ty + 1} L${tx + 4.5},${ty + 1} L${tx},${ty - 6} Z`;
            mid = { x: tx, y: (my + ty) / 2 };
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
            mid = { x: mx, y: ty - 6 };
          }
          const path = document.createElementNS(SVGNS, 'path');
          path.setAttribute('d', d); path.setAttribute('class', `tm-wire${key ? ' is-key' : ''}${ext ? ' is-ext' : ''}`);
          const arrow = document.createElementNS(SVGNS, 'path');
          arrow.setAttribute('d', head); arrow.setAttribute('class', `tm-wire-head${key ? ' is-key' : ''}`);
          svg.appendChild(path);
          svg.appendChild(arrow);
          if (e.label) {
            const t = document.createElementNS(SVGNS, 'text');
            t.setAttribute('class', 'tm-wire-label'); t.setAttribute('x', mid.x + 8); t.setAttribute('y', mid.y + 4);
            t.textContent = e.label; svg.appendChild(t);
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
