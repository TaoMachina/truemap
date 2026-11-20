import { test } from 'node:test';
process.env.TRUEMAP_STATE_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'truemap-state-'));
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outline } from '../src/outline.js';

test('outline groups folders, finds manifests and entry points, skips vendored code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'truemap-outline-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src', 'pay'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}\n');
  writeFileSync(join(dir, 'src', 'pay', 'charge.ts'), 'export function chargeCard() {}\n');
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '');
  // nothing tracked yet: the folder walk stands in
  assert.equal(outline(dir).files, 3);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  const o = outline(dir);
  assert.equal(o.files, 3);
  assert.deepEqual(o.manifests, ['package.json']);
  assert.ok(o.entries.includes('src/index.ts'));
  assert.deepEqual(o.dirs.map((d) => d.path).sort(), ['.', 'src/', 'src/pay/']);
});

test('outline lists tracked files only and puts the biggest folders first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'truemap-outline-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, 'src', 'server.ts'), 'export function start() {}\n'.repeat(200));
  writeFileSync(join(dir, 'docs', 'a.md'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  // untracked, not ignored scratch work: not part of the project
  for (const d of ['.tmp-walk', '.a-work', 'aaa-scratch']) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, 'server.ts'), 'scratch\n'.repeat(5000));
  }
  const o = outline(dir);
  assert.equal(o.gitRepo, true);
  assert.equal(o.files, 3);
  assert.deepEqual(o.dirs.map((d) => d.path), ['.', 'src/', 'docs/']);
  assert.deepEqual(o.entries, ['src/server.ts']);
});
