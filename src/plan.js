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
function revisionDiff(prev, plan, nameOf = (b) => b) {
  if (!prev) return [];
  const names = (p) => new Map([...p.touch.map((t) => [`touch:${t.box}`, nameOf(t.box)]), ...p.add.map((a) => [`add:${a.id}`, a.name]), ...p.remove.map((r) => [`remove:${r.box}`, nameOf(r.box)])]);
  const a = names(prev); const b = names(plan);
  const out = [];
  for (const [k, v] of b) if (!a.has(k)) out.push(`+ ${k.split(':')[0] === 'add' ? 'new box' : k.split(':')[0]} ${v}`);
  for (const [k, v] of a) if (!b.has(k)) out.push(`− no longer ${k.split(':')[0] === 'add' ? 'adds' : k.split(':')[0] === 'touch' ? 'touches' : 'removes'} ${v}`);
  const what = (p) => new Map(p.touch.map((t) => [t.box, t.what]));
  for (const [box, w] of what(plan)) if (what(prev).has(box) && what(prev).get(box) !== w) out.push(`~ ${nameOf(box)}: was "${what(prev).get(box)}", now "${w}"`);
  const n = Math.max(prev.steps.length, plan.steps.length);
  for (let i = 0; i < n; i++) {
    if (prev.steps[i] === plan.steps[i]) continue;
    if (prev.steps[i] === undefined) out.push(`+ step ${i + 1}: ${plan.steps[i]}`);
    else if (plan.steps[i] === undefined) out.push(`− step ${i + 1}: ${prev.steps[i]}`);
    else out.push(`~ step ${i + 1}: was "${prev.steps[i]}", now "${plan.steps[i]}"`);
  }
  return out;
}

export function planMessage(plan, prev = null, nameOf) {
  const lines = [`**${plan.revision > 1 ? 'Revised plan' : 'Plan'}: ${plan.title}**`];
  if (plan.summary) lines.push(plan.summary);
  const nm = nameOf || ((b) => b);
  const what = [...plan.touch.map((t) => `- [${nm(t.box)}](#${t.box}): ${t.what || 'changes'}`), ...plan.add.map((a) => `- New [${a.name}](#${a.id}): ${a.why || ''}`), ...plan.remove.map((r) => `- Remove ${nm(r.box)}: ${r.why || ''}`)];
  if (what.length) lines.push('', ...what);
  const diff = revisionDiff(prev, plan, nameOf);
  if (prev) lines.push('', diff.length ? `Changed since the last revision:\n${diff.map((d) => `- ${d}`).join('\n')}` : 'Nothing changed in the boxes or steps since the last revision.');
  if (plan.steps.length) { lines.push(''); plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`)); }
  return lines.join('\n');
}

/** The box a plan names, as its data-src on the plan's page (a plan may name a box by id or by data-src). */
export function srcOfBox(root, page, box, want = 'data-src') {
  if (want === 'data-src' && /[/#.]/.test(box)) return box;
  let html = '';
  try { html = readFileSync(join(root, FOLDER, page), 'utf8'); } catch { return null; }
  const esc = box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<[^>]*\\sid=["']${esc}["'][^>]*>`, 'i'))?.[0];
  return tag?.match(new RegExp(`\\s${want}=["']([^"']+)["']`, 'i'))?.[1] || null;
}

/** Plan entries that name boxes or groups the page doesn't have. */
export function planWarnings(root, plan) {
  let html = '';
  try { html = readFileSync(join(root, FOLDER, plan.page), 'utf8'); } catch { return [`page not found: ${FOLDER}/${plan.page}`]; }
  const has = (id) => new RegExp(`\\sid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(html);
  const hasSrc = (src) => html.includes(`data-src="${src}"`) || html.includes(`data-src='${src}'`);
  const out = [];
  for (const t of [...plan.touch, ...plan.remove]) if (!(has(t.box) || hasSrc(t.box))) out.push(`"${t.box}" is not a box id or data-src on ${plan.page}`);
  const groups = [...html.matchAll(/<section\b[^>]*class=["'][^"']*\btm-group\b[^>]*>/gi)].map((m) => [m[0].match(/\sid=["']([^"']+)/)?.[1], m[0].match(/data-label=["']([^"']+)/)?.[1]].filter(Boolean).map((x) => x.toLowerCase()));
  for (const a of plan.add) {
    if (has(a.id)) out.push(`new box "${a.id}" already exists on the page`);
    if (a.group && !groups.some((g) => g.includes(a.group.toLowerCase()))) out.push(`new box "${a.id}": group "${a.group}" is not on the page (it goes in the first group)`);
    for (const spec of [...a.to.split(/[\s,]+/), ...a.from].filter(Boolean)) { const id = spec.split(':')[0]; if (id && !has(id)) out.push(`new box "${a.id}": "${id}" in to/from is not a box on the page`); }
  }
  return out;
}

/** Plan against what actually changed: planned and changed, planned but untouched, changed but not planned. */
export function planCheck(root, plan, result) {
  if (!plan || !result?.boxes) return null;
  // Facts only: which planned boxes have changes in their files (own or data-also), and which files.
  // Whether a change does what was planned is for the person to judge, beside the diff; a file-based
  // "built" verdict is wrong both ways (a rename counts, work in an attached file doesn't).
  const byBox = new Map(result.boxes.map((b) => [b.src, b.files.map((x) => x.path)]));
  const planned = [
    ...plan.touch.map((t) => ({ box: t.box, what: t.what, kind: 'change' })),
    ...plan.add.map((a) => ({ box: a.id, what: a.why, kind: 'new', name: a.name })),
  ].map((p) => { const src = srcOfBox(root, plan.page, p.box); return { ...p, name: p.name || srcOfBox(root, plan.page, p.box, 'data-name') || p.box, src, changed: !!src && byBox.has(src), files: (src && byBox.get(src)) || [] }; });
  const plannedSrc = new Set(planned.map((p) => p.src).filter(Boolean));
  return { title: plan.title, planned, unplanned: result.boxes.filter((b) => !plannedSrc.has(b.src)).map((b) => b.src) };
}
