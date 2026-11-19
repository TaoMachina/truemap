// Turns a .truemap page into one self-contained HTML file: the kit, fonts, local images and the
// wire drawing are inlined, so it opens anywhere (email, a PR, a shared drive) without truemap running.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { FOLDER, PKG_DIR, VERSION } from './common.js';

const KIT_DIR = join(PKG_DIR, 'kit');
const UI_DIR = join(PKG_DIR, 'src', 'ui');
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** A file inside dir, refusing traversal and symlinks that lead out. */
export function insideFile(dir, rel) {
  try {
    if (lstatSync(dir).isSymbolicLink()) return null;
    const full = resolve(dir, '.' + sep + String(rel).replace(/\//g, sep));
    if (full !== dir && !full.startsWith(dir + sep)) return null;
    if (!existsSync(full)) return null;
    const real = realpathSync(full); const realDir = realpathSync(dir);
    if (!real.startsWith(realDir + sep) || statSync(real).isDirectory()) return null;
    return real;
  } catch { return null; }
}

/** The page kit as served: a repo's own assets/truemap.css wins; assets/theme.css is appended. */
export function kitCss(root) {
  const folder = join(root, FOLDER);
  const own = insideFile(folder, 'assets/truemap.css');
  let css = readFileSync(own || join(KIT_DIR, 'truemap.css'), 'utf8');
  const theme = insideFile(folder, 'assets/theme.css');
  if (theme) css += `\n/* .truemap/assets/theme.css */\n${readFileSync(theme, 'utf8')}`;
  return css;
}

export function exportPage(root, page) {
  const folder = join(root, FOLDER);
  const file = insideFile(folder, page);
  if (!file) throw new Error(`page not found: ${FOLDER}/${page}`);
  let html = readFileSync(file, 'utf8');
  const pageDir = dirname(file);

  // Fonts become data URIs so the export looks the same offline.
  const css = kitCss(root).replace(/url\("\/__truemap\/fonts\/([\w.-]+\.woff2)"\)/g, (m, name) => {
    const f = join(KIT_DIR, 'fonts', name);
    return existsSync(f) ? `url("data:font/woff2;base64,${readFileSync(f).toString('base64')}")` : m;
  });
  const kitLink = /<link\b[^>]*href=["'](?:\.\.\/)*assets\/truemap\.css["'][^>]*>/i;
  html = kitLink.test(html) ? html.replace(kitLink, () => `<style>\n${css}\n</style>`) : html.replace(/<\/head>/i, () => `<style>\n${css}\n</style>\n</head>`);

  // Local images next to the page.
  html = html.replace(/(<img\b[^>]*\bsrc=["'])([^"':]+?)(["'])/gi, (m, a, src, b) => {
    const type = IMG[extname(src).toLowerCase()];
    const f = type && insideFile(folder, relative(folder, join(pageDir, src)).split(sep).join('/'));
    return f ? `${a}data:${type};base64,${readFileSync(f).toString('base64')}${b}` : m;
  });

  const wires = [join(KIT_DIR, 'vendor', 'dagre.min.js'), join(UI_DIR, 'wires.js'), join(UI_DIR, 'diagram.js')].map((f) => readFileSync(f, 'utf8')).join('\n;\n');
  const boot = `<script>\n${wires}\n(() => { const d = () => { window.truemapDiagram.draw(); window.truemapWires.draw(); window.truemapWires.mark && window.truemapWires.mark(); }; window.truemapWires.interact(); window.truemapDiagram.interact(); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', d); else d(); addEventListener('resize', d); document.fonts && document.fonts.ready.then(d); })();\n</script>`;
  const stamp = `<!-- Exported by truemap ${VERSION} from ${FOLDER}/${page} on ${new Date().toISOString().slice(0, 10)}. Links to other pages need the .truemap folder. -->`;
  const note = `<p style="max-width:960px;margin:0 auto;padding:0 48px 40px;font:13px/1.5 var(--tm-font);color:var(--tm-pencil)">Exported from <code>${FOLDER}/${page}</code> with truemap. Links to other pages work inside the project's ${FOLDER} folder.</p>`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${note}\n${boot}\n</body>`) : html + note + boot;
  return /<!doctype[^>]*>/i.test(html) ? html.replace(/<!doctype[^>]*>/i, (d) => `${d}\n${stamp}`) : `${stamp}\n${html}`;
}
