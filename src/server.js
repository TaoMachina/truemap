// The local truemap server: one per repo, started on demand by the CLI, invisible to the user.
// Serves the workspace UI, the .truemap pages (with the SDK injected), a chat queue between
// the browser and the agent's CLI (listen/reply), and live updates over Server-Sent Events.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, watch } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { themeable } from './theme.js';
import { FOLDER, PKG_DIR, VERSION, addrPath, appendPrivate, buildId, stateHome, historyPath, serverStatePath, serversDir, snapshotsPath, writePrivate } from './common.js';
import { changes, fileDiff, snapshotTree } from './changes.js';
import { cleanPlan, currentPlan, parseReport, planCheck, planMessage, planWarnings, readPlan, savePlan, srcOfBox, stepCheck } from './plan.js';
import { checkAll, listPages } from './check.js';
import { exportPage, kitCss, tokensCss } from './export.js';
import { snippet } from './snippet.js';

const root = resolve(process.argv[2] || process.cwd());
const folder = join(root, FOLDER);
const BUILD = buildId();
const lastAddr = (() => { try { return JSON.parse(readFileSync(addrPath(root), 'utf8')) || {}; } catch { return {}; } })();
const token = typeof lastAddr.token === 'string' && /^[\w-]{24,}$/.test(lastAddr.token) ? lastAddr.token : randomBytes(18).toString('base64url');
const statePath = serverStatePath(root);
const IDLE_MS = Number(process.env.TRUEMAP_IDLE_MS || 30 * 60 * 1000);
const CLOSE_GRACE_MS = Number(process.env.TRUEMAP_CLOSE_GRACE_MS || 10_000);
const UI_DIR = join(PKG_DIR, 'src', 'ui');
const KIT_DIR = join(PKG_DIR, 'kit');
const FONT_DIR = join(KIT_DIR, 'fonts');
const CMD = process.env.TRUEMAP_CMD || 'npx -y truemap-cli';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

// ---------- state ----------
const clients = new Set();          // SSE responses (browser tabs)
const queue = [];                   // messages waiting for the agent
let listener = null;                // { res, timer } – the single active `listen`
let agentState = 'offline';         // offline (never seen) | listening | working | idle (back in the terminal)
let agentName = '';                 // claude-code | codex | ''
let agentSince = 0;                 // when the current state began
let endRequested = false;           // the user pressed End conversation while the agent wasn't listening
let annotateWish;                   // set by `truemap <page> --annotate` before a tab is open
let lastAgentActivity = 0;
let lastSeenAt = Date.now();        // when a person last had this project open
let lastReplyAt = 0;                // when the agent last wrote in the chat
let everConnected = false;          // a tab has been open since this server started
const asking = () => { const a = [...history].reverse().find((h) => h.role === 'agent'); return !!(a?.ask && !history.some((h) => h.kind === 'answer' && h.at > a.at)); };
let currentPage = null;
let closeTimer = null;
let idleTimer = null;
let seq = 0;
let lastCheck = { gitRepo: false, results: [] };
const history = loadHistory();

// ---------- change review: where "what changed" is measured from ----------
const snapshots = (() => { try { return JSON.parse(readFileSync(snapshotsPath(root), 'utf8')); } catch { return {}; } })();
function saveSnapshots() { try { writePrivate(snapshotsPath(root), JSON.stringify(snapshots)); } catch { /* ignore */ } }
async function takeSnapshot(kind, extra = {}) {
  const tree = await snapshotTree(root).catch(() => null);
  if (!tree) return null;
  snapshots[kind] = { tree, at: new Date().toISOString(), ...extra };
  saveSnapshots(); changeCache.clear();
  broadcast({ type: 'changes-base', kind });
  return snapshots[kind];
}
const changeCache = new Map(); // base -> { at, promise }

// ---------- what changed in a turn comes to the user, in the conversation ----------
// One card per turn. `changes`, `plan --done` + `changes` and the end of the turn (listen) all want to post;
// the first posts the card, the later ones update that same card (same id, same place) when it differs.
// A turn is the time between the agent picking up a message and listening again; a user message or a
// finished listen starts a new card.
function cardThisTurn(turnAt) {
  if (snapshots.closedTurn !== undefined && snapshots.closedTurn === turnAt) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === 'user') return null;
    if (h.kind === 'changes') return (h.turn || '') === turnAt ? h : null;
  }
  return null;
}
function updateEntry(entry) {
  try {
    const lines = readFileSync(historyPath(root), 'utf8').split('\n');
    const i = lines.findLastIndex((l) => l.includes(`"id":"${entry.id}"`));
    if (i !== -1) { lines[i] = JSON.stringify(entry); writePrivate(historyPath(root), lines.join('\n')); }
  } catch { /* ignore */ }
  broadcast({ type: 'chat-update', entry });
}
// `given`: the result `truemap changes` just reported, so the card says exactly what the terminal said.
async function postChanges(base = 'turn', given = null) {
  const turnAt = snapshots.turn?.at || '';
  const card = cardThisTurn(turnAt);
  if (card && base === 'turn') base = card.changes?.base || base; // the end of the turn refreshes the card it has
  if (!given && base === 'turn' && !snapshots.turn) return null;
  // no key on the code alone: editing the map moves files between boxes, closing a plan changes what is not done
  const r = given || await changesFor(base, true);
  if (!r || r.error || !r.files) return r;
  const p = r.plan || null;
  const summary = {
    base: r.base.kind, label: r.base.label, files: r.files, add: r.add, del: r.del,
    boxes: r.boxes.slice(0, 16).map((b) => ({ src: b.src, name: b.name, isNew: !!b.isNew, add: b.add, del: b.del, pages: b.pages, files: b.files.map((x) => x.path) })),
    unmapped: r.unmapped.flatMap((g) => g.files).slice(0, 30).map((x) => ({ path: x.path, add: x.add, del: x.del })),
    notDone: p ? p.planned.filter((x) => !x.changed).map((x) => x.name || x.box) : [],
  };
  const text = `Changed ${r.files} file${r.files > 1 ? 's' : ''}`;
  // the same lines changed, whichever base measured them
  const same = (c) => JSON.stringify([c.files, c.add, c.del, c.boxes.map((b) => [b.src, b.add, b.del]), c.unmapped.map((x) => [x.path, x.add, x.del])]);
  const live = cardThisTurn(turnAt); // again: history may have moved while the diff ran
  // a listen after the turn was closed (a timeout, a restart) measures from the same start: no repeat card
  const last = live ? null : [...history].reverse().find((h) => h.kind === 'changes' && h.changes);
  if (last && same(last.changes) === same(summary)) return r;
  if (live) {
    if (same(live.changes) !== same(summary) || String(live.changes.notDone) !== String(summary.notDone)) {
      Object.assign(live, { text, changes: summary, updatedAt: new Date().toISOString() });
      updateEntry(live);
    }
    return r;
  }
  remember({
    role: 'agent', kind: 'changes', id: `c${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), agent: agentName,
    turn: turnAt, text, changes: summary,
  });
  return r;
}

// ---------- plans ----------
let plan = (() => { try { return currentPlan(root); } catch { return null; } })();
function setPlan(p) {
  plan = p;
  if (p) { try { savePlan(root, p); } catch { /* ignore */ } }
  broadcast({ type: 'plan', plan: p && !['done', 'rejected'].includes(p.status) ? p : null });
}
async function approvePlan(by) {
  if (!plan || plan.status === 'done') return false;
  setPlan({ ...plan, status: 'approved', approvedAt: new Date().toISOString() });
  await takeSnapshot('plan', { slug: plan.slug });
  if (by === 'user') {
    const msg = { id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), kind: 'approval', from: 'user', page: plan.page, text: `Approved the plan: ${plan.title}`, context: [], plan: plan.slug };
    queue.push(msg); remember({ role: 'user', ...msg }); deliverQueue();
  }
  return true;
}
function changesFor(base, fresh = false) {
  const hit = changeCache.get(base);
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.promise;
  const promise = changes(root, base, snapshots).then((r) => {
    // measured from the plan's approval: say how the work compares with the plan
    const p = plan && snapshots.plan?.slug === plan.slug ? plan : snapshots.plan?.slug ? readPlan(root, snapshots.plan.slug) : null;
    if (!r.error && r.base?.kind === 'plan' && p) { r.plan = planCheck(root, p, r); r.plan.steps = stepCheck(root, p, r); r.plan.status = p.status; }
    return r;
  }).catch((e) => ({ error: String(e?.message || e) }));
  changeCache.set(base, { at: Date.now(), promise });
  return promise;
}

function loadHistory() {
  try {
    return readFileSync(historyPath(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-200);
  } catch { return []; }
}

function remember(entry) {
  history.push(entry);
  if (history.length > 200) history.shift();
  try { appendPrivate(historyPath(root), JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
  broadcast({ type: 'chat', entry });
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

const agentInfo = () => ({ state: agentState, name: agentName, since: agentSince });
function setAgentState(s) {
  if (agentState === s) return;
  agentState = s;
  agentSince = Date.now();
  broadcast({ type: 'agent', agent: agentInfo() });
}
function noteAgent(name) {
  if (typeof name === 'string' && name && name !== agentName) { agentName = name.slice(0, 40); broadcast({ type: 'agent', agent: agentInfo() }); }
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (clients.size === 0 && !listener && queue.length === 0) shutdown();
    else touchIdle();
  }, IDLE_MS);
}

function shutdown(restart = false) {
  broadcast({ type: 'closing', restart });
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    if (s.pid === process.pid) rmSync(statePath, { force: true });
  } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 150); // let the browsers hear 'closing'
}

// ---------- listen / reply ----------
function finishListen(body) {
  if (!listener) return;
  const { res, timer } = listener;
  clearTimeout(timer);
  listener = null;
  sendJson(res, 200, body);
}

function deliverQueue() {
  if (listener && (listener.res.destroyed || listener.res.writableEnded)) { clearTimeout(listener.timer); listener = null; setAgentState('idle'); }
  if (!listener || queue.length === 0) return;
  const messages = queue.splice(0, queue.length);
  // The code is photographed before the agent hears the message, so its first edit is never part of "before".
  const { res, timer } = listener; clearTimeout(timer); listener = null;
  setAgentState('working');
  lastAgentActivity = Date.now();
  broadcast({ type: 'delivered', ids: messages.map((m) => m.id) });
  const body = { status: 'message', messages, ...(plan && plan.status === 'review' ? { plan_waiting: plan.title } : {}) };
  takeSnapshot('turn').catch(() => null).finally(() => { if (!res.writableEnded) sendJson(res, 200, body); });
}

function scheduleCloseCheck() {
  clearTimeout(closeTimer);
  if (!listener || clients.size > 0) return;
  closeTimer = setTimeout(() => {
    if (listener && clients.size === 0 && queue.length === 0) {
      finishListen({ status: everConnected ? 'browser_closed' : 'no_tab' });
      setAgentState('idle');
    }
  }, CLOSE_GRACE_MS);
}

// ---------- checks & file watching ----------
function runChecks() {
  try { lastCheck = checkAll(root); } catch { lastCheck = { gitRepo: false, results: [] }; }
  broadcast({ type: 'check', check: lastCheck });
  return lastCheck;
}

// Checks shell out to git, which can take a moment: never make a request wait for them.
let checkQueued = false;
function scheduleChecks() {
  if (checkQueued) return;
  checkQueued = true;
  setTimeout(() => { checkQueued = false; runChecks(); }, 30);
}

let watchTimer = null;
const changedPages = new Set();
function startWatching() {
  const onChange = (file) => {
    if (file) changedPages.add(String(file).split(sep).join('/'));
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      const files = [...changedPages];
      changedPages.clear();
      changeCache.clear();
      broadcast({ type: 'pages', pages: safePages() });
      broadcast({ type: 'changed', files });
      scheduleChecks();
    }, 150);
  };
  try {
    const w = watch(folder, { recursive: true }, (_e, f) => onChange(f));
    w.on('error', () => { try { w.close(); } catch { /* ignore */ } setTimeout(startWatching, 2000); });
  } catch { setTimeout(startWatching, 5000); }
}

function safePages() {
  try { return listPages(root); } catch { return []; }
}

const cleanFocus = (f) => (Array.isArray(f) ? f : []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 20);

// ---------- every truemap project running on this machine (one server each) ----------
function peek(state) {
  return new Promise((ok) => {
    const r = httpRequest({ host: '127.0.0.1', port: state.port, path: '/api/agent/status', method: 'GET', headers: { 'X-Truemap-Token': state.token } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { ok(null); } });
    });
    r.setTimeout(800, () => r.destroy()); r.on('error', () => ok(null)); r.end();
  });
}
async function projects() {
  let files = [];
  try { files = readdirSync(serversDir()).filter((x) => x.endsWith('.json')); } catch { return []; }
  const list = await Promise.all(files.map(async (name) => {
    let st; try { st = JSON.parse(readFileSync(join(serversDir(), name), 'utf8')); } catch { return null; }
    if (!st?.port || !st.token) return null;
    const self = st.pid === process.pid;
    const s = self ? { root, name: basename(root), agent: agentState, agentName, plan: plan && plan.status !== 'done' ? { title: plan.title, status: plan.status } : null, unread: false, asking: false, clients: clients.size } : await peek(st);
    if (!s?.root) return null;
    return { self, name: s.name || basename(s.root), root: s.root, agent: s.agent, agentName: s.agentName || '', plan: s.plan || null, unread: !!s.unread, asking: !!s.asking, url: `http://127.0.0.1:${st.port}/?t=${encodeURIComponent(st.token)}` };
  }));
  // one entry per project, even when two state files (old path spellings) point at the same server
  const seen = new Set();
  return list.filter(Boolean).sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name))
    .filter((x) => { const k = String(x.root).toLowerCase().replace(/[\\/]+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- http helpers ----------
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// Light or dark, when the user picked one; otherwise the system decides. Shared by every project.
const prefsFile = () => join(stateHome(), 'prefs.json');
function readPrefs() { try { return JSON.parse(readFileSync(prefsFile(), 'utf8')) || {}; } catch { return {}; } }
const theme = () => { const t = readPrefs().theme; return t === 'light' || t === 'dark' ? t : ''; };
const withTheme = (html) => { const t = theme(); return t ? html.replace(/<html\b/i, `<html data-theme="${t}"`) : html; };

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { fail(e); }
    });
    req.on('error', fail);
  });
}

let port = 0;          // workspace + API
let contentPort = 0;   // pages only: a separate origin, so page scripts can never reach the API
function hostAllowed(req, p = port) {
  const host = (req.headers.host || '').toLowerCase();
  return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(host);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI requests carry no Origin
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase());
}

function tokenOk(req, url) {
  return req.headers['x-truemap-token'] === token || url.searchParams.get('t') === token;
}

/** Resolves a request path inside a base dir; refuses traversal and symlinks leading outside. */
function folderIsSafe() {
  try { return !lstatSync(folder).isSymbolicLink(); } catch { return false; }
}

function safeFile(base, relPath) {
  let decoded;
  try { decoded = decodeURIComponent(relPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const full = resolve(base, '.' + sep + decoded.replace(/\//g, sep));
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (!existsSync(full)) return null;
  try {
    const real = realpathSync(full);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
    if (statSync(real).isDirectory()) return null;
    return real;
  } catch { return null; }
}

function servePage(res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  let body = readFileSync(file);
  if (type.startsWith('text/html')) {
    const inject = `<script src="/__truemap/sdk.js"></script>`;
    let html = body.toString('utf8');
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${inject}</body>`) : html + inject;
    html = withTheme(html);
    body = Buffer.from(html, 'utf8');
  }
  res.writeHead(200, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    // Only the truemap workspace may frame these pages.
    'Content-Security-Policy': `frame-ancestors http://127.0.0.1:${port}`,
  });
  res.end(body);
}

function serveStatic(res, dir, name, cache = 'no-store') {
  const file = safeFile(dir, name);
  if (!file) return sendText(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
  res.end(readFileSync(file));
}

// The page kit comes from truemap itself, so every repo gets kit updates. A repo may still keep its own
// assets/truemap.css (older setups, or a hand-tuned copy): that copy wins. assets/theme.css is appended.
function serveKit(res) {
  const css = themeable(kitCss(root));
  res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(css);
}

function serveUi(res, name) {
  if (name === 'tokens.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(themeable(tokensCss(root)));
  }
  const file = safeFile(UI_DIR, name);
  if (!file) return sendText(res, 404, 'not found');
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(name === 'workspace.css' ? themeable(readFileSync(file, 'utf8')) : readFileSync(file));
}

// ---------- routes ----------
const server = createServer(async (req, res) => {
  if (!hostAllowed(req)) return sendText(res, 403, 'forbidden host');
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;
  touchIdle();

  try {
    // Workspace shell (token required so other local pages can't embed a live session).
    if (p === '/' && req.method === 'GET') {
      if (!tokenOk(req, url)) return sendText(res, 403, 'missing token – open the link printed by `truemap`');
      const html = withTheme(readFileSync(join(UI_DIR, 'workspace.html'), 'utf8'))
        .replace('__TRUEMAP_TOKEN__', token)
        .replace('__TRUEMAP_CONTENT__', `http://127.0.0.1:${contentPort}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end(html);
    }
    if (p.startsWith('/__truemap/fonts/') && req.method === 'GET') return serveStatic(res, FONT_DIR, p.slice('/__truemap/fonts/'.length), 'max-age=86400');
    if (p.startsWith('/__truemap/') && req.method === 'GET') return serveUi(res, p.slice('/__truemap/'.length));
    if (!p.startsWith('/api/')) return sendText(res, 404, 'not found');
    if (!originAllowed(req) || !tokenOk(req, url)) return sendText(res, 403, 'forbidden');

    // ----- browser side -----
    if (p === '/api/events' && req.method === 'GET') {
      scheduleChecks();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({
        type: 'hello', version: VERSION, build: BUILD, root, cmd: CMD, agent: agentInfo(), pages: safePages(), check: lastCheck,
        history, current: currentPage, pending: queue.map((m) => m.id), plan: plan && plan.status !== 'done' ? plan : null, ...(annotateWish !== undefined ? { annotate: annotateWish } : {}),
      })}\n\n`);
      annotateWish = undefined;
      clients.add(res); everConnected = true;
      clearTimeout(closeTimer);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); lastSeenAt = Date.now(); scheduleCloseCheck(); touchIdle(); });
      return;
    }
    if (p === '/api/prefs' && req.method === 'POST') {
      const b = await readBody(req);
      const next = { ...readPrefs() };
      if ('theme' in b) { if (b.theme === 'light' || b.theme === 'dark') next.theme = b.theme; else delete next.theme; }
      writePrivate(prefsFile(), JSON.stringify(next));
      return sendJson(res, 200, { ok: true, theme: theme() });
    }
    if (p === '/api/send' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text ?? '').slice(0, 20_000);
      const str = (v, n) => String(v ?? '').slice(0, n);
      const context = (Array.isArray(b.context) ? b.context.slice(0, 20) : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          kind: c.kind === 'text' ? 'text' : 'element', label: str(c.label, 120), src: str(c.src, 300), excerpt: str(c.excerpt, 600),
          ...(c.comment ? { comment: str(c.comment, 4000) } : {}), ...(c.page ? { page: str(c.page, 200) } : {}),
        }));
      const answer = b.kind === 'answer' && b.answer && typeof b.answer === 'object'
        ? { question: String(b.answer.question ?? '').slice(0, 500), choice: String(b.answer.choice ?? '').slice(0, 2000), note: String(b.answer.note ?? '').slice(0, 4000) }
        : null;
      if (!text.trim() && context.length === 0 && !answer) return sendJson(res, 400, { error: 'empty' });
      const msg = {
        id: `m${Date.now().toString(36)}${(seq++).toString(36)}`,
        at: new Date().toISOString(),
        kind: answer ? 'answer' : 'message',
        from: b.from === 'page' ? 'page' : 'user',
        page: typeof b.page === 'string' ? b.page : currentPage,
        text,
        context,
        ...(answer ? { answer } : {}),
      };
      if (b.plan === 'request' && plan && plan.status !== 'done') { msg.kind = 'plan_changes'; msg.plan = plan.slug; setPlan({ ...plan, status: 'revise' }); }
      queue.push(msg);
      endRequested = false; // a new message means the conversation goes on
      remember({ role: 'user', ...msg });
      deliverQueue();
      return sendJson(res, 200, { ok: true, id: msg.id, delivered: !queue.includes(msg) });
    }
    if (p === '/api/viewing' && req.method === 'POST') {
      const b = await readBody(req);
      currentPage = typeof b.page === 'string' ? b.page : currentPage;
      scheduleChecks();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/check' && req.method === 'POST') return sendJson(res, 200, runChecks());
    if (p === '/api/export' && req.method === 'GET') {
      const page = url.searchParams.get('page') || '';
      let html;
      try { html = exportPage(root, page); } catch (e) { return sendText(res, 404, String(e.message || e)); }
      const name = page.split('/').pop().replace(/\.html?$/i, '') || 'page';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}-truemap.html"` });
      return res.end(html);
    }
    if (p === '/api/image' && req.method === 'GET') {
      // A picture the agent put in its reply: a raster image inside this repo, nothing else.
      const asked = String(url.searchParams.get('path') || '');
      const rel = isAbsolute(asked) ? relative(root, asked) : asked;
      const file = rel && !rel.startsWith('..') && !isAbsolute(rel) ? safeFile(root, rel.split(sep).join('/')) : null;
      const type = file && { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[extname(file).toLowerCase()];
      if (!type) return sendText(res, 404, 'not an image in this repo');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(readFileSync(file));
    }
    if (p === '/api/snippet' && req.method === 'GET') {
      try { return sendJson(res, 200, snippet(root, url.searchParams.get('src') || '')); } catch (e) { return sendJson(res, 200, { error: String(e.message || e) }); }
    }
    if (p === '/api/changes' && req.method === 'GET') {
      return sendJson(res, 200, await changesFor(url.searchParams.get('base') || 'auto'));
    }
    if (p === '/api/diff' && req.method === 'GET') {
      return sendJson(res, 200, await fileDiff(root, url.searchParams.get('base') || 'auto', snapshots, String(url.searchParams.get('path') || '')));
    }
    if (p === '/api/plan' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.action === 'approve') return sendJson(res, 200, { ok: await approvePlan('user') });
      if (b.action === 'reject' && plan && plan.status !== 'done') {
        setPlan({ ...plan, status: 'rejected', rejectedAt: new Date().toISOString() });
        const msg = { id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), kind: 'plan_rejected', from: 'user', page: plan.page, text: `Rejected the plan: ${plan.title}`, context: [], plan: plan.slug };
        queue.push(msg); remember({ role: 'user', ...msg }); deliverQueue();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 400, { error: 'unknown action' });
    }
    if (p === '/api/drift' && req.method === 'GET') {
      const path = String(url.searchParams.get('path') || '').replace(/\\/g, '/');
      const since = String(url.searchParams.get('since') || '');
      if (!path || path.includes('..')) return sendJson(res, 400, { error: 'bad path' });
      const { execFileSync } = await import('node:child_process');
      const g = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
      const commit = (since && g(['rev-list', '-1', `--before=${since}`, 'HEAD'])?.trim()) || 'HEAD';
      const text = g(['diff', '--no-color', '-U3', commit, '--', path]);
      if (text === null) return sendJson(res, 200, { error: 'git diff failed' });
      return sendJson(res, 200, { path, from: commit.slice(0, 8), text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (cut)` : text });
    }
    if (p === '/api/projects' && req.method === 'GET') return sendJson(res, 200, { projects: await projects() });
    if (p === '/api/end' && req.method === 'POST') {
      // The user is done talking on the page: free the agent to go back to the terminal.
      if (listener) finishListen({ status: 'ended' }); else if (agentState === 'working' || agentState === 'listening') endRequested = true;
      setAgentState('idle');
      return sendJson(res, 200, { ok: true });
    }

    // ----- agent (CLI) side -----
    if (p === '/api/agent/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        version: VERSION, pid: process.pid, root, name: basename(root), clients: clients.size, agent: agentState, agentName, queued: queue.length, current: currentPage,
        plan: plan && plan.status !== 'done' ? { title: plan.title, status: plan.status } : null,
        unread: !clients.size && lastReplyAt > lastSeenAt, asking: asking(),
      });
    }
    if (p === '/api/agent/listen' && req.method === 'POST') {
      const b = await readBody(req);
      // the agent listens again: its turn is over, so what it changed goes to the user
      // posts only when something changed since the turn began, or brings this turn's card up to date
      const endedTurn = snapshots.turn?.at || '';
      postChanges('turn').catch(() => null).finally(() => { snapshots.closedTurn = endedTurn; saveSnapshots(); });
      if (listener) finishListen({ status: 'replaced' });
      lastAgentActivity = Date.now();
      noteAgent(b.agent);
      const timeoutMs = Number(b.timeoutMs) > 0 ? Number(b.timeoutMs) : 0;
      const timer = timeoutMs ? setTimeout(() => { finishListen({ status: 'timeout' }); setAgentState('idle'); }, timeoutMs) : null;
      listener = { res, timer };
      // The request body is already consumed, so watch the response: it closes when the CLI goes away.
      res.on('close', () => {
        if (listener && listener.res === res) { clearTimeout(listener.timer); listener = null; setAgentState('idle'); }
      });
      if (queue.length) return deliverQueue();
      if (endRequested) { endRequested = false; finishListen({ status: 'ended' }); setAgentState('idle'); return; }
      setAgentState('listening');
      if (clients.size === 0) scheduleCloseCheck();
      return;
    }
    if (p === '/api/agent/reply' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text ?? '').slice(0, 100_000);
      if (!text.trim()) return sendJson(res, 400, { error: 'empty reply' });
      lastAgentActivity = Date.now();
      noteAgent(b.agent);
      const focus = cleanFocus(b.focus);
      const ask = b.ask && typeof b.ask === 'object' && Array.isArray(b.ask.options) && b.ask.options.length >= 2
        ? { question: String(b.ask.question ?? '').slice(0, 500), options: b.ask.options.slice(0, 6).map((o) => ({ label: String(o.label ?? '').slice(0, 200), why: String(o.why ?? '').slice(0, 400) })) }
        : null;
      remember({ role: 'agent', id: `a${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), agent: agentName, text, ...(focus.length ? { focus } : {}), ...(ask ? { ask } : {}) });
      lastReplyAt = Date.now(); if (clients.size) lastSeenAt = lastReplyAt;
      if (!listener) setAgentState(b.keepWorking || b.willListen ? 'working' : 'idle');
      return sendJson(res, 200, { ok: true, browsers: clients.size });
    }
    if (p === '/api/agent/navigate' && req.method === 'POST') {
      const b = await readBody(req);
      const page = String(b.page ?? '');
      noteAgent(b.agent);
      if (typeof b.annotate === 'boolean' && clients.size === 0) annotateWish = b.annotate;
      const pagesNow = safePages();
      broadcast({ type: 'navigate', page, pages: pagesNow, ...(typeof b.annotate === 'boolean' ? { annotate: b.annotate } : {}) });
      if (/^drafts\//.test(page) && !history.some((h) => h.draft === page)) {
        const t = pagesNow.find((x) => x.page === page)?.title || page;
        const n = parseInt(page.slice(7), 10);
        remember({ role: 'agent', id: `a${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), agent: agentName, draft: page, text: `Draft${Number.isFinite(n) ? ` ${n}` : ''}: [${t}](${page})` });
      }
      scheduleChecks();
      return sendJson(res, 200, { ok: true, browsers: clients.size });
    }
    if (p === '/api/agent/show' && req.method === 'POST') {
      // The agent points at the map: light up boxes (by id or data-src), optionally with a note.
      const b = await readBody(req);
      lastAgentActivity = Date.now();
      noteAgent(b.agent);
      broadcast({ type: 'show', page: typeof b.page === 'string' ? b.page : '', focus: cleanFocus(b.focus), note: String(b.note ?? '').slice(0, 2000), clear: !!b.clear, agent: agentName });
      return sendJson(res, 200, { ok: true, browsers: clients.size });
    }
    if (p === '/api/agent/changes' && req.method === 'POST') {
      // `truemap changes`: the summary for the agent, and this turn's changes card for the user.
      const b = await readBody(req);
      noteAgent(b.agent);
      const base = ['turn', 'plan', 'head', 'main'].includes(b.base) ? b.base : 'auto';
      const r = await changesFor(base, true);
      if (b.open !== false && !r.error && r.files) await postChanges(r.base.kind, r);
      return sendJson(res, 200, { ...r, browsers: clients.size });
    }
    if (p === '/api/agent/plan' && req.method === 'POST') {
      const b = await readBody(req);
      noteAgent(b.agent);
      lastAgentActivity = Date.now();
      if (b.status) {
        if (!plan) return sendJson(res, 404, { error: 'no plan in play' });
        if (b.status === 'approved') await approvePlan('agent');
        let check = null;
        if (b.status === 'done') {
          // closing a plan takes the agent's account of every step
          let rep2;
          try { rep2 = parseReport(plan, Array.isArray(b.steps) ? b.steps : []); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
          // the account of steps is optional; when given, every report is kept
          if (rep2.report.some(Boolean)) plan = { ...plan, report: rep2.report, reports: [...(plan.reports || []), { at: new Date().toISOString(), report: rep2.report }] };
          if (snapshots.plan?.slug === plan.slug) { await takeSnapshot('planEnd', { slug: plan.slug }); const r = await changesFor('plan', true); check = r.plan || null; }
          setPlan({ ...plan, status: 'done', doneAt: new Date().toISOString() });
          const sts = check?.steps || [];
          const rpt = plan.report || [];
          const tally = ['done', 'partly', 'not_built', 'dropped'].map((k) => [k, rpt.filter((x) => x?.status === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
          const conflicts = sts.filter((x) => x.conflict || x.rewritten);
          remember({ role: 'agent', id: `a${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), agent: agentName, plan: plan.slug,
            text: [`**Plan closed: ${plan.title}.**${tally ? ` Steps: ${tally}.` : ''}`, ...rpt.map((x, i) => x && x.status !== 'done' ? `- Step ${i + 1} ${x.status.replace('_', ' ')}: ${x.note}` : null).filter(Boolean),
              ...(conflicts.length ? ['', '**Check before you trust this report:**', ...conflicts.map((x) => `- Step ${x.n}: ${[x.conflict, x.rewritten].filter(Boolean).join(' ')}`)] : [])].join('\n') });
        }
        return sendJson(res, 200, { ok: true, plan: plan.slug, status: plan.status, check });
      }
      let p2;
      try { p2 = cleanPlan(b.plan); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
      const prev = readPlan(root, p2.slug);
      p2.revision = prev && prev.status !== 'done' ? (prev.revision || 1) + 1 : 1;
      p2.status = 'review'; p2.at = new Date().toISOString();
      if (prev && prev.status !== 'done') {
        const was = new Map(prev.touch.map((t) => [t.box, t.what]));
        const wasAdd = new Map(prev.add.map((a) => [a.id, JSON.stringify(a)]));
        p2.revised = [...p2.touch.filter((t) => was.get(t.box) !== t.what).map((t) => t.box), ...p2.add.filter((a) => wasAdd.get(a.id) !== JSON.stringify(a)).map((a) => a.id)];
      }
      setPlan(p2);
      remember({ role: 'agent', id: `a${Date.now().toString(36)}${(seq++).toString(36)}`, at: p2.at, agent: agentName, text: planMessage(p2, p2.revision > 1 ? prev : null, (box) => srcOfBox(root, p2.page, box, 'data-name') || box), plan: p2.slug });
      broadcast({ type: 'navigate', page: p2.page, pages: safePages() });
      return sendJson(res, 200, { ok: true, slug: p2.slug, revision: p2.revision, page: p2.page, browsers: clients.size, warnings: planWarnings(root, p2) });
    }
    if (p === '/api/agent/progress' && req.method === 'POST') {
      const b = await readBody(req);
      broadcast({ type: 'progress', text: String(b.text ?? '').slice(0, 300) });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/agent/shutdown' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      sendJson(res, 200, { ok: true });
      setTimeout(() => shutdown(!!b.restart), 50);
      return;
    }
    return sendText(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
  }
});

// Content origin: serves .truemap pages (with the SDK injected) and nothing else.
const content = createServer((req, res) => {
  if (!hostAllowed(req, contentPort)) return sendText(res, 403, 'forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
  const p = new URL(req.url, `http://127.0.0.1:${contentPort}`).pathname;
  try {
    if (p === '/__truemap/sdk.js') {
      const js = [join(UI_DIR, 'wires.js'), join(UI_DIR, 'diagram.js')].map((f) => readFileSync(f, 'utf8')).join('\n;\n')
        + '\n' + readFileSync(join(UI_DIR, 'sdk.js'), 'utf8').replace('__TRUEMAP_PARENT__', `http://127.0.0.1:${port}`);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(js);
    }
    if (p.startsWith('/__truemap/fonts/')) return serveStatic(res, FONT_DIR, p.slice('/__truemap/fonts/'.length), 'max-age=86400');
    if (p === '/pages/assets/truemap.css') return serveKit(res);
    if (p.startsWith('/pages/')) {
      const file = folderIsSafe() ? safeFile(folder, p.slice('/pages/'.length)) : null;
      if (!file) return sendText(res, 404, 'page not found');
      return servePage(res, file);
    }
    return sendText(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) sendText(res, 500, String(e?.message || e));
  }
});

// The last ports again when they are free, otherwise any.
function listenOn(srv, want) {
  return new Promise((ok, fail) => {
    const attempt = (p) => {
      const onErr = (e) => { if (p && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) attempt(0); else fail(e); };
      srv.once('error', onErr);
      srv.listen(p, '127.0.0.1', () => { srv.off('error', onErr); ok(srv.address().port); });
    };
    attempt(want);
  });
}
(async () => {
  port = await listenOn(server, Number(process.env.TRUEMAP_PORT || lastAddr.port || 0));
  contentPort = await listenOn(content, Number(lastAddr.contentPort || 0));
  writePrivate(addrPath(root), JSON.stringify({ port, contentPort, token }));
  writePrivate(statePath, JSON.stringify({ pid: process.pid, port, contentPort, token, version: VERSION, build: BUILD, root, startedAt: new Date().toISOString() }));
  startWatching();
  scheduleChecks();
  touchIdle();
})().catch((e) => { console.error(e); process.exit(1); });

// Code changes outside .truemap aren't watched (too noisy); re-check while someone is looking.
setInterval(() => { if (clients.size > 0) scheduleChecks(); }, 30_000).unref();

// Mark the agent offline if it hasn't listened or replied in a long while.
setInterval(() => {
  if (!listener && (agentState === 'working' || agentState === 'idle') && Date.now() - lastAgentActivity > 20 * 60 * 1000) setAgentState('offline');
}, 60_000).unref();

// truemap's own files can change under a running server (an upgrade in place, a local build). New files
// served by old code break pages, so the server hands over to a fresh one on the same address at once;
// open tabs reconnect and reload, and a waiting listen returns 'timeout' so the agent simply listens again.
let handingOver = false;
setInterval(() => {
  if (handingOver || buildId() === BUILD) return;
  handingOver = true;
  finishListen({ status: 'timeout' });
  broadcast({ type: 'closing', restart: true });
  try { const st = JSON.parse(readFileSync(statePath, 'utf8')); if (st.pid === process.pid) rmSync(statePath, { force: true }); } catch { /* ignore */ }
  for (const srv of [server, content]) { srv.close(); srv.closeAllConnections?.(); }
  setTimeout(() => {
    spawn(process.execPath, [join(PKG_DIR, 'src', 'server.js'), root], { detached: true, stdio: 'ignore', windowsHide: true, cwd: root }).unref();
    process.exit(0);
  }, 300);
}, 2000).unref();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
