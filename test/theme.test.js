import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrastNotes, ratio, tokens } from '../src/contrast.js';
import { themeable } from '../src/theme.js';
import { kitCss, tokensCss } from '../src/export.js';

test('contrast: black on white is 21:1', () => {
  assert.equal(Math.round(ratio('#000', '#ffffff')), 21);
  assert.equal(ratio('var(--x)', '#fff'), null);
});

test('the default tokens are readable in light and dark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-theme-'));
  assert.deepEqual(contrastNotes(tokensCss(dir)), []);
});

test('a theme overrides the tokens, and faint colours are caught in the mode they break', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-theme-'));
  mkdirSync(join(dir, '.truemap', 'assets'), { recursive: true });
  writeFileSync(join(dir, '.truemap', 'assets', 'theme.css'), ':root { --tm-accent: #2457c5; }\n@media (prefers-color-scheme: dark) { :root { --tm-text: #222; } }\n');
  const css = tokensCss(dir);
  const t = tokens(css);
  assert.equal(t.light['--tm-accent'], '#2457c5');
  assert.equal(t.dark['--tm-text'], '#222');
  const notes = contrastNotes(css);
  assert.ok(notes.some((n) => n.startsWith('dark: body text')), notes.join('\n'));
  assert.ok(!notes.some((n) => n.startsWith('light:')), notes.join('\n'));
  // the page kit carries the same theme, after the components
  const kit = kitCss(dir);
  assert.ok(kit.indexOf('--tm-paper') < kit.indexOf('.tm-diagram') && kit.lastIndexOf('#2457c5') > kit.indexOf('.tm-diagram'));
});

test('contrast reads hsl() and colour names, checks the highlighter, and says what it cannot read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-theme-'));
  mkdirSync(join(dir, '.truemap', 'assets'), { recursive: true });
  writeFileSync(join(dir, '.truemap', 'assets', 'theme.css'), ':root { --tm-text: hsl(0 0% 80%); --tm-graphite: lightgray; --tm-mark: #141413; --tm-pencil: color-mix(in oklab, red, blue); }\n');
  const notes = contrastNotes(tokensCss(dir)).filter((n) => n.startsWith('light:'));
  for (const what of ['body text', 'secondary text', 'text on the highlighter', "hints: can't read"]) assert.ok(notes.some((n) => n.includes(what)), `${what}\n${notes.join('\n')}`);
});

test('dark mode answers to the system and to the user\'s choice', () => {
  const out = themeable(':root { --a: 1; }\n@media (prefers-color-scheme: dark) { :root { --a: 2; } }');
  assert.match(out, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{ --a: 2; \}\s*\}/);
  assert.match(out, /:root\[data-theme="dark"\] \{ --a: 2; \}/);
});
