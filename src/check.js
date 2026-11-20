// The checker: a language-agnostic tripwire for data-src anchors.
// For each data-src="path#name":
//   broken  - path missing (exact case, relative to repo root) or name no longer present as a whole word
//   changed - the anchored file/dir changed after the page was written (or last marked --ok)
//   ok      - otherwise
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { FOLDER, gitExe, verifiedPath } from './common.js';

const META_RE = /<meta\s+name=["']truemap-verified["']\s+content=["']([^"']*)["']\s*\/?>/i;
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
  return out.map((page) => {
    let at = 0; try { const st = statSync(join(base, page)); at = Math.round(st.birthtimeMs || st.mtimeMs); } catch { /* gone */ }
    return { page, title: readTitle(join(base, page)) || page.replace(/\.html?$/i, ''), at };
  });
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

// Start tags of real elements only. Comments, raw text (script, style, textarea, title) and what is inside
// <pre> and <code> are text, and so is an escaped sample (&lt;div data-src=…&gt;): a draft that shows
// `data-src="src/server.js#start"` as an example must not be checked as an anchor.
const TAG_RE = /<[a-zA-Z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const ATTR_RE = /\s([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function elementTags(html) {
  const text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|textarea|title|pre|code)\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/\1\s*>/gi, (_m, t, a) => `<${t}${a}>`);
  return text.match(TAG_RE) || [];
}
export function attrOf(tag, name) {
  const body = tag.replace(/^<[a-zA-Z][\w:-]*/, '');
  for (const m of body.matchAll(ATTR_RE)) if (m[1].toLowerCase() === name) return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return null;
}

/** The start tags that carry a data-src, with that value: { tag, src }. */
export function anchorTags(html) {
  const out = [];
  for (const tag of elementTags(html)) {
    const v = attrOf(tag, 'data-src');
    if (v !== null && v.trim()) out.push({ tag, src: v.trim() });
  }
  return out;
}

export function extractAnchors(html) {
  return [...new Set(anchorTags(html).map((a) => a.src))];
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
  let records = {};
  try { records = JSON.parse(readFileSync(verifiedPath(root), 'utf8')); } catch { records = {}; }
  return { root, gitRepo, files, dirty, head, contents: new Map(), times: new Map(), records, recordsDirty: false, prints: new Map() };
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

// What an anchor's code looks like now: a hash of the file, or of a folder's file list with sizes and times.
// Drift is judged per anchor against the fingerprint taken when the box was last known to match, so editing
// the page (to add one box) does not quietly clear drift on the others.
function fingerprint(ctx, p) {
  const clean = p.replace(/\/+$/, '');
  if (ctx.prints.has(clean)) return ctx.prints.get(clean);
  const h = createHash('sha1');
  const full = join(ctx.root, clean);
  try {
    const st = statSync(full);
    if (!st.isDirectory()) h.update(st.size > MAX_SCAN_BYTES ? `${st.size}:${st.mtimeMs}` : readFileSync(full));
    else {
      const list = ctx.files ? [...ctx.files].filter((x) => x.startsWith(`${clean}/`)).sort() : [];
      for (const x of list) { try { const t = statSync(join(ctx.root, x)); h.update(`${x}\0${t.size}\0${Math.floor(t.mtimeMs)}\n`); } catch { /* gone */ } }
    }
  } catch { h.update('missing'); }
  const out = h.digest('hex').slice(0, 16);
  ctx.prints.set(clean, out);
  return out;
}
function saveRecords(ctx) {
  if (!ctx.recordsDirty) return;
  try { writeFileSync(verifiedPath(ctx.root), JSON.stringify(ctx.records)); ctx.recordsDirty = false; } catch { /* ignore */ }
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
    const key = `${page}|${src}`;
    const fp = fingerprint(ctx, path);
    const rec = ctx.records[key];
    const since = ctx.records[`@${key}`] || (pageTime ? new Date(pageTime * 1000).toISOString() : null);
    if (rec !== undefined) {
      return rec === fp ? { src, path, name, state: 'ok', reason: '' } : { src, path, name, state: 'changed', since, reason: `${path} changed since this box was last checked` };
    }
    // No fingerprint yet: fall back to times (code newer than the page), then remember the code as it is.
    const t = changeTime(ctx, path.replace(/\/+$/, ''));
    if (t !== null && pageTime && t > pageTime) {
      return { src, path, name, state: 'changed', since, reason: `${path} changed after this page was last updated` };
    }
    ctx.records[key] = fp; ctx.records[`@${key}`] = new Date().toISOString(); ctx.recordsDirty = true;
    return { src, path, name, state: 'ok', reason: '' };
  });
  const counts = { ok: 0, changed: 0, broken: 0 };
  for (const a of anchors) counts[a.state]++;
  const wireCount = [...html.matchAll(/\sdata-to\s*=\s*["']([^"']*)["']/gi)].reduce((n, m) => n + m[1].split(/[\s,]+/).filter(Boolean).length, 0);
  return { page, anchors, counts, wires: checkWires(html), wireCount, layout: checkLayout(html) };
}

/** Maps that are too big to read at a glance (the guide: at most 12 boxes per map, 4 per layer). */
export function checkLayout(html) {
  const notes = [];
  const NODE = /class=["'][^"']*\btm-node(?![-\w])/g;
  const maps = html.split(/class=["'][^"']*\btm-(?:map|blueprint)(?![-\w])/).slice(1);
  maps.forEach((body, i) => {
    const total = (body.match(NODE) || []).length;
    if (total > 16) notes.push(`map ${i + 1} has ${total} boxes; 16 is the most a map can carry, move the detail to a module page`);
    body.split(/class=["'][^"']*\btm-layer(?![-\w])/).slice(1).forEach((layer, j) => {
      const n = (layer.match(NODE) || []).length;
      if (n > 4) notes.push(`map ${i + 1}, layer ${j + 1} has ${n} boxes; keep it to 4`);
    });
  });
  return notes.concat(lintDiagrams(html));
}

// Most boxes one box may wire to. A map has 7-12 boxes; 5 targets is already half of a 10-box map and
// as many as a full group (5) holds. Past that the wires leave one side of the box together, their curves
// overlap into one bundle and their labels collide, so no single connection can be followed.
const MAX_FANOUT = 5;

/** The rules of a v0.5 map (figure.tm-diagram), checked so a page that breaks them is told why. */
export function lintDiagrams(html) {
  const notes = [];
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')); return m ? decodeEntities(m[1] ?? m[2] ?? '') : null; };
  const figs = html.split(/<figure\b[^>]*class=["'][^"']*\btm-diagram\b[^"']*["'][^>]*>/i).slice(1).map((b) => b.split(/<\/figure>/i)[0]);
  figs.forEach((body, i) => {
    const where = figs.length > 1 ? `map ${i + 1}: ` : 'map: ';
    const nodes = [...body.matchAll(/<(?:div|a)\b[^>]*class=["'][^"']*\btm-node\b[^"']*["'][^>]*>/gi)].map((m) => m[0]);
    const ids = new Set(nodes.map((t) => attr(t, 'id')).filter(Boolean));
    if (nodes.length > 16) notes.push(`${where}${nodes.length} boxes; 16 is the most a map can carry. Merge minor neighbours or give a part its own page.`);
    const groups = (body.match(/<section\b[^>]*class=["'][^"']*\btm-group\b/gi) || []).length;
    if (!groups && nodes.length > 4) notes.push(`${where}no groups. Put the boxes in <section class="tm-group" data-label="…"> by responsibility.`);
    for (const sec of body.matchAll(/<section\b[^>]*class=["'][^"']*\btm-group\b[^>]*>([\s\S]*?)<\/section>/gi)) {
      const n = (sec[1].match(/class=["'][^"']*\btm-node\b/gi) || []).length;
      const label = sec[0].match(/data-label=["']([^"']+)/)?.[1] || 'a group';
      if (n > 5) notes.push(`${where}group "${label}" has ${n} boxes; keep a group to 5 or fewer (split it by responsibility) so it reads as one row.`);
    }
    if (groups > 5) notes.push(`${where}${groups} groups; 3-5 read at a glance. Merge a small group into the neighbour with the same responsibility, or give a part its own page.`);
    // Connections as the map draws them: data-to on a box, to another box on this map, once per pair.
    const out = new Map(); const wired = new Set();
    for (const t of nodes) {
      const from = attr(t, 'id');
      if (!from) continue;
      const to = new Set((attr(t, 'data-to') || '').split(/[\s,]+/).filter(Boolean).map((s) => s.split(':')[0]).filter((x) => x !== from && ids.has(x)));
      out.set(from, to);
      if (to.size) wired.add(from);
      for (const x of to) wired.add(x);
    }
    if (nodes.length > 1 && !wired.size) notes.push(`${where}no connections. Give each box data-to="id:verb" for what it calls or feeds.`);
    else {
      for (const t of nodes) {
        const id = attr(t, 'id');
        if (!id) continue;
        const label = attr(t, 'data-name') || id;
        if (!wired.has(id)) notes.push(`${where}box "${label}" has no connections, so it reads as clutter. Connect it (data-to on it or on what calls it), or fold it into a neighbour's .tm-detail.`);
        const n = out.get(id)?.size || 0;
        if (n > MAX_FANOUT) notes.push(`${where}box "${label}" has ${n} outgoing connections; past ${MAX_FANOUT} they merge into one bundle of lines. Keep the ones on the main paths and name the rest in its .tm-detail, or split the box by responsibility.`);
      }
    }
    const outside = body.replace(/<section\b[^>]*class=["'][^"']*\btm-group\b[\s\S]*?<\/section>/gi, '');
    const loose = (outside.match(/class=["'][^"']*\btm-node\b/gi) || []).length;
    if (groups && loose) notes.push(`${where}${loose} box(es) outside any group; every box belongs to one group.`);
    for (const t of nodes) {
      const id = attr(t, 'id'); const name = attr(t, 'data-name'); const tag = attr(t, 'data-tag'); const label = name || id || '(a box)';
      if (!id) notes.push(`${where}a box without an id ("${label}"); connections and flows need ids.`);
      if (!name) notes.push(`${where}box "${id}" has no data-name.`);
      else if (name.split(/\s+/).length > 4 || name.length > 28) notes.push(`${where}box name "${name}" is long; use 1-3 words from the code and put the rest in .tm-detail.`);
      if (tag && (tag.split(/\s+/).length > 4 || tag.length > 32)) notes.push(`${where}tag "${tag}" on "${label}" is long; one short word or path fragment.`);
      if (!attr(t, 'data-src') && !/\bis-ext\b/.test(attr(t, 'class') || '')) notes.push(`${where}box "${label}" has no data-src; anchor it to its code, or mark it is-ext if it is outside the code.`);
    }
    for (const m of body.matchAll(/<li\b[^>]*\sdata-path\s*=\s*["']([^"']*)["']/gi)) {
      const path = m[1].split(/[\s,]+/).filter(Boolean);
      for (const id of path) if (!ids.has(id)) notes.push(`${where}flow step "${id}" is not a box id on this map.`);
      // A lit flow numbers the wire from each step to the next, in that direction only (diagram.js markFlow):
      // a pair with no such wire shows no number and no line, and the flow reads as missing a step.
      const name = body.slice(m.index + m[0].length).split(/<\/li>|<li\b/i)[0].replace(/^[^>]*>/, '').replace(/<[^>]+>/g, '').trim() || m[1];
      path.forEach((a, i) => {
        const b = path[i + 1];
        if (!b || a === b || !ids.has(a) || !ids.has(b) || out.get(a)?.has(b)) return;
        const back = out.get(b)?.has(a);
        notes.push(`${where}flow "${name}": no wire from "${a}" to "${b}"${back ? ` (the wire goes from "${b}" to "${a}")` : ''}, so step ${i + 1} is not drawn. List the steps in the direction the wires point${back ? '' : `, or add data-to="${b}:…" on "${a}"`}.`);
      });
    }
  });
  if (figs.length && /<style\b|\sstyle\s*=\s*["'][^"']*(?:color|background|font|border)/i.test(html)) notes.push('page sets its own colours or fonts; the look is fixed so every map reads the same. Remove <style> and style="…".');
  return notes;
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
  const results = list.map((p) => checkPage(ctx, p));
  saveRecords(ctx);
  return { gitRepo: ctx.gitRepo, results };
}

/** Stamps the page as reviewed now, which clears its "changed" marks. */
export function markOk(root, page, boxes) {
  const rel = pageInFolder(root, page);
  if (!rel) return false;
  const file = join(root, FOLDER, rel);
  if (!existsSync(file)) return false;
  let html = readFileSync(file, 'utf8');
  const tag = `<meta name="truemap-verified" content="${new Date().toISOString()}">`;
  if (boxes?.length) { // one box: its fingerprint only
    const ctx = createContext(root);
    const only = new Set(boxes.flatMap((b) => { const t = html.match(new RegExp(`<[^>]*\\sid=["']${escapeRe(b)}["'][^>]*>`))?.[0]; return [b, t?.match(/data-src=["']([^"']+)/)?.[1]].filter(Boolean); }));
    const anchors = extractAnchors(html);
    const unknown = boxes.filter((b) => !anchors.includes(b) && !anchors.some((a) => only.has(a) && html.includes(`id="${b}"`)));
    if (unknown.length) throw new Error(`no box with an anchor named ${unknown.join(', ')} on ${rel} (use a box id or its data-src)`);
    for (const src of extractAnchors(html)) { if (!only.has(src)) continue; const { path } = parseAnchor(src); if (path) { ctx.records[`${rel}|${src}`] = fingerprint(ctx, path); ctx.records[`@${rel}|${src}`] = new Date().toISOString(); } }
    ctx.recordsDirty = true; saveRecords(ctx);
    return true;
  }
  if (META_RE.test(html)) html = html.replace(META_RE, tag);
  else if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  else html = `${tag}\n${html}`;
  writeFileSync(file, html);
  // every box on the page matches its code as it is now
  const ctx = createContext(root);
  const only = boxes?.length ? new Set(boxes.flatMap((b) => { const tag = html.match(new RegExp(`<[^>]*\\sid=["']${escapeRe(b)}["'][^>]*>`))?.[0]; return [b, tag?.match(/data-src=["']([^"']+)/)?.[1]].filter(Boolean); })) : null;
  for (const src of extractAnchors(html)) { if (only && !only.has(src)) continue; const { path } = parseAnchor(src); if (path) { ctx.records[`${rel}|${src}`] = fingerprint(ctx, path); ctx.records[`@${rel}|${src}`] = new Date().toISOString(); } }
  ctx.recordsDirty = true; saveRecords(ctx);
  return true;
}
