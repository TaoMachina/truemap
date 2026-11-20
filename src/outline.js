// A compact, language-agnostic outline of a repo, so an agent can draw a first blueprint
// without reading every file: folders (two levels), file counts, rough size, manifests, likely entry points.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { gitExe } from './common.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.next', '.nuxt', 'coverage', '.venv', 'venv', '.truemap']);
const MANIFEST = /^(package\.json|pnpm-workspace\.yaml|go\.mod|Cargo\.toml|pyproject\.toml|requirements\.txt|setup\.py|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.csproj|[^/]+\.sln|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|Makefile|deno\.json)$/;
const ENTRY = /(^|\/)(main|index|app|server|cli|program|manage|__main__|wsgi|asgi)\.[a-z]+$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)bin\/[^/]+$/i;
const TEST = /(^|\/)(tests?|__tests__|spec|fixtures?|examples?|docs?)\//i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|jar|exe|dll|so|dylib|mp4|mp3|wav|lock)$/i;

function listFiles(root) {
  // Tracked files only: untracked scratch folders (.tmp-walk/, a stray server.ts) are not the project.
  // A repo with nothing tracked yet falls through to the folder walk.
  try {
    const outText = execFileSync(gitExe(), ['ls-files', '-z', '--cached'], {
      cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const files = outText.split('\0').filter(Boolean).filter((f) => !f.split('/').some((p) => SKIP.has(p)));
    if (files.length) return { gitRepo: true, files };
  } catch { /* not a git repo */ }
  const files = [];
  const walk = (dir, rel, depth) => {
    if (depth > 8 || files.length > 50_000) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.isDirectory())) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r, depth + 1);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(root, '', 0);
  return { gitRepo: false, files };
}

export function outline(root) {
  const { gitRepo, files } = listFiles(root);
  const groups = new Map();
  const langs = new Map();
  const manifests = [];
  const entries = [];
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length === 1 ? '.' : parts.slice(0, Math.min(2, parts.length - 1)).join('/') + '/';
    let size = 0;
    try { size = statSync(join(root, f)).size; } catch { continue; }
    const g = groups.get(key) || { path: key, files: 0, bytes: 0, list: [] };
    g.files++;
    if (!BINARY.test(f)) { g.bytes += size; g.list.push([basename(f), size]); }
    groups.set(key, g);
    const ext = extname(f).toLowerCase();
    if (ext && !BINARY.test(f)) langs.set(ext, (langs.get(ext) || 0) + 1);
    if (parts.length <= 3 && MANIFEST.test(parts[parts.length - 1])) manifests.push(f);
    if (parts.length <= 4 && ENTRY.test(f) && !TEST.test(f) && !BINARY.test(f)) entries.push(f);
  }
  const dirs = [...groups.values()]
    // the top level first, then the folders holding the most code, so the cap drops the small ones
    .sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : (b.bytes - a.bytes) || a.path.localeCompare(b.path)))
    .slice(0, 60)
    .map((g) => ({
      path: g.path, files: g.files, lines: Math.round(g.bytes / 36),
      top: g.list.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n),
    }));
  return {
    name: basename(root), gitRepo, files: files.length,
    manifests: manifests.slice(0, 20),
    languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    dirs,
    entries: entries.sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 15),
  };
}
