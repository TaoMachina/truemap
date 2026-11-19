// Can people read it? The colour tokens a project ends up with (kit + .truemap/assets/theme.css), light and
// dark, and the pairs that must stay readable.

const NAMED = {
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969',
  gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5', snow: '#fffafa', ivory: '#fffff0', beige: '#f5f5dc', linen: '#faf0e6',
  red: '#ff0000', darkred: '#8b0000', maroon: '#800000', crimson: '#dc143c', tomato: '#ff6347', coral: '#ff7f50',
  orange: '#ffa500', darkorange: '#ff8c00', gold: '#ffd700', yellow: '#ffff00', khaki: '#f0e68c',
  green: '#008000', darkgreen: '#006400', lime: '#00ff00', olive: '#808000', teal: '#008080', seagreen: '#2e8b57',
  blue: '#0000ff', navy: '#000080', darkblue: '#00008b', royalblue: '#4169e1', steelblue: '#4682b4',
  skyblue: '#87ceeb', lightblue: '#add8e6', dodgerblue: '#1e90ff', cyan: '#00ffff', aqua: '#00ffff',
  purple: '#800080', indigo: '#4b0082', violet: '#ee82ee', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb',
  brown: '#a52a2a', chocolate: '#d2691e', tan: '#d2b48c', slategray: '#708090', slategrey: '#708090',
};
/** [r, g, b] 0-255 for hex, rgb(), hsl() and named colours; null when it can't be read. */
function hex(c) {
  let v = String(c ?? '').trim().toLowerCase();
  if (NAMED[v]) v = NAMED[v];
  const m = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (m) {
    const h = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((x) => x + x).join('') : m[1].slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const num = (x, max) => (x.endsWith('%') ? (parseFloat(x) / 100) * max : parseFloat(x));
  const r = v.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/);
  if (r) return [r[1], r[2], r[3]].map((x) => Math.round(Math.min(255, num(x, 255))));
  const h = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (h) {
    const H = (+h[1] % 360) / 360; const S = +h[2] / 100; const L = +h[3] / 100;
    const q = L < 0.5 ? L * (1 + S) : L + S - L * S; const p = 2 * L - q;
    const t = (x) => { x = (x + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
    return [t(H + 1 / 3), t(H), t(H - 1 / 3)].map((x) => Math.round(x * 255));
  }
  return null;
}
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function ratio(a, b) {
  const x = hex(a); const y = hex(b);
  if (!x || !y) return null;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** The --tm-* values in effect, for light and for dark (later rules win, dark builds on light). */
export function tokens(css) {
  const light = {}; const dark = {};
  const take = (body, into) => { for (const m of body.matchAll(/(--tm-[\w-]+)\s*:\s*([^;}]+)/g)) into[m[1]] = m[2].trim(); };
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g;
  let at = 0; let m;
  while ((m = re.exec(plain))) {
    for (const r of plain.slice(at, m.index).matchAll(/:root[^{]*\{([^}]*)\}/g)) take(r[1], light);
    let depth = 1; let i = re.lastIndex;
    for (; i < plain.length && depth; i++) { if (plain[i] === '{') depth++; else if (plain[i] === '}') depth--; }
    for (const r of plain.slice(re.lastIndex, i).matchAll(/:root[^{]*\{([^}]*)\}/g)) take(r[1], dark);
    at = i; re.lastIndex = i;
  }
  for (const r of plain.slice(at).matchAll(/:root[^{]*\{([^}]*)\}/g)) take(r[1], light);
  return { light, dark: { ...light, ...dark } };
}

const PAIRS = [
  ['--tm-text', '--tm-paper', 4.5, 'body text on the page'],
  ['--tm-ink', '--tm-sheet', 4.5, 'box titles'],
  ['--tm-ink', '--tm-mark', 4.5, 'text on the highlighter'],
  ['--tm-text', '--tm-wash', 4.5, 'text on quiet fills'],
  ['--tm-ink', '--tm-chrome', 4.5, 'the workspace bar'],
  ['--tm-graphite', '--tm-paper', 4.5, 'secondary text'],
  ['--tm-pencil', '--tm-paper', 2.5, 'hints'],
  ['--tm-accent-text', '--tm-accent', 4.5, 'text on the primary button'],
  ['--tm-changed', '--tm-paper', 3, '"changed" marks'],
  ['--tm-broken', '--tm-paper', 3, '"broken" marks'],
  ['--tm-fine', '--tm-paper', 3, '"fine" and "new" marks'],
  ['--tm-rule-strong', '--tm-paper', 1.3, 'box borders'],
];

/** Pairs that are too faint to read, as plain notes. */
export function contrastNotes(css) {
  const t = tokens(css); const notes = [];
  for (const [mode, vals] of [['light', t.light], ['dark', t.dark]]) {
    const val = (k) => { let v = vals[k]; for (let n = 0; n < 4 && /^var\(/.test(v || ''); n++) v = vals[(v.match(/var\(\s*(--tm-[\w-]+)/) || [])[1]]; return v; };
    for (const [fg, bg, min, what] of PAIRS) {
      const r = ratio(val(fg), val(bg));
      if (r == null) { notes.push(`${mode}: ${what}: can't read ${hex(val(fg)) ? bg + ' ' + val(bg) : fg + ' ' + val(fg)}; use hex, rgb() or hsl() so it can be checked`); continue; }
      if (r < min) notes.push(`${mode}: ${what} (${fg} ${val(fg)} on ${bg} ${val(bg)}) contrast ${r.toFixed(1)}:1, needs ${min}:1`);
    }
  }
  return notes;
}
