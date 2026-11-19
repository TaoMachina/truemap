// The checker: a language-agnostic tripwire for data-src anchors.
// For each data-src="path#name":
//   broken  - path missing (exact case, relative to repo root) or name no longer present as a whole word
//   changed - the anchored file/dir changed after the page was written (or last marked --ok)
//   ok      - otherwise
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { FOLDER, gitExe } from './common.js';

const META_RE = /<meta\s+name=["']truemap-verified["']\s+content=["']([^"']*)["']\s*\/?>/i;
const ANCHOR_RE = /\bdata-src\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function git(root, args) {
  const exe = gitExe();
  if (!exe) return null;
  try {
    return execFileSync(exe, args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch { return null; }
}

export function isGitRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

/** Resolves a page path given by a user/agent to a path inside .truemap, or null if it escapes. */
export function pageInFolder(root, page) {
  const base = resolve(root, FOLDER);
  const full = resolve(base, String(page || '').replace(/\\/g, '/'));
  const rel = relative(base, full);
  if (!rel || rel.startsWith('..') || resolve(base, rel) !== full) return null;
  return rel.split(sep).join('/');
}

/** All HTML pages under .truemap (excluding assets/), index.html first. */
export function listPages(root) {
  const base = join(root, FOLDER);
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      const rel = relative(base, full).split(sep).join('/');
      if (e.isDirectory()) { if (rel !== 'assets') walk(full); continue; }
      if (e.isFile() && /\.html?$/i.test(e.name)) out.push(rel);
    }
  };
  walk(base);
  out.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  return out.map((page) => ({ page, title: readTitle(join(base, page)) || page.replace(/\.html?$/i, '') }));
}

function readTitle(file) {
  try {
    const m = readFileSync(file, 'utf8').match(TITLE_RE);
    return m ? decodeEntities(m[1].trim()) : null;
  } catch { return null; }
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function extractAnchors(html) {
  const seen = new Set();
  for (const m of html.matchAll(ANCHOR_RE)) {
    const v = decodeEntities((m[1] ?? m[2] ?? '').trim());
    if (v) seen.add(v);
  }
  return [...seen];
}

export function parseAnchor(raw) {
  const i = raw.indexOf('#');
  const path = (i === -1 ? raw : raw.slice(0, i)).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const name = i === -1 ? '' : raw.slice(i + 1).trim();
  return { path, name };
}

// Last-commit times of clean paths don't change until HEAD moves: cache them across runs.
const logCache = new Map();

/** Builds a per-run context so repeated anchors don't re-run git. */
export function createContext(root) {
  const gitRepo = isGitRepo(root);
  let files = null; let dirty = new Set(); let head = '';
  if (gitRepo) {
    const tracked = git(root, ['ls-files', '-z']) ?? '';
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '';
    files = new Set((tracked + untracked).split('\0').filter(Boolean));
    head = (git(root, ['rev-parse', 'HEAD']) ?? '').trim();
    // One status call per run; -z keeps paths unquoted. Renames carry the old path as an extra field.
    const status = (git(root, ['status', '--porcelain', '-z', '--untracked-files=all']) ?? '').split('\0');
    for (let i = 0; i < status.length; i++) {
      const entry = status[i];
      if (!entry) continue;
      dirty.add(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') i++;
    }
  }
  return { root, gitRepo, files, dirty, head, contents: new Map(), times: new Map() };
}

function onDisk(root, p) { try { statSync(join(root, p)); return true; } catch { return false; } }

function pathExists(ctx, p) {
  if (!p) return { exists: false, isDir: false };
  const clean = p.replace(/\/+$/, '');
  if (ctx.files) {
    if (ctx.files.has(clean)) return { exists: onDisk(ctx.root, clean), isDir: false };
    const prefix = clean + '/';
    for (const f of ctx.files) if (f.startsWith(prefix) && onDisk(ctx.root, f)) return { exists: true, isDir: true };
    return { exists: false, isDir: false };
  }
  // No git: exact-case walk of each segment.
  let dir = ctx.root;
  for (const part of clean.split('/')) {
    let names;
    try { names = readdirSync(dir); } catch { return { exists: false, isDir: false }; }
    if (!names.includes(part)) return { exists: false, isDir: false };
    dir = join(dir, part);
  }
  try { return { exists: true, isDir: statSync(dir).isDirectory() }; } catch { return { exists: false, isDir: false }; }
}

function isDirty(ctx, p) {
  if (ctx.dirty.has(p)) return true;
  const prefix = p + '/';
  for (const d of ctx.dirty) if (d.startsWith(prefix) || (d.endsWith('/') && p.startsWith(d))) return true;
  return false;
}

function newestMtime(root, p) {
  const full = join(root, p);
  try {
    const st = statSync(full);
    if (!st.isDirectory()) return Math.floor(st.mtimeMs / 1000);
  } catch { return Math.floor(Date.now() / 1000); }
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else { try { newest = Math.max(newest, statSync(f).mtimeMs); } catch { /* ignore */ } }
    }
  };
  walk(full, 0);
  return Math.floor(newest / 1000) || Math.floor(Date.now() / 1000);
}

/** Last-change time in seconds: mtime if dirty/untracked, else last commit time. Null without git. */
function changeTime(ctx, p) {
  if (!ctx.gitRepo) return null;
  if (ctx.times.has(p)) return ctx.times.get(p);
  let t;
  if (isDirty(ctx, p)) {
    t = newestMtime(ctx.root, p);
  } else {
    const key = `${ctx.root}\0${ctx.head}\0${p}`;
    if (logCache.has(key)) t = logCache.get(key);
    else {
      const n = parseInt((git(ctx.root, ['log', '-1', '--format=%ct', '--', p]) ?? '').trim(), 10);
      t = Number.isFinite(n) ? n : Math.floor(Date.now() / 1000);
      if (logCache.size > 20000) logCache.clear();
      logCache.set(key, t);
    }
  }
  ctx.times.set(p, t);
  return t;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** True/false, or null when the file is too large to scan (then we don't call it broken). */
function hasWholeWord(ctx, p, name) {
  let text = ctx.contents.get(p);
  if (text === undefined) {
    try {
      const full = join(ctx.root, p);
      text = statSync(full).size > MAX_SCAN_BYTES ? null : readFileSync(full, 'utf8');
    } catch { text = ''; }
    ctx.contents.set(p, text);
  }
  if (text === null) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRe(name)}(?![\\p{L}\\p{N}_$])`, 'u').test(text);
}

export function readVerified(html) {
  const m = html.match(META_RE);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Checks one page. Returns { page, anchors: [{src, path, name, state, reason}], counts }. */
export function checkPage(ctx, page) {
  const file = join(ctx.root, FOLDER, page);
  let html = '';
  try { html = readFileSync(file, 'utf8'); } catch {
    return { page, missing: true, anchors: [], counts: { ok: 0, changed: 0, broken: 0 } };
  }
  const pageTime = Math.max(changeTime(ctx, `${FOLDER}/${page}`) ?? 0, readVerified(html) ?? 0);
  const anchors = extractAnchors(html).map((src) => {
    const { path, name } = parseAnchor(src);
    const { exists, isDir } = pathExists(ctx, path);
    if (!exists) return { src, path, name, state: 'broken', reason: `path not found: ${path}` };
    if (name && !isDir && hasWholeWord(ctx, path, name) === false) {
      return { src, path, name, state: 'broken', reason: `"${name}" no longer appears in ${path}` };
    }
    const t = changeTime(ctx, path.replace(/\/+$/, ''));
    if (t !== null && pageTime && t > pageTime) {
      return { src, path, name, state: 'changed', reason: `${path} changed after this page was last updated` };
    }
    return { src, path, name, state: 'ok', reason: '' };
  });
  const counts = { ok: 0, changed: 0, broken: 0 };
  for (const a of anchors) counts[a.state]++;
  return { page, anchors, counts, wires: checkWires(html) };
}

/** Map wires whose data-to names an id that is not on the page (they would silently not be drawn). */
export function checkWires(html) {
  const ID = /\sid\s*=\s*["']([^"']+)["']/i;
  const ids = new Set([...html.matchAll(new RegExp(ID.source, 'gi'))].map((m) => m[1]));
  const problems = [];
  for (const m of html.matchAll(/<[^>]*\sdata-to\s*=\s*["']([^"']*)["'][^>]*>/gi)) {
    const from = (m[0].match(ID) || [])[1] || '(a box without an id)';
    for (const spec of m[1].split(/[\s,]+/).filter(Boolean)) {
      const to = spec.split(':')[0];
      if (!ids.has(to)) problems.push({ from, to, reason: `no element with id="${to}"` });
    }
  }
  return problems;
}

export function checkAll(root, pages) {
  const ctx = createContext(root);
  const list = pages ?? listPages(root).map((p) => p.page);
  return { gitRepo: ctx.gitRepo, results: list.map((p) => checkPage(ctx, p)) };
}

/** Stamps the page as reviewed now, which clears its "changed" marks. */
export function markOk(root, page) {
  const rel = pageInFolder(root, page);
  if (!rel) return false;
  const file = join(root, FOLDER, rel);
  if (!existsSync(file)) return false;
  let html = readFileSync(file, 'utf8');
  const tag = `<meta name="truemap-verified" content="${new Date().toISOString()}">`;
  if (META_RE.test(html)) html = html.replace(META_RE, tag);
  else if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  else html = `${tag}\n${html}`;
  writeFileSync(file, html);
  return true;
}
