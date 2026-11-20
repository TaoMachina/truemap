// Change review: what changed since a base, attributed to the boxes on the pages.
// Attribution is by file: a box owns the file (or folder) its data-src names. Two boxes on one file
// both show that file's change, and say so.
//
// Bases:
//   turn  – the working tree when the agent last picked up a message (its turn began)
//   plan  – the working tree when the user approved the agent's plan
//   head  – the last commit (uncommitted changes)
//   main  – where this branch left the default branch
// Snapshots are git tree objects written through a throwaway copy of the index, so the user's staging
// area is never touched. Files under .truemap/ are pages, not code, and are left out.
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOLDER, gitExe } from './common.js';
import { anchorTags, attrOf, extractAnchors, listPages, parseAnchor } from './check.js';

function git(root, args, env) {
  const exe = gitExe();
  if (!exe) return Promise.resolve(null);
  return new Promise((ok) => {
    execFile(exe, args, { cwd: root, env: env || process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) => ok(err ? null : out));
  });
}

/** A tree object for the working tree as it is now (tracked and untracked files, .gitignore honoured). */
export async function snapshotTree(root) {
  const dir = mkdtempSync(join(tmpdir(), 'truemap-idx-'));
  const index = join(dir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    // Start from a copy of the real index: its stat cache means only changed files are hashed again.
    const real = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))?.trim();
    try { if (real) copyFileSync(real, index); } catch { /* a repo without an index yet */ }
    if (await git(root, ['add', '-A', '--', '.', `:(exclude)${FOLDER}`], env) === null) return null;
    return (await git(root, ['write-tree'], env))?.trim() || null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The default branch this branch started from, as a commit. */
async function mainBase(root) {
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  const candidates = [head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean);
  for (const ref of candidates) {
    const mb = (await git(root, ['merge-base', 'HEAD', ref]))?.trim();
    if (mb) return { commit: mb, ref: ref.replace(/^origin\//, '') };
  }
  return null;
}

export async function resolveBase(root, kind, snapshots = {}) {
  // auto: the plan while it is being built and in the turn that closed it; after that, the turn
  const closedEarlier = snapshots.plan && snapshots.planEnd?.slug === snapshots.plan.slug && snapshots.turn && snapshots.planEnd.at < snapshots.turn.at;
  const want = kind && kind !== 'auto' ? kind : snapshots.plan && !closedEarlier ? 'plan' : snapshots.turn ? 'turn' : 'head';
  if (want === 'plan' && snapshots.plan) {
    const end = snapshots.planEnd?.slug === snapshots.plan.slug ? snapshots.planEnd : null;
    return { kind: 'plan', tree: snapshots.plan.tree, to: end?.tree, at: snapshots.plan.at, label: end ? 'What was done for the plan' : 'Since you approved the plan' };
  }
  if (want === 'turn' && snapshots.turn) return { kind: 'turn', tree: snapshots.turn.tree, at: snapshots.turn.at, label: 'Since the agent’s last turn began' };
  if (want === 'main') {
    const m = await mainBase(root);
    if (m) return { kind: 'main', tree: `${m.commit}^{tree}`, label: `This branch vs ${m.ref}` };
  }
  const head = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']))?.trim();
  return head ? { kind: 'head', tree: head, label: 'Uncommitted changes' } : null;
}

/** Changed files between two trees: [{ path, add, del, status }] (binary files have add/del null). */
async function diffFiles(root, from, to) {
  const num = await git(root, ['diff', '--no-renames', '--numstat', '-z', from, to, '--', '.', `:(exclude)${FOLDER}`]);
  const names = await git(root, ['diff', '--no-renames', '--name-status', '-z', from, to, '--', '.', `:(exclude)${FOLDER}`]);
  if (num === null || names === null) return null;
  const status = new Map();
  const ns = names.split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i][0]);
  const out = [];
  for (const rec of num.split('\0')) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
    if (!m) continue;
    out.push({ path: m[3], add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2], status: status.get(m[3]) || 'M' });
  }
  return out;
}

const anchorCovers = (anchorPath, file) => {
  const a = anchorPath.replace(/\/+$/, '');
  return file === a || file.startsWith(`${a}/`);
};

/** Boxes (by data-src) that cover each changed file, per page; files no page covers, grouped by folder. */
export function attribute(root, files) {
  const pages = listPages(root);
  const anchors = []; // { page, src, path }
  for (const { page } of pages) {
    let html = '';
    try { html = readFileSync(join(root, FOLDER, page), 'utf8'); } catch { continue; }
    for (const src of extractAnchors(html)) {
      const { path } = parseAnchor(src);
      if (path) anchors.push({ page, src, path, own: true });
    }
    // data-also="server/db.ts server/hub.ts": more files a box owns (its migration, its wiring)
    for (const { tag, src } of anchorTags(html)) {
      const also = attrOf(tag, 'data-also');
      for (const p of (also || '').split(/[\s,]+/).filter(Boolean)) anchors.push({ page, src, path: p.replace(/^\.?\//, '') });
    }
  }
  const names = new Map();
  for (const { page } of pages) {
    let html = '';
    try { html = readFileSync(join(root, FOLDER, page), 'utf8'); } catch { continue; }
    for (const { tag, src } of anchorTags(html)) {
      const nm = attrOf(tag, 'data-name');
      if (nm && !names.has(src)) names.set(src, nm);
    }
  }
  const boxes = new Map(); // src -> { src, pages:Set, files:[] }
  const unmapped = [];
  for (const f of files) {
    const hits = anchors.filter((a) => anchorCovers(a.path, f.path));
    if (!hits.length) { unmapped.push(f); continue; }
    const srcs = [...new Set(hits.map((h) => h.src))];
    for (const h of hits) {
      if (!boxes.has(h.src)) boxes.set(h.src, { src: h.src, pages: new Set(), files: [] });
      const b = boxes.get(h.src); b.pages.add(h.page);
      if (!b.files.some((x) => x.path === f.path)) b.files.push({ ...f, shared: srcs.length - 1, own: !!h.own || hits.some((x) => x.src === h.src && x.own) });
    }
  }
  const sum = (list, k) => list.reduce((n, f) => n + (f[k] || 0), 0);
  const boxList = [...boxes.values()].map((b) => ({ src: b.src, name: names.get(b.src) || '', pages: [...b.pages], files: b.files, isNew: b.files.length > 0 && b.files.every((x) => x.status === 'A'), add: sum(b.files, 'add'), del: sum(b.files, 'del') }))
    .sort((a, b) => (b.add + b.del) - (a.add + a.del));
  const folders = new Map();
  const dirOf = (p) => p.replace(/\/?[^/]*$/, '');
  for (const f of unmapped) {
    // a file in the same folder as a box's file is probably part of it: say so
    const near = [...new Set(anchors.filter((a) => dirOf(a.path) === dirOf(f.path) && a.path.includes('.')).map((a) => a.src))];
    if (near.length && near.length <= 2) f.near = near; // in a flat folder every box is a neighbour: no hint
    const parts = f.path.split('/');
    const key = parts.length > 2 ? `${parts.slice(0, 2).join('/')}/` : parts.length === 2 ? `${parts[0]}/` : '(top level)';
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key).push(f);
  }
  return { boxes: boxList, unmapped: [...folders.entries()].map(([folder, list]) => ({ folder, files: list })), pagesWithAnchors: pages.length };
}

/** Everything the Changes view needs. */
export async function changes(root, kind, snapshots) {
  const base = await resolveBase(root, kind, snapshots);
  if (!base) return { error: 'not a git repository, or no commits yet' };
  const now = base.to || await snapshotTree(root);
  if (!now) return { error: 'could not read the working tree' };
  const files = await diffFiles(root, base.tree, now);
  if (!files) return { error: 'git diff failed' };
  const bases = [snapshots.plan && 'plan', snapshots.turn && 'turn', 'head', 'main'].filter(Boolean);
  return { base: { kind: base.kind, label: base.label, at: base.at || null }, bases, files_list: files.map((x) => ({ path: x.path })), files: files.length, add: files.reduce((n, f) => n + (f.add || 0), 0), del: files.reduce((n, f) => n + (f.del || 0), 0), ...attribute(root, files), now };
}

/** The unified diff of one file against the base (cut at 200 KB). */
export async function fileDiff(root, kind, snapshots, path) {
  const base = await resolveBase(root, kind, snapshots);
  if (!base) return { error: 'no base' };
  const now = base.to || await snapshotTree(root);
  const text = await git(root, ['diff', '--no-renames', '--no-color', '-U3', base.tree, now, '--', path]);
  if (text === null) return { error: 'git diff failed' };
  return { path, text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (cut)` : text };
}
