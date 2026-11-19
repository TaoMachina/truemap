import { test } from 'node:test';
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
  const o = outline(dir);
  assert.equal(o.files, 3);
  assert.deepEqual(o.manifests, ['package.json']);
  assert.ok(o.entries.includes('src/index.ts'));
  assert.deepEqual(o.dirs.map((d) => d.path), ['.', 'src/', 'src/pay/']);
});
