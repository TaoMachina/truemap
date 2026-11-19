# truemap v0.5 – spec (draft for review)

> 2026-11-19. Written before building, so it can be checked against real use first.
> Inputs: owner decisions, three independent reviews (usage flows, diagram research, visual/content audit), the v0.4 A/B test.

## 1. What truemap is for

**Review what your agents plan and what they changed, on a map of your system that stays true to the code.**
Understanding the system is the base layer; reviewing agent work is the daily reason to open it.

Who: developers who run coding agents (Claude Code, Codex, OpenCode, Cursor CLI…, directly or through hosts such as T3 Code), often several projects in parallel, open to new tools.

Daily moments, in order of value (from the usage review):
1. **Before a big change – review the plan.** The agent draws what it will touch and add; you push back on boxes; you approve.
2. **After the agent worked – review the change.** Changes grouped by box, measured against git; files with no box listed apart; open the diff from a box.
3. **Ask a question – the answer points at the map.** Steps in the answer light up the boxes they talk about.
4. **Look inside a box.** Summary first, code on demand, open in editor.
5. **Come back / onboard.** The map and a few named flows.

Out (cut after review): path mode with a "1/4" bar, animated arrows, a separate "explaining 2/3" bar, choice cards that light boxes, "changed this session" wording.

## 2. Scenarios (acceptance standard)

Each must work end to end in the browser, for a first-time user, without instructions.

**S1 Plan review.** User in their agent (terminal or T3 Code): "add per-agent rate limits". Agent: reads code, writes `.truemap/plan-rate-limits.html` (a map of the affected part: existing boxes marked *change*, new boxes drawn as *new*, a short list of steps), runs `truemap plan-rate-limits.html --review`. Browser shows the plan with a review bar: **Approve** / **Request changes**. User clicks a box ("don't put this in Runs, use the store") → comment; clicks Request changes → comments go to the agent. Agent revises the page; the bar shows "revised". User clicks Approve → the agent gets `status: approved` and starts.

**S2 Change review.** After the agent edits, the user opens the map (or it is already open; truemap notices the working tree changed). A **Changes** view: boxes whose code changed carry a change mark with +/− lines; a list "Changed, not on the map: 3 files" (tests, config, new files); a base selector (uncommitted / this branch vs main / last N commits). Click a changed box → inspector shows the diff for that box's files, with the agent's summary if it wrote one. Comment on a box → goes to the agent.

**S3 Ask.** User types in the panel: "where does a failed charge end up?". Agent answers in short steps; each step carries the boxes it is about; hovering or clicking a step lights those boxes (non-modal; no mode to exit). Inline box chips in the text do the same. Escape or clicking empty map space clears.

**S4 Look inside.** Click a box → inspector on the right (replaces the panel content, Esc/back returns): name, what it does, what you need to know (2–5 points), why it is built this way, freshness state, then **Show code** (collapsed) with the referenced line marked, **Open in editor**, calls / called by as chips, **Ask about this**.

**S5 Come back.** Map with groups and named flows as tabs. A flow tab shows the same map with numbered steps on the edges in order; other nodes go muted (text grey, borders kept – no opacity haze). Clicking the active tab or empty space returns to the plain map.

**S6 Many projects.** A project switcher lists every truemap project on this machine (running or recent): name, agent state (listening / working / idle), unread replies, pending plan. One click switches. A small badge shows "2 projects need you".

## 3. The map (drawing rules)

From the diagram research (C4, Ilograph, AWS/Cloudflare, Purchase et al.): one question per view, small labelled nodes inside groups, one reading direction, few crossings, detail off canvas.

- **Nodes:** name (1–3 words) + optional tag (e.g. "SQLite"), about 130–170 px, 2 lines max. No file paths, no sentences on the canvas. A small freshness dot only when stale (amber: code changed; red: gone).
- **Groups:** filled, borderless regions with a label, by responsibility ("Browser", "Hub core", "Executors", "Outside"). Every node belongs to one group. No layer column, no grid.
- **Direction:** one per view, left → right by default.
- **Edges:** only those that answer the question; a verb on every edge, shown on hover/lit; main path drawn in ink, others light grey. Smooth curves from a layered layout; merged parallels.
- **Size:** aim 7–12 nodes, hard limit 16; collapse a group into one node beyond that.
- **Layout:** a layered layout with groups (dagre, MIT, ~17 KB gz, vendored) places nodes; the agent never writes coordinates.

**What the agent writes (HTML, no build step):**
```html
<figure class="tm-diagram" data-direction="LR">
  <section class="tm-group" data-label="Hub core">
    <div class="tm-node" id="runs" data-src="server/routing.ts#Runs" data-tag="routing"
         data-to="acp:execute store:writes">Runs
      <div class="tm-detail">
        <p>Picks who receives a message and starts one run each.</p>
        <ul><li>One run at a time per agent and conversation.</li><li>Hop limit 3.</li></ul>
        <p class="tm-why">Runs are serialized because ACP takes one prompt per session.</p>
      </div>
    </div>
  </section>
  <ol class="tm-flows">
    <li data-title="A message reaches an agent" data-path="web api runs acp agents"></li>
  </ol>
</figure>
```
Plan pages add `data-plan="new|change|remove"` on nodes. `.tm-map` (v0.2–0.4) keeps rendering with the old renderer.

## 4. Look and feel

Fixed default, one adaptive token. A map is a document about code; it must read the same in every repo.
- **Adapts:** accent (read by `truemap theme` from the project's CSS variables / Tailwind config – never written by the agent), light/dark from the OS.
- **Fixed:** type, scale, spacing, radii, neutrals, components.
- **Type:** one sans for everything (distinctive but quiet; chosen in the design pass, not Inter/Plex by default), one mono for code. Five sizes, three weights.
- **Colour:** neutrals + ink for structure and selection; accent only for "the agent is pointing here" and the primary action. Status colours only for status.
- **Spacing:** 4 px grid; radii 4 / 8 / 12.
- **Chrome:** 44 px top bar: project switcher, page switcher (⌘K), status dot, Annotate, panel toggle. No file paths in the bar.
- **Panel:** agent text plain, user messages as filled bubbles, box chips inline, one-line empty state, composer without hint text.
- **Inspector:** slides over the panel, never covers the map; code full width with the line marked.
Quality bar: Linear (density, restraint), Stripe docs (code beside prose), Vercel/Geist (typography over colour), Things (calm chrome).

## 5. Agents and hosts

- Any agent that can run a shell command works: `npx -y truemap-cli …`. Hosts like T3 Code run Claude Code / Codex / OpenCode underneath, so the same skill and CLI apply.
- Waiting for the user: background with completion notice where the harness has it (Claude Code), else foreground `listen --timeout 540` in a loop. The CLI prints the right instruction for the detected agent; unknown agents get both.
- Agent identity: detected from the environment where possible, else `--agent <name>` once per session.

## 6. Commands (agent side)

| Command | New/changed |
|---|---|
| `truemap <page> [--review]` | `--review` shows the plan bar; `listen` returns `approved` or comments |
| `truemap changes [--base main\|HEAD~3]` | prints changed boxes / unmapped files; opens the Changes view |
| `truemap reply "…" --steps file.json` | an answer as steps, each with box ids |
| `truemap theme` | reads the project accent once into `.truemap/assets/theme.css` |
| `truemap projects` | lists truemap projects on this machine |

## 7. How we check it

1. A subagent walks S1–S6 as a first-time user, with screenshots, on Dango (real project).
2. A design critic compares against the quality bar.
3. **Daily-use trial:** a subagent playing a developer who runs agents on several projects uses truemap for a session of real tasks on Dango and the demo shop, and answers: would I put this in my day? What would stop me? Ship only when the answer is yes or the gaps are named and fixed.

## 8. Changes after the spec review (adopted)

1. **Plan trigger:** the project note says "a change touching 3+ boxes or adding a box → plan first"; the user can also ask with `/truemap plan …`. Approval works in both places: the browser bar, or the user says "go" in the terminal and the agent runs `truemap plan --approve`.
2. **Plan and Changes are overlays on the base map,** not separate pages: same node ids, same positions; new boxes appear as ghosts in their group. A plan is data (`.truemap/plans/<slug>.json`: title, steps, touched box ids with what changes, new boxes with group and edges), written by `truemap plan --file`.
3. **Diff base:** default = the snapshot taken when the plan was approved; without a plan, the snapshot taken at the agent's last turn end (each `listen` call). Also "vs main". Nothing else.
4. **Plan vs actual:** planned and touched / planned but untouched / changed but not in the plan.
5. **Attribution is file-level and says so** ("2 boxes share this file"); a folder anchor matches everything under it.
6. **Agent notes:** `truemap note <box> "…"`, shown apart from git facts, labelled as the agent's account.
7. **One click model:** a click selects a box and opens the inspector, which has a comment field at the top. Annotate mode is removed; selecting text still offers Comment.
8. **Changes view hides stale dots;** after a plan is built, the agent folds its new boxes into `index.html` and the plan is marked done.
9. **Empty map:** unmapped changes are grouped by folder with one action, "Ask the agent to map these".
10. **One hub server** for all repos on the machine: a projects menu with pending plans and unread replies; the tab title shows "(2)".
11. **Answer steps** are a numbered Markdown list with box links (no `--steps` JSON). `theme` is reduced to reading the project's accent automatically. Old `.tm-map` pages keep rendering.
12. **Layout spike** with dagre + groups on Dango's real map before building the rest; a strict page linter in `truemap <page>` and `check`.
