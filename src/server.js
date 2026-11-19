// The local truemap server: one per repo, started on demand by the CLI, invisible to the user.
// Serves the workspace UI, the .truemap pages (with the SDK injected), a chat queue between
// the browser and the agent's CLI (listen/reply), and live updates over Server-Sent Events.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, watch } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { FOLDER, PKG_DIR, VERSION, appendPrivate, historyPath, serverStatePath, writePrivate } from './common.js';
import { checkAll, listPages } from './check.js';

const root = resolve(process.argv[2] || process.cwd());
const folder = join(root, FOLDER);
const token = randomBytes(18).toString('base64url');
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
let annotateWish;                   // set by `truemap <page> --annotate` before a tab is open
let lastAgentActivity = 0;
let currentPage = null;
let closeTimer = null;
let idleTimer = null;
let seq = 0;
let lastCheck = { gitRepo: false, results: [] };
const history = loadHistory();

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

function shutdown() {
  broadcast({ type: 'closing' });
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
  setAgentState('working');
  lastAgentActivity = Date.now();
  broadcast({ type: 'delivered', ids: messages.map((m) => m.id) });
  finishListen({ status: 'message', messages });
}

function scheduleCloseCheck() {
  clearTimeout(closeTimer);
  if (!listener || clients.size > 0) return;
  closeTimer = setTimeout(() => {
    if (listener && clients.size === 0 && queue.length === 0) {
      finishListen({ status: 'browser_closed' });
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

// ---------- http helpers ----------
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

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
  const own = folderIsSafe() ? safeFile(folder, 'assets/truemap.css') : null;
  let css = readFileSync(own || join(KIT_DIR, 'truemap.css'), 'utf8');
  const theme = folderIsSafe() ? safeFile(folder, 'assets/theme.css') : null;
  if (theme) css += `
/* .truemap/assets/theme.css */
${readFileSync(theme, 'utf8')}`;
  res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(css);
}

function serveUi(res, name) {
  const file = safeFile(UI_DIR, name);
  if (!file) return sendText(res, 404, 'not found');
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
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
      const html = readFileSync(join(UI_DIR, 'workspace.html'), 'utf8')
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
        type: 'hello', version: VERSION, root, cmd: CMD, agent: agentInfo(), pages: safePages(), check: lastCheck,
        history, current: currentPage, pending: queue.map((m) => m.id), ...(annotateWish !== undefined ? { annotate: annotateWish } : {}),
      })}\n\n`);
      annotateWish = undefined;
      clients.add(res);
      clearTimeout(closeTimer);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); scheduleCloseCheck(); touchIdle(); });
      return;
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
      queue.push(msg);
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

    // ----- agent (CLI) side -----
    if (p === '/api/agent/status' && req.method === 'GET') {
      return sendJson(res, 200, { version: VERSION, pid: process.pid, root, clients: clients.size, agent: agentState, queued: queue.length, current: currentPage });
    }
    if (p === '/api/agent/listen' && req.method === 'POST') {
      const b = await readBody(req);
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
      remember({ role: 'agent', id: `a${Date.now().toString(36)}${(seq++).toString(36)}`, at: new Date().toISOString(), agent: agentName, text });
      if (!listener) setAgentState(b.keepWorking || b.willListen ? 'working' : 'idle');
      return sendJson(res, 200, { ok: true, browsers: clients.size });
    }
    if (p === '/api/agent/navigate' && req.method === 'POST') {
      const b = await readBody(req);
      const page = String(b.page ?? '');
      noteAgent(b.agent);
      if (typeof b.annotate === 'boolean' && clients.size === 0) annotateWish = b.annotate;
      broadcast({ type: 'navigate', page, pages: safePages(), ...(typeof b.annotate === 'boolean' ? { annotate: b.annotate } : {}) });
      scheduleChecks();
      return sendJson(res, 200, { ok: true, browsers: clients.size });
    }
    if (p === '/api/agent/progress' && req.method === 'POST') {
      const b = await readBody(req);
      broadcast({ type: 'progress', text: String(b.text ?? '').slice(0, 300) });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/agent/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(shutdown, 50);
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
      const js = readFileSync(join(UI_DIR, 'sdk.js'), 'utf8').replace('__TRUEMAP_PARENT__', `http://127.0.0.1:${port}`);
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

server.listen(Number(process.env.TRUEMAP_PORT || 0), '127.0.0.1', () => {
  port = server.address().port;
  content.listen(0, '127.0.0.1', () => {
    contentPort = content.address().port;
    writePrivate(statePath, JSON.stringify({ pid: process.pid, port, contentPort, token, version: VERSION, root, startedAt: new Date().toISOString() }));
    startWatching();
    scheduleChecks();
    touchIdle();
  });
});

// Code changes outside .truemap aren't watched (too noisy); re-check while someone is looking.
setInterval(() => { if (clients.size > 0) scheduleChecks(); }, 30_000).unref();

// Mark the agent offline if it hasn't listened or replied in a long while.
setInterval(() => {
  if (!listener && (agentState === 'working' || agentState === 'idle') && Date.now() - lastAgentActivity > 20 * 60 * 1000) setAgentState('offline');
}, 60_000).unref();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
