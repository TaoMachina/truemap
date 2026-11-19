// Can people read it? The colour tokens a project ends up with (kit + .truemap/assets/theme.css), light and
// dark, and the pairs that must stay readable.

function hex(c) {
  const m = String(c).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const r = String(c).trim().match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  return r ? [+r[1], +r[2], +r[3]] : null;
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
      if (r != null && r < min) notes.push(`${mode}: ${what} (${fg} ${val(fg)} on ${bg} ${val(bg)}) contrast ${r.toFixed(1)}:1, needs ${min}:1`);
    }
  }
  return notes;
}
