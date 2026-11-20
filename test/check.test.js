import { test } from 'node:test';
process.env.TRUEMAP_STATE_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'truemap-state-'));
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAll, extractAnchors, listPages, markOk, parseAnchor } from '../src/check.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'truemap-test-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.truemap'), { recursive: true });
  writeFileSync(join(dir, 'src', 'pay.ts'), 'export function chargeCard() {}\nexport function recharge() {}\n');
  return dir;
}

const commit = (dir, msg, date) => {
  git(dir, 'add', '-A');
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};

test('parseAnchor and extractAnchors', () => {
  assert.deepEqual(parseAnchor('src/a.ts#fn'), { path: 'src/a.ts', name: 'fn' });
  assert.deepEqual(parseAnchor('./src/dir/'), { path: 'src/dir/', name: '' });
  assert.deepEqual(parseAnchor('src\\a.ts'), { path: 'src/a.ts', name: '' });
  assert.deepEqual(extractAnchors(`<a data-src="x.ts#a"></a><b data-src='y.ts'></b><i data-src="x.ts#a"></i>`), ['x.ts#a', 'y.ts']);
});

test('extractAnchors counts attributes on elements, not samples in text, code, comments or scripts', () => {
  const html = `<p>Put data-src="src/server.js#inText" on a box.</p>
    <pre><code>&lt;div class="tm-node" data-src="src/server.js#escaped"&gt;</code></pre>
    <pre><div data-src="src/server.js#inPre"></div></pre>
    <p>Use <code>data-src="src/server.js#inCode"</code> or <code><b data-src="src/a.js#rawInCode"></b></code>.</p>
    <!-- <div data-src="src/server.js#inComment"></div> -->
    <script>const s = '<div data-src="src/server.js#inScript">';</script>
    <span title='data-src="src/x.js#inValue"'>x</span>
    <div class="tm-node"
         data-name="Server" data-src="src/server.js#startServer"></div>
    <code data-src="src/code.js#onCode">onCode</code>
    <a data-src=src/bare.js>bare</a>`;
  assert.deepEqual(extractAnchors(html), ['src/server.js#startServer', 'src/code.js#onCode', 'src/bare.js']);
});

test('a draft that shows an anchor as an example is not reported broken', () => {
  const dir = repo();
  mkdirSync(join(dir, '.truemap', 'drafts'), { recursive: true });
  writeFileSync(join(dir, '.truemap', 'drafts', '001-anchors.html'), `<title>Anchors</title>
    <p>A box says where its code is: <code>data-src="src/pay.ts#gone"</code>.</p>
    <pre>&lt;div data-src="src/missing.ts#nothing"&gt;</pre>
    <div data-src="src/pay.ts#chargeCard"></div>`);
  const r = checkAll(dir, ['drafts/001-anchors.html']).results[0];
  assert.deepEqual(r.anchors.map((a) => [a.src, a.state]), [['src/pay.ts#chargeCard', 'ok']]);
});

test('ok, broken path, broken name, whole-word matching', () => {
  const dir = repo();
  writeFileSync(join(dir, '.truemap', 'index.html'), `<title>Blueprint</title>
    <div data-src="src/pay.ts#chargeCard"></div>
    <div data-src="src/pay.ts#charge"></div>
    <div data-src="src/Pay.ts"></div>
    <div data-src="src/"></div>
    <div data-src="src/missing.ts"></div>`);
  commit(dir, 'init', '2026-01-01T00:00:00Z');
  const [r] = checkAll(dir).results;
  const by = Object.fromEntries(r.anchors.map((a) => [a.src, a.state]));
  assert.equal(by['src/pay.ts#chargeCard'], 'ok');
  assert.equal(by['src/pay.ts#charge'], 'broken', '"charge" must not match inside "chargeCard"/"recharge"');
  assert.equal(by['src/Pay.ts'], 'broken', 'paths are case-sensitive');
  assert.equal(by['src/'], 'ok', 'folder anchors work');
  assert.equal(by['src/missing.ts'], 'broken');
  assert.equal(listPages(dir)[0].title, 'Blueprint');
});

test('changed after page, cleared by --ok + commit', () => {
  const dir = repo();
  writeFileSync(join(dir, '.truemap', 'pay.html'), '<html><head></head><body><div data-src="src/pay.ts#chargeCard"></div></body></html>');
  commit(dir, 'page', '2026-01-01T00:00:00Z');
  writeFileSync(join(dir, 'src', 'pay.ts'), 'export function chargeCard(x) {}\n');
  commit(dir, 'code', '2026-01-02T00:00:00Z');
  assert.equal(checkAll(dir).results[0].anchors[0].state, 'changed');

  assert.ok(markOk(dir, 'pay.html'));
  commit(dir, 'reviewed', '2026-01-03T00:00:00Z');
  assert.equal(checkAll(dir).results[0].anchors[0].state, 'ok');
});

test('uncommitted code change counts as changed', () => {
  const dir = repo();
  writeFileSync(join(dir, '.truemap', 'pay.html'), '<div data-src="src/pay.ts"></div>');
  commit(dir, 'all', '2026-01-01T00:00:00Z');
  writeFileSync(join(dir, 'src', 'pay.ts'), 'export function chargeCard(y) {}\n');
  assert.equal(checkAll(dir).results[0].anchors[0].state, 'changed');
});

test('index.html is listed first and assets/ is ignored', () => {
  const dir = repo();
  mkdirSync(join(dir, '.truemap', 'assets'), { recursive: true });
  writeFileSync(join(dir, '.truemap', 'assets', 'x.html'), '');
  writeFileSync(join(dir, '.truemap', 'a.html'), '');
  writeFileSync(join(dir, '.truemap', 'index.html'), '');
  assert.deepEqual(listPages(dir).map((p) => p.page), ['index.html', 'a.html']);
});

test('dirty page, later dirty code edit is still caught (mtime order)', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.truemap', 'pay.html'), '<div data-src="src/pay.ts#chargeCard"></div>');
  commit(dir, 'all', '2026-01-01T00:00:00Z');
  writeFileSync(join(dir, '.truemap', 'pay.html'), '<div data-src="src/pay.ts#chargeCard">edited</div>');
  await new Promise((r) => setTimeout(r, 1100));
  writeFileSync(join(dir, 'src', 'pay.ts'), 'export function chargeCard(z) {}\n');
  assert.equal(checkAll(dir).results[0].anchors[0].state, 'changed');
});

test('deleted tracked file is broken; unicode letters count as word characters', () => {
  const dir = repo();
  writeFileSync(join(dir, 'src', 'i18n.ts'), 'const fooé = 1;\n');
  writeFileSync(join(dir, '.truemap', 'x.html'), '<i data-src="src/i18n.ts#foo"></i><i data-src="src/pay.ts"></i>');
  commit(dir, 'all', '2026-01-01T00:00:00Z');
  rmSync(join(dir, 'src', 'pay.ts'));
  const by = Object.fromEntries(checkAll(dir).results[0].anchors.map((a) => [a.src, a.state]));
  assert.equal(by['src/i18n.ts#foo'], 'broken');
  assert.equal(by['src/pay.ts'], 'broken');
});

test('markOk refuses paths outside .truemap', () => {
  const dir = repo();
  assert.equal(markOk(dir, '../src/pay.ts'), false);
});

test('editing the page does not clear drift on a box whose code changed', () => {
  const dir = repo();
  writeFileSync(join(dir, '.truemap', 'index.html'), '<div data-src="src/pay.ts#chargeCard"></div>');
  commit(dir, 'init', '2026-01-01T00:00:00Z');
  assert.equal(checkAll(dir).results[0].anchors[0].state, 'ok'); // fingerprint taken
  writeFileSync(join(dir, 'src', 'pay.ts'), 'export function chargeCard(x) {}\n');
  assert.equal(checkAll(dir).results[0].anchors[0].state, 'changed');
  writeFileSync(join(dir, '.truemap', 'index.html'), '<div data-src="src/pay.ts#chargeCard"></div><div data-src="src/"></div>');
  const r = checkAll(dir).results[0];
  assert.equal(r.anchors.find((a) => a.src === 'src/pay.ts#chargeCard').state, 'changed', 'a newer page must not hide it');
  markOk(dir, 'index.html');
  assert.equal(checkAll(dir).results[0].anchors.find((a) => a.src === 'src/pay.ts#chargeCard').state, 'ok');
});
