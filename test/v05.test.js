import { test } from 'node:test';
process.env.TRUEMAP_STATE_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'truemap-state-'));
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintDiagrams } from '../src/check.js';
import { cleanPlan, slugOf } from '../src/plan.js';
import { attribute, changes, snapshotTree } from '../src/changes.js';

const page = (body) => `<!doctype html><html><head><link rel="stylesheet" href="assets/truemap.css"></head><body>${body}</body></html>`;

test('lintDiagrams passes a well-formed map and names what is wrong in a bad one', () => {
  const good = page(`<figure class="tm-diagram"><section class="tm-group" id="core" data-label="Core">
    <div class="tm-node" id="runs" data-name="Runs" data-tag="routing" data-src="server/routing.ts#Runs" data-to="store:writes"></div>
    <div class="tm-node" id="store" data-name="Store" data-src="server/store.ts"></div></section>
    <ol class="tm-flows"><li data-path="runs store">Write</li></ol></figure>`);
  assert.deepEqual(lintDiagrams(good), []);
  const bad = page(`<style>.x{color:red}</style><figure class="tm-diagram"><section class="tm-group" data-label="Core">
    <div class="tm-node" id="runs" data-name="The thing that routes every message" data-src="a.ts"></div></section>
    <div class="tm-node" id="loose" data-name="Loose"></div>
    <ol class="tm-flows"><li data-path="runs ghost">Write</li></ol></figure>`);
  const notes = lintDiagrams(bad).join('\n');
  assert.match(notes, /is long/);
  assert.match(notes, /outside any group/);
  assert.match(notes, /"Loose" has no data-src/);
  assert.match(notes, /flow step "ghost"/);
  assert.match(notes, /own colours/);
});

test('cleanPlan keeps the parts it needs and refuses a plan that names no boxes', () => {
  const p = cleanPlan({ title: 'Per-agent rate limits!', page: '.truemap/index.html', touch: [{ box: 'runs', what: 'check' }], add: [{ id: 'lim its', name: 'Rate limits', group: 'hub', from: ['runs:asks'] }], steps: ['a', 2] });
  assert.equal(p.slug, 'per-agent-rate-limits');
  assert.equal(p.page, 'index.html');
  assert.equal(p.add[0].id, 'lim-its');
  assert.deepEqual(p.steps, ['a', '2']);
  assert.throws(() => cleanPlan({ title: 'x' }), /names no boxes/);
  assert.throws(() => cleanPlan({}), /title/);
  assert.equal(slugOf('  '), 'plan');
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'truemap-ch-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  mkdirSync(join(root, 'server')); mkdirSync(join(root, '.truemap'));
  writeFileSync(join(root, 'server', 'routing.ts'), 'export class Runs {}\n');
  writeFileSync(join(root, 'server', 'store.ts'), 'export class Store {}\n');
  writeFileSync(join(root, '.truemap', 'index.html'), page(`<figure class="tm-diagram"><section class="tm-group" data-label="Core">
    <div class="tm-node" id="runs" data-name="Runs" data-src="server/routing.ts#Runs"></div>
    <div class="tm-node" id="all" data-name="Server" data-src="server/"></div></section></figure>`));
  git('add', '-A'); git('commit', '-qm', 'init');
  return { root, git };
}

test('attribute: a box owns its file, a folder box owns everything under it, the rest is grouped by folder', () => {
  const { root } = repo();
  const r = attribute(root, [{ path: 'server/routing.ts', add: 2, del: 1 }, { path: 'scripts/x/bench.sh', add: 1, del: 0 }, { path: 'README.md', add: 1, del: 0 }]);
  const runs = r.boxes.find((b) => b.src === 'server/routing.ts#Runs');
  assert.equal(runs.add, 2);
  assert.equal(runs.files[0].shared, 1); // the folder box covers it too
  assert.ok(r.boxes.find((b) => b.src === 'server/'));
  assert.deepEqual(r.unmapped.map((g) => g.folder).sort(), ['(top level)', 'scripts/x/']);
});

test('changes: measured from a snapshot, without touching the staging area', async () => {
  const { root, git } = repo();
  const base = await snapshotTree(root);
  assert.match(base, /^[0-9a-f]{40}$/);
  writeFileSync(join(root, 'server', 'routing.ts'), 'export class Runs {}\n// limit\n');
  writeFileSync(join(root, 'new.txt'), 'hi\n');
  const before = git('status', '--porcelain');
  const r = await changes(root, 'turn', { turn: { tree: base, at: new Date().toISOString() } });
  assert.equal(r.base.kind, 'turn');
  assert.equal(r.files, 2);
  assert.equal(r.boxes.find((b) => b.src === 'server/routing.ts#Runs').add, 1);
  assert.equal(git('status', '--porcelain'), before); // nothing staged by us
  const head = await changes(root, 'head', {});
  assert.equal(head.base.kind, 'head');
  assert.equal(head.files, 2);
});

test('planCheck: planned and changed, planned but untouched, changed outside the plan', async () => {
  const { planCheck, planMessage, cleanPlan: clean } = await import('../src/plan.js');
  const { root } = repo();
  const plan = clean({ title: 'T', page: 'index.html', touch: [{ box: 'runs', what: 'a' }, { box: 'all', what: 'b' }], add: [{ id: 'lim', name: 'Limits' }] });
  const r = planCheck(root, plan, { boxes: [{ src: 'server/routing.ts#Runs', files: [{ path: 'server/routing.ts', own: true }] }, { src: 'server/', files: [{ path: 'server/types.ts', own: false }] }, { src: 'x.ts', files: [{ path: 'x.ts', own: true }] }] });
  // facts, not a verdict: which planned boxes have changes in their files, and which files
  assert.deepEqual(r.planned.map((p) => [p.box, p.changed]), [['runs', true], ['all', true], ['lim', false]]);
  assert.deepEqual(r.planned[1].files, ['server/types.ts']);
  assert.deepEqual(r.unplanned, ['x.ts']);
  const prev = clean({ title: 'T', touch: [{ box: 'runs', what: 'a' }], steps: ['one'] });
  const msg = planMessage({ ...plan, revision: 2 }, prev);
  assert.match(msg, /Revised plan: T/);
  assert.match(msg, /\+ touch all/);
  assert.match(msg, /\+ new box Limits/);
});

test('steps are checked against the files and boxes they name; closing a plan needs a report for every step', async () => {
  const { stepCheck, parseReport, cleanPlan: clean } = await import('../src/plan.js');
  const { root } = repo();
  const plan = clean({ title: 'T', page: 'index.html', touch: [{ box: 'runs' }], steps: ['Track it in [Runs](#runs)', 'Start it in createHub (server/hub.ts)'] });
  const st = stepCheck(root, plan, { files_list: [{ path: 'server/routing.ts' }], boxes: [{ src: 'server/routing.ts#Runs' }] });
  assert.equal(st[0].boxes[0].changed, true);
  assert.deepEqual(st[1].files, [{ path: 'server/hub.ts', changed: false }]);
  assert.deepEqual(parseReport(plan, ['1=done']).missing, [2]);
  assert.throws(() => parseReport(plan, ['2=not_built']), /say why/);
  assert.equal(parseReport(plan, ['1=done', '2=not_built:later']).report[1].status, 'not_built');
});
