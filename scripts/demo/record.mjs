// Records the README GIF's frames: drives the real truemap workspace and CLI on a pinned Umami checkout
// in a headless Chromium browser and saves one 2x PNG per beat. See README.md in this folder.
// Usage: node scripts/demo/record.mjs   (writes scripts/demo/.work/frames/NN-name.png and frames.json)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const HERE = join(SRC, '.work');
const REPO = join(HERE, 'umami');
const TM = join(SRC, '..', '..', 'bin', 'truemap.js');
const UMAMI_SHA = 'aad2c4cedd5c0b3bc4d361843830a0bb47cf79c4';
mkdirSync(HERE, { recursive: true });
if (!existsSync(join(REPO, '.git'))) { // a pinned Umami checkout with the demo map committed
  mkdirSync(REPO, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: REPO, stdio: 'inherit' });
  git('init', '-q'); git('fetch', '-q', '--depth', '1', 'https://github.com/umami-software/umami.git', UMAMI_SHA); git('checkout', '-q', 'FETCH_HEAD');
  mkdirSync(join(REPO, '.truemap'), { recursive: true });
  writeFileSync(join(REPO, '.truemap', 'index.html'), readFileSync(join(SRC, 'umami-map.html')));
  git('add', '.truemap'); git('-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', 'commit', '-q', '-m', 'Demo map');
}
const OUT = join(HERE, 'frames');
const W = 1440, H = 900, DPR = 2, PORT = 9339;
const EDGE = process.env.CHROME_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p));
if (!EDGE) throw new Error('No Chrome or Edge found; set CHROME_PATH');
const STATE = join(HERE, 'state');
rmSync(STATE, { recursive: true, force: true }); mkdirSync(STATE, { recursive: true });
writeFileSync(join(STATE, 'prefs.json'), JSON.stringify({ theme: 'light' }));
const env = { ...process.env, TRUEMAP_NO_OPEN: '1', CLAUDECODE: '1', TRUEMAP_STATE_DIR: STATE };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tm = (...args) => execFileSync('node', [TM, ...args], { cwd: REPO, env, encoding: 'utf8' });
let listener = null;
function listen() { // the agent waiting for the user, as it would in the background
  listener = spawn('node', [TM, 'listen', '--timeout', '600'], { cwd: REPO, env });
  let out = ''; listener.stdout.on('data', (d) => { out += d; });
  listener.done = new Promise((r) => listener.on('exit', () => r(out)));
  return listener;
}

// ---- fresh state: no old chat, no leftover code edits, server restarted ----
try { tm('stop'); } catch {}
execFileSync('git', ['checkout', '--', 'src'], { cwd: REPO });
execFileSync('git', ['clean', '-fdq', 'src'], { cwd: REPO });
execFileSync('git', ['checkout', 'HEAD', '--', '.truemap/index.html'], { cwd: REPO });
rmSync(join(REPO, '.truemap', 'plans'), { recursive: true, force: true });
rmSync(join(REPO, '.truemap', 'drafts'), { recursive: true, force: true });
const url = tm('index.html').match(/^url: (.*)$/m)[1];
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });

// ---- browser ----
const profile = join(HERE, 'edge-profile'); rmSync(profile, { recursive: true, force: true });
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},${H}`, 'about:blank']);
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });

await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
await cdp('Page.navigate', { url });
await sleep(3000);

const top = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
async function inFrame(expr) { // evaluate inside the page iframe (same site, so same process)
  const { frameTree } = await cdp('Page.getFrameTree');
  const child = frameTree.childFrames?.[0]?.frame; if (!child) throw new Error('no frame');
  const { executionContextId } = await cdp('Page.createIsolatedWorld', { frameId: child.id, worldName: 'rec' });
  const r = await cdp('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true });
  if (r.exceptionDetails) throw new Error('inFrame: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function boxCenter(id) {
  const off = await top(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const r = await inFrame(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  return { x: off.x + r.x, y: off.y + r.y };
}
async function frameEl(expr) { // centre of an element inside the page frame, in viewport px
  const off = await top(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const r = await inFrame(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  return { x: off.x + r.x, y: off.y + r.y };
}
const center = (sel) => top(`(() => { const el = ${sel}; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const ring = (p) => top(`(() => { let d = document.getElementById('__rec_ring'); if (!d) { d = document.createElement('div'); d.id = '__rec_ring'; document.body.appendChild(d); }
  d.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;width:34px;height:34px;border-radius:50%;border:4px solid rgba(37,99,235,.95);background:rgba(37,99,235,.22);box-shadow:0 0 0 6px rgba(37,99,235,.18);left:${p.x - 17}px;top:${p.y - 17}px'; })()`);
const unring = () => top(`document.getElementById('__rec_ring')?.remove()`);
async function click(p, count = 1) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (let i = 1; i <= count; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: i });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: i });
  }
}
const frames = [];
async function shot(name, meta = {}) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${String(frames.length).padStart(2, '0')}-${name}.png`;
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  frames.push({ file, ...meta });
}
async function typeInto(text, beat) { // composer typing, a few frames as the text grows
  const p = await center(`document.getElementById('input')`);
  await click(p);
  const cuts = []; for (let c = 4; c < text.length; c += 4) cuts.push(c); cuts.push(text.length);
  let typed = 0;
  for (const c of cuts) { await cdp('Input.insertText', { text: text.slice(typed, c) }); typed = c; await sleep(60); await shot(`${beat}-type`, { beat, kind: 'type' }); }
}
const enter = async () => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };

// ---- 1. the map ----
listen(); await sleep(1500);
await shot('map', { beat: 1 });

// ---- 2. ask: the agent explains on a draft page ----
await typeInto('How is a page view recorded?', 2);
await enter(); await listener.done; await sleep(300);
tm('progress', 'Tracing one page view through the code');
await sleep(1200);
await shot('working', { beat: 2 });
const draftOut = tm('draft', 'how a page view is recorded');
const draftFile = draftOut.match(/^draft: "?([^"\s]+)"?/m)[1];
writeFileSync(join(REPO, '.truemap', draftFile), readFileSync(join(SRC, 'draft.html'), 'utf8'));
tm(draftFile);
tm('reply', 'One real page view, step by step. Each step links to its box on the map.');
listen(); await sleep(2500);
await shot('draft', { beat: 2 });

// ---- 3. a link in the draft opens the map with that box lit ----
const link = await frameEl(`document.querySelector('a[href="../index.html#sessions"]')`);
await shot('link-before', { beat: 3, click: link });
await click(link); await sleep(2200);
await shot('linked', { beat: 3 });

// ---- 4. ask for a change ----
await top(`document.getElementById('litClear').click()`); await sleep(700);
await typeInto('Add rate limits to /api/send.', 4);
await enter(); await listener.done; await sleep(300);

// ---- 4. the plan on the map ----
const plan = {
  title: 'Rate limits on /api/send', page: 'index.html',
  summary: 'Reject a client that sends more than 60 events a minute, before any work is done for it.',
  touch: [{ box: 'send', what: 'check the limit right after the client IP is known; answer 429 when over' }],
  add: [{ id: 'ratelimit', name: 'Rate limiter', tag: 'per IP', group: 'collect', from: ['send:checks_first'], why: 'one place that counts requests per IP and website' }],
  remove: [],
  steps: ['Add [Rate limiter](#ratelimit) in `src/lib/rate-limit.ts`: 60 events a minute per IP and website', 'Call it from [Send API](#send) after the IP block check (`src/app/api/send/route.ts`)'],
};
writeFileSync(join(HERE, 'plan.json'), JSON.stringify(plan, null, 2));
tm('plan', '--file', join(HERE, 'plan.json'));
listen(); await sleep(3500);
await shot('plan', { beat: 5 });

// ---- 5. approve ----
const off = await top(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
const inner = await inFrame(`(() => { const r = [...document.querySelectorAll('*')].map((e) => e.shadowRoot).filter(Boolean).map((r) => r.querySelector('[data-pa="approve"]')).find(Boolean).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const approve = { x: off.x + inner.x, y: off.y + inner.y };
await shot('approve-before', { beat: 6, click: approve });
await click(approve); await sleep(900);
await listener.done;
tm('progress', 'Adding the rate limiter, then its box on the map');
await sleep(1200);
await shot('building', { beat: 6 });

// ---- the agent builds it (real code edits) ----
const lib = `const WINDOW_MS = 60_000;
const LIMIT = 60;

const hits = new Map<string, { count: number; resetAt: number }>();

// Returns a 429 response when this IP is over the limit for the website.
export function limit(ip: string, websiteId: string, now = Date.now()): Response | null {
  const key = \`\${websiteId}:\${ip}\`;
  const entry = hits.get(key);

  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  entry.count += 1;
  if (entry.count <= LIMIT) return null;

  return new Response('Too many requests', { status: 429 });
}

// Drops windows that have ended, so the map does not grow without bound.
export function sweepRateLimits(now = Date.now()) {
  for (const [key, entry] of hits) {
    if (entry.resetAt <= now) hits.delete(key);
  }
}
`;
writeFileSync(join(REPO, 'src/lib/rate-limit.ts'), lib);
const routePath = join(REPO, 'src/app/api/send/route.ts');
let route = readFileSync(routePath, 'utf8');
const nl = route.includes('\r\n') ? '\r\n' : '\n';
const anchor = ['    if (hasBlockedIp(ip)) {', '      return forbidden();', '    }', ''].join(nl);
if (!route.includes(anchor)) throw new Error('route anchor not found');
route = route.replace(anchor, anchor + ['', '    // Rate limit: 60 events a minute', "    const { limit } = await import('@/lib/rate-limit');", '    const over = limit(ip, websiteId);', '    if (over) return over;', ''].join(nl));
writeFileSync(routePath, route);
await sleep(1200);
// the new box goes on the map for real
const idxPath = join(REPO, '.truemap/index.html');
let idx = readFileSync(idxPath, 'utf8');
idx = idx.replace('data-to="sessions:resolves events:saves"', 'data-to="sessions:resolves ratelimit:checks_first events:saves"');
idx = idx.replace(/(<div class="tm-node is-key" id="sessions"[\s\S]*?<\/div>\s*<\/div>)/, `$1
      <div class="tm-node" id="ratelimit" data-name="Rate limiter" data-tag="per IP" data-src="src/lib/rate-limit.ts#limit">
        <div class="tm-detail"><p>Counts events per IP and website in a one-minute window; over 60, /api/send answers 429.</p></div>
      </div>`);
if (!idx.includes('id="ratelimit"')) throw new Error('box not inserted');
writeFileSync(idxPath, idx);
await sleep(800);
tm('plan', '--done');
tm('check', '--ok', 'index.html');
tm('changes');
listen(); await sleep(2500);

// ---- 6. what changed, box by box ----
await shot('changes', { beat: 7 });

// ---- 7. one click to the diff ----
const row = await center(`[...document.querySelectorAll('#msgs .cc-row')].find((b) => /Send API/.test(b.textContent))`);
await shot('row-before', { beat: 8, click: row });
await click(row); await sleep(1800);
await shot('diff', { beat: 8 });

// ---- 8. the map stays true ----
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(800);


writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames, null, 2));
listener?.kill(); ws.close(); edge.kill();
try { tm('stop'); } catch {}
console.log('frames:', frames.length);
