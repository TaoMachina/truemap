// Shared helpers: repo root, state files, version, safe executable lookup.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;
export const FOLDER = '.truemap';
const IS_WIN = process.platform === 'win32';
const CASE_INSENSITIVE_FS = IS_WIN || process.platform === 'darwin';

/**
 * Absolute path of an executable found on PATH. On Windows a bare name would also be looked up in the
 * current directory first, so a file planted in an untrusted checkout could run instead of git.
 */
const exeCache = new Map();
export function resolveExe(name) {
  if (exeCache.has(name)) return exeCache.get(name);
  let found = null;
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, IS_WIN && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext.toLowerCase() : name);
      try { if (statSync(candidate).isFile()) { found = candidate; break; } } catch { /* keep looking */ }
    }
    if (found) break;
  }
  exeCache.set(name, found);
  return found;
}

export function gitExe() { return resolveExe('git'); }

export function stateHome() {
  const dir = process.env.TRUEMAP_STATE_DIR || join(homedir(), '.truemap');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function stateSubdir(name) {
  const dir = join(stateHome(), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes a file readable only by the current user (token and chat history live in these). */
export function writePrivate(file, data) { writeFileSync(file, data, { mode: 0o600 }); }
export function appendPrivate(file, data) { appendFileSync(file, data, { mode: 0o600 }); }

/** Repo root = git toplevel when inside a git repo, else the current directory. */
export function findRoot(cwd = process.cwd()) {
  const git = gitExe();
  if (git) {
    try {
      const out = execFileSync(git, ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true }).trim();
      if (out) return resolve(out);
    } catch { /* not a git repo */ }
  }
  return resolve(cwd);
}

export function samePath(a, b) {
  const x = resolve(a); const y = resolve(b);
  return CASE_INSENSITIVE_FS ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function rootKey(root) {
  const r = resolve(root);
  return createHash('sha1').update(CASE_INSENSITIVE_FS ? r.toLowerCase() : r).digest('hex').slice(0, 16);
}

export function serversDir() { return stateSubdir('servers'); }
export function serverStatePath(root) { return join(stateSubdir('servers'), `${rootKey(root)}.json`); }
export function serverLockPath(root) { return join(stateSubdir('servers'), `${rootKey(root)}.lock`); }
export function historyPath(root) { return join(stateSubdir('history'), `${rootKey(root)}.jsonl`); }
export function verifiedPath(root) { return join(stateSubdir('verified'), `${rootKey(root)}.json`); }
export function snapshotsPath(root) { return join(stateSubdir('snapshots'), `${rootKey(root)}.json`); }

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Local usage log (outside the repo) used to measure unprompted agent use. */
export function logUsage(root, command) {
  try {
    appendPrivate(join(stateHome(), 'usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), root, command, agent: detectAgent() }) + '\n');
  } catch { /* never fail on logging */ }
}

export function detectAgent() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (Object.keys(process.env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return 'unknown';
}

export function folderPath(root) { return join(root, FOLDER); }
export function hasFolder(root) { return existsSync(folderPath(root)); }
export { IS_WIN, CASE_INSENSITIVE_FS };
