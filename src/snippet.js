// The real code behind a box: a few lines around `name` in `path`, read from the repo.
// Only files git tracks (or, without git, files inside the repo that aren't hidden) are served, so a
// page can never pull out .env or anything ignored.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { gitExe } from './common.js';
import { parseAnchor } from './check.js';

const MAX_BYTES = 2 * 1024 * 1024;

function git(root, args) {
  try {
    return execFileSync(gitExe(), args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch { return null; }
}

export function snippet(root, src, around = 10) {
  const { path, name } = parseAnchor(String(src || ''));
  if (!path || path.endsWith('/')) return { path, kind: 'folder' };
  const full = resolve(root, '.' + sep + path.replace(/\//g, sep));
  if (!full.startsWith(resolve(root) + sep) || !existsSync(full)) return { path, error: 'not found' };
  try { if (!realpathSync(full).startsWith(realpathSync(root) + sep)) return { path, error: 'outside the repo' }; } catch { return { path, error: 'not found' }; }
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', path]);
  if (tracked === null) {
    if (git(root, ['rev-parse', '--is-inside-work-tree']) !== null) return { path, error: 'not tracked by git' };
    if (path.split('/').some((p) => p.startsWith('.'))) return { path, error: 'hidden file' };
  }
  const st = statSync(full);
  if (st.isDirectory()) return { path, kind: 'folder' };
  if (st.size > MAX_BYTES) return { path, error: 'file too large to show' };
  const text = readFileSync(join(full), 'utf8');
  if (text.includes('\0')) return { path, error: 'binary file' };
  const lines = text.split(/\r?\n/);
  let line = 0;
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u');
    // Prefer the line that defines the name over lines that merely use it:
    // 1. a keyword right before it (function x, class X, def x, const x = …), or x: / x = a function,
    //    or a method header at the start of a line (async x(…) {) that is not a call (this.x(…))
    // 2. any line with a defining keyword   3. the first mention
    const strong = [
      new RegExp(`\\b(function\\*?|class|def|fn|func|interface|type|struct|enum|trait|impl|module|const|let|var|val)\\s+${esc}(?![\\p{L}\\p{N}_$])`, 'u'),
      new RegExp(`(?<![.\\p{L}\\p{N}_$])${esc}\\s*[:=]\\s*(async\\s*)?(function|\\(|[\\p{L}_$][\\p{L}\\p{N}_$]*\\s*=>)`, 'u'),
      // a method header: name(…) { or name(…): Type { on one line, or name( with the parameters continuing below
      new RegExp(`^\\s*((public|private|protected|static|async|override|readonly|get|set)\\s+)*${esc}\\s*(<[^>]*>)?\\s*\\((.*\\)\\s*(:[^=]*?)?\\s*\\{\\s*$|[^)]*$)`, 'u'),
    ];
    const weak = /\b(function|class|def|fn|func|const|let|var|type|interface|export|struct|enum|router\.\w+|app\.\w+)\b/;
    const hits = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) return { path, name, missing: true, total: lines.length };
    line = hits.find((i) => strong.some((s) => s.test(lines[i]))) ?? hits.find((i) => weak.test(lines[i])) ?? hits[0] ?? 0;
  }
  const start = Math.max(0, line - 3);
  const end = Math.min(lines.length, start + around * 2 + 1);
  const changed = git(root, ['log', '-1', '--format=%cr', '--', path]);
  return {
    path, name, line: line + 1, start: start + 1, total: lines.length,
    lines: lines.slice(start, end).map((l) => (l.length > 220 ? `${l.slice(0, 220)}…` : l)),
    lastChange: changed ? changed.trim() : '',
  };
}
