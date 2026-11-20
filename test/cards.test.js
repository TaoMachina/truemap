import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'truemap.js');

test('a turn gets one changes card: later posts in the turn update it, the next turn gets its own', async () => {
  const state = mkdtempSync(join(tmpdir(), 'truemap-state-'));
  const root = mkdtempSync(join(tmpdir(), 'truemap-cards-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  mkdirSync(join(root, 'src')); mkdirSync(join(root, '.truemap'));
  writeFileSync(join(root, 'src', 'a.js'), 'export function a() {}\n');
  writeFileSync(join(root, 'src', 'b.js'), 'export function b() {}\n');
  writeFileSync(join(root, '.truemap', 'index.html'), `<title>Map</title><figure class="tm-diagram"><section class="tm-group" id="g" data-label="Core">
    <div class="tm-node" id="a" data-name="A" data-src="src/a.js#a" data-to="b:calls"></div><div class="tm-node" id="b" data-name="B" data-src="src/b.js#b"></div></section></figure>`);
  git('add', '-A'); git('commit', '-qm', 'init');
  const env = { ...process.env, TRUEMAP_STATE_DIR: state, TRUEMAP_NO_OPEN: '1', TRUEMAP_CLOSE_GRACE_MS: '600000' };
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' }).stdout;
  cli('index.html');
  const st = JSON.parse(readFileSync(join(state, 'servers', readdirSync(join(state, 'servers'))[0]), 'utf8'));
  const api = (path, body) => new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: st.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Truemap-Token': st.token } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => ok(JSON.parse(t || '{}')));
    });
    r.on('error', fail); r.end(JSON.stringify(body || {}));
  });
  const cards = () => readFileSync(join(state, 'history', readdirSync(join(state, 'history'))[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((h) => h.kind === 'changes');
  const turn = async (text) => {
    const heard = api('/api/agent/listen', { timeoutMs: 20000 });
    await new Promise((r) => setTimeout(r, 300));
    await api('/api/send', { text, page: 'index.html', context: [] });
    assert.equal((await heard).status, 'message');
  };
  try {
    await turn('Change a and b');
    appendFileSync(join(root, 'src', 'a.js'), '// one\n');
    await api('/api/agent/changes', { base: 'auto' });
    appendFileSync(join(root, 'src', 'b.js'), '// two\n');
    await api('/api/agent/changes', { base: 'auto' });
    await api('/api/agent/listen', { timeoutMs: 400 }); // the turn ends
    await new Promise((r) => setTimeout(r, 1200));
    let list = cards();
    assert.equal(list.length, 1, 'one card for the turn');
    assert.equal(list[0].changes.files, 2, 'the card is up to date');
    await api('/api/agent/listen', { timeoutMs: 400 }); // listening again changes nothing
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(cards().length, 1);

    await turn('Now only b');
    appendFileSync(join(root, 'src', 'b.js'), '// three\n');
    await api('/api/agent/listen', { timeoutMs: 400 });
    await new Promise((r) => setTimeout(r, 1200));
    list = cards();
    assert.equal(list.length, 2, 'the next turn has its own card');
    assert.deepEqual([list[1].changes.files, list[1].changes.add], [1, 1]);
  } finally {
    await api('/api/agent/shutdown').catch(() => null);
  }
});

test('the card matches what `changes` reports after the map gains the new box and the plan closes', async () => {
  const state = mkdtempSync(join(tmpdir(), 'truemap-state-'));
  const root = mkdtempSync(join(tmpdir(), 'truemap-cards-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  mkdirSync(join(root, 'src')); mkdirSync(join(root, '.truemap'));
  writeFileSync(join(root, 'src', 'a.js'), 'export function a() {}\n');
  writeFileSync(join(root, 'src', 'b.js'), 'export function b() {}\n');
  const box = (id, extra = '') => `<div class="tm-node" id="${id}" data-name="Box ${id}" data-src="src/${id}.js#${id}" ${extra}></div>`;
  const map = (inner) => `<title>Map</title><figure class="tm-diagram"><section class="tm-group" id="g" data-label="Core">${inner}</section></figure>`;
  writeFileSync(join(root, '.truemap', 'index.html'), map(box('a', 'data-to="b:calls"') + box('b')));
  git('add', '-A'); git('commit', '-qm', 'init');
  const env = { ...process.env, TRUEMAP_STATE_DIR: state, TRUEMAP_NO_OPEN: '1', TRUEMAP_CLOSE_GRACE_MS: '600000' };
  spawnSync(process.execPath, [BIN, 'index.html'], { cwd: root, env, encoding: 'utf8' });
  const st = JSON.parse(readFileSync(join(state, 'servers', readdirSync(join(state, 'servers'))[0]), 'utf8'));
  const api = (path, body) => new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port: st.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Truemap-Token': st.token } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => ok(JSON.parse(t || '{}')));
    });
    r.on('error', fail); r.end(JSON.stringify(body || {}));
  });
  const card = () => readFileSync(join(state, 'history', readdirSync(join(state, 'history'))[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((h) => h.kind === 'changes').at(-1)?.changes;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await api('/api/agent/plan', { plan: { title: 'Add c', page: 'index.html', touch: [{ box: 'a', what: 'call c' }], add: [{ id: 'c', name: 'Box c', group: 'g', from: ['a:calls'] }], steps: ['Write `src/c.js`', 'Call it from `src/a.js`'] } });
    const heard = api('/api/agent/listen', { timeoutMs: 20000 });
    await sleep(300);
    await api('/api/plan', { action: 'approve' });
    assert.equal((await heard).status, 'message');
    appendFileSync(join(root, 'src', 'a.js'), '// calls c\n');
    await api('/api/agent/changes', { base: 'auto' });
    writeFileSync(join(root, 'src', 'c.js'), 'export function c() {}\n');
    let r = await api('/api/agent/changes', { base: 'auto' });
    assert.deepEqual(card().unmapped.map((x) => x.path), ['src/c.js']);
    // the new box goes on the map, the plan closes, `changes` once more: no code changed since
    writeFileSync(join(root, '.truemap', 'index.html'), map(box('a', 'data-to="b:calls c:calls"') + box('b') + box('c')));
    await sleep(400);
    await api('/api/agent/plan', { status: 'done', steps: ['1=done', '2=done'] });
    r = await api('/api/agent/changes', { base: 'auto' });
    const c = card();
    assert.deepEqual(c.unmapped, [], 'the card no longer calls src/c.js unmapped');
    assert.deepEqual(c.boxes.map((b) => [b.src, b.add]).sort(), r.boxes.map((b) => [b.src, b.add]).sort(), 'the card has the boxes the terminal reports');
    assert.deepEqual(c.notDone, r.plan.planned.filter((p) => !p.changed).map((p) => p.name || p.box));
    assert.deepEqual(c.notDone, []);
  } finally {
    await api('/api/agent/shutdown').catch(() => null);
  }
});
