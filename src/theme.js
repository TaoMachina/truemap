// Dark mode follows the system unless the user picks one. The stylesheets keep plain
// `@media (prefers-color-scheme: dark)` blocks; this turns each into rules that also answer to a choice:
//   <html data-theme="dark">  always dark      <html data-theme="light">  always light
// For a shadow root, the host carries the choice as a class instead (tm-dark / tm-light).

function blocks(css) {
  // top-level `@media (prefers-color-scheme: dark) { ... }` blocks, with their positions
  const out = [];
  const re = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1; let i = re.lastIndex;
    for (; i < css.length && depth; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; }
    out.push({ start: m.index, bodyStart: re.lastIndex, end: i });
    re.lastIndex = i;
  }
  return out;
}

function scopeRules(body, pick) {
  // `sel, sel { decls }` pairs (no nested blocks inside a colour-scheme block)
  return body.replace(/([^{}]+)\{([^{}]*)\}/g, (all, sels, decls) => `${sels.split(',').map((x) => pick(x.trim())).filter(Boolean).join(', ')} {${decls}}`);
}

/** CSS for a document: dark when chosen, or when the system is dark and light was not chosen. */
export function themeable(css, { host = false } = {}) {
  const found = blocks(css);
  if (!found.length) return css;
  const on = host ? ':host(.tm-dark)' : ':root[data-theme="dark"]';
  const notOff = host ? ':host(:not(.tm-light))' : ':root:not([data-theme="light"])';
  const scope = (prefix) => (sel) => {
    if (!sel) return '';
    if (!host && sel.startsWith(':root')) return prefix + sel.slice(5);
    if (!host && /^html\b/.test(sel)) return prefix.replace(':root', 'html') + sel.slice(4);
    return `${prefix} ${sel}`;
  };
  let out = ''; let at = 0; const forced = [];
  for (const b of found) {
    const body = css.slice(b.bodyStart, b.end - 1);
    out += css.slice(at, b.bodyStart) + scopeRules(body, scope(notOff)) + '}';
    forced.push(scopeRules(body, scope(on)));
    at = b.end;
  }
  const scheme = host ? '' : ':root[data-theme="light"] { color-scheme: light; }\n:root[data-theme="dark"] { color-scheme: dark; }\n';
  return `${out}${css.slice(at)}\n/* the user's choice */\n${scheme}${forced.join('\n')}\n`;
}
