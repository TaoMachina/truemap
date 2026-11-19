// Plans: before a larger change the agent writes what it will touch and add; the user reviews it on the
// map and approves or asks for changes. A plan is data in .truemap/plans/<slug>.json, drawn as an overlay
// on an existing page (same boxes, same places; new boxes appear dashed in their group).
//
// {
//   "title": "Per-agent rate limits",
//   "page": "index.html",                         // the map it is drawn on (default index.html)
//   "summary": "Limit runs per agent per minute.",
//   "touch":  [{ "box": "runs", "what": "check the limit before starting a run" }],
//   "add":    [{ "id": "limits", "name": "Rate limits", "tag": "new module", "group": "hub",
//                "to": "store:reads", "from": ["runs:checks"], "why": "one place for the counters" }],
//   "remove": [{ "box": "old", "why": "replaced by limits" }],
//   "steps":  ["Add the limits table to [Store](#store)", "Check it in [Runs](#runs)"]
// }
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOLDER } from './common.js';

const str = (v, n) => String(v ?? '').slice(0, n);
const id = (v) => str(v, 60).trim().replace(/[^\w-]/g, '-');

export function slugOf(title) {
  return str(title, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plan';
}

/** Checks and trims a plan written by an agent. Throws with a message the agent can act on. */
export function cleanPlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('the plan must be a JSON object');
  const title = str(raw.title, 120).trim();
  if (!title) throw new Error('the plan needs a "title"');
  const list = (v) => (Array.isArray(v) ? v : []);
  const plan = {
    title,
    slug: slugOf(raw.slug || title),
    page: str(raw.page || 'index.html', 200).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/^\.truemap\//, ''),
    summary: str(raw.summary, 600),
    touch: list(raw.touch).slice(0, 30).map((t) => ({ box: str(t?.box, 300).trim(), what: str(t?.what, 400) })).filter((t) => t.box),
    add: list(raw.add).slice(0, 12).map((a) => ({
      id: id(a?.id), name: str(a?.name, 60).trim(), tag: str(a?.tag, 40), group: str(a?.group, 60), to: str(a?.to, 400),
      from: list(a?.from).slice(0, 8).map((f) => str(f, 120)).filter(Boolean), why: str(a?.why, 400),
    })).filter((a) => a.id && a.name),
    remove: list(raw.remove).slice(0, 12).map((r) => ({ box: str(r?.box, 300).trim(), why: str(r?.why, 400) })).filter((r) => r.box),
    steps: list(raw.steps).slice(0, 20).map((s) => str(s, 400)).filter(Boolean),
  };
  if (!plan.touch.length && !plan.add.length && !plan.remove.length) throw new Error('the plan names no boxes: add "touch", "add" or "remove" entries');
  return plan;
}

const dir = (root) => join(root, FOLDER, 'plans');

export function savePlan(root, plan) {
  mkdirSync(dir(root), { recursive: true });
  const file = join(dir(root), `${plan.slug}.json`);
  writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');
  return file;
}

export function readPlan(root, slug) {
  try { return JSON.parse(readFileSync(join(dir(root), `${slug}.json`), 'utf8')); } catch { return null; }
}

/** The plan in play: the newest one not marked done. */
export function currentPlan(root) {
  const d = dir(root);
  if (!existsSync(d)) return null;
  const files = readdirSync(d).filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: statSync(join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    const p = readPlan(root, f.replace(/\.json$/, ''));
    if (p && p.status !== 'done') return p;
  }
  return null;
}

/** The plan as a chat message: summary and steps, with box links the user can hover. */
export function planMessage(plan) {
  const lines = [`**${plan.revision > 1 ? 'Revised plan' : 'Plan'}: ${plan.title}**`];
  if (plan.summary) lines.push(plan.summary);
  if (plan.steps.length) { lines.push(''); plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`)); }
  return lines.join('\n');
}
