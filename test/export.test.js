import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWires } from '../src/check.js';
import { exportPage } from '../src/export.js';

test('checkWires reports ids that are not on the page; commas and labels are fine', () => {
  const html = '<div id="a" data-to="b, c:writes"></div><div id="b" data-to="a"></div>';
  assert.deepEqual(checkWires(html).map((w) => `${w.from}->${w.to}`), ['a->c']);
});

test('exportPage inlines the kit, fonts and wires and refuses paths outside .truemap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'truemap-export-'));
  mkdirSync(join(dir, '.truemap'), { recursive: true });
  writeFileSync(join(dir, '.truemap', 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/truemap.css"></head><body><div class="tm-map"></div></body></html>');
  const html = exportPage(dir, 'index.html');
  assert.match(html, /^<!doctype html>\n<!-- Exported by truemap/);
  assert.ok(!html.includes('href="assets/truemap.css"'));
  assert.match(html, /data:font\/woff2;base64,/);
  assert.match(html, /window\.truemapWires/);
  assert.throws(() => exportPage(dir, '../package.json'));
});
