# Architecture

> 2026-11-19, v0.5. This describes what is implemented; the v0.5 decisions are in [SPEC-v0.5.md](SPEC-v0.5.md). Earlier, heavier designs are kept in [archive/](archive/).

## First principles

The product only needs three things:

1. **The agent talks to people through HTML** that they can read at a glance and click.
2. **Those pages stay in the project and don't lie.** They are still there next time, and a code change that makes them wrong gets noticed.
3. **People can talk to the agent right next to the page.** They select something and ask about it.

Everything else is extra and stays out of v1. Two questions decide every feature: *does the user have to do one more thing?* and *does the agent have to learn one more rule?* If either answer is yes, the feature goes.

## The whole product: one folder + one CLI

```
your-repo/
└── .truemap/                 plain HTML, nothing else
    ├── index.html            the blueprint: overall structure, each module links to its page
    ├── payments.html
    ├── retry-decision.html
    └── assets/theme.css      optional token overrides (brand colors, font); the kit itself is served by truemap
```

- **There is no data model, no IDs and no config.** The folder is the index and the HTML is everything.
- **Pages appear on demand.** When the agent explains something, its page stays. Next time the agent updates that page instead of writing a new one.
- **Anchors live inside the HTML:** `<div data-src="src/pay/charge.ts#chargeCard">`. The agent adds one attribute per element.

### Positioning and distribution (decided)

This is our own product. It defines a new way for agents and people to interact: agents speak through persistent pages in the repo, and people point, ask and decide on them. lavish-axi proved that reviewing a single page works. truemap is the layer above it: project-level, persistent, and checked against the code.

We own three distribution points:

1. **The skill**, listed on skills.sh and the plugin marketplaces. It decides when an agent thinks of us.
2. **The command name**: agents always call `npx -y truemap-cli`. (npm refused the bare name `truemap` as too close to `true-map`; the installed binary is still `truemap`.)
3. **The `.truemap/` folder convention.** Every repo that carries the folder spreads the tool: when someone clones it, their agent sees the folder and opens it with truemap.

## Commands (all the agent needs)

| Command | What it does |
|---|---|
| `npx -y truemap-cli [page]` | Opens the workspace in the user's default browser, or switches the tab that is already open. Defaults to `index.html`. Prints the check result for the page and a `next_step` |
| `npx -y truemap-cli plan --file plan.json` / `--approve` / `--done` | Draws a plan on its map for review; `listen` returns the approval or the requested changes |
| `npx -y truemap-cli changes [--base turn\|plan\|head\|main]` | What changed, by box, and opens the Changes view |
| `npx -y truemap-cli outline` | A compact repo outline (folders, sizes, manifests, likely entry points) so the first blueprint is fast |
| `npx -y truemap-cli listen [--timeout s]` | Long-polls for the user's next chat message. Returns `message`, `browser_closed`, `replaced` or `timeout` |
| `npx -y truemap-cli reply "<text>" [--listen] [--file path\|-] [--focus ids]` | Shows the answer in the chat and lights up the boxes it is about. With `--listen` it keeps listening in the same call |
| `npx -y truemap-cli show [page] --focus ids [--note "…"] [--clear]` | The agent points at the map: lights up boxes (ids or data-src), dims the rest, pins a note |
| `npx -y truemap-cli ask "<question>" --option "A \| why" --option "B \| why"` | A choice card in the conversation; waits for the answer. Only for decisions that are hard to undo |
| `npx -y truemap-cli check [page…]` / `check --ok <page>` | Checks anchors / marks a page as reviewed |
| `npx -y truemap-cli export <page> [--out f]` | Writes the page as one self-contained HTML file (kit, fonts, images and wires inlined) |
| `npx -y truemap-cli guide` | The page-writing guide: folder rules, anchors, kit components, decision forms |
| `npx -y truemap-cli progress "<text>"` | Shows a short status line in the chat while the agent works |
| `npx -y truemap-cli stop` | Stops the background server |

- **Zero install:** `npx -y` runs it directly.
- **No login:** the chat panel talks to the user's current Claude Code or Codex session. truemap never starts an agent and never touches credentials.
- **The output tells the agent the next step**, in the AXI style. Agents learn the tool by using it.

## Components

```
browser workspace (http://127.0.0.1:<port>/?t=<token>)
 ├─ top bar: projects menu + page switcher (Ctrl/Cmd+K) + check status + one panel toggle
 ├─ plan bar (when a plan is in review): Approve / Request changes
 ├─ center: the page in a sandboxed iframe from a SEPARATE origin (http://127.0.0.1:<contentPort>)
 │    the injected SDK lays out maps (dagre), draws connections, marks stale / changed / planned boxes
 └─ panel (collapsible): Conversation | Changes tabs; the inspector replaces it while a box is open
        │  SSE (server → browser) + fetch POST (browser → server)
local server (src/server.js, one per repo, detached, auto-exits when idle)
 ├─ chat queue between browser and agent
 ├─ fs.watch on .truemap/ → reload + re-check
 ├─ serves the page kit + fonts (kit/), with .truemap/assets/theme.css appended
 └─ checker (src/check.js)
        ▲  HTTP with token (from ~/.truemap/servers/<repo-hash>.json)
CLI (src/cli.js) ← run by the agent
```

| File | Role |
|---|---|
| `bin/truemap.js`, `src/cli.js` | The CLI. Output is YAML-ish text written for agents |
| `src/server.js` | Two HTTP listeners: workspace + API (token-protected), and content (pages only, SDK injected) |
| `src/check.js` | Anchor checker; also lists pages |
| `src/outline.js` | Repo outline for `truemap outline` |
| `src/export.js` | One-file export; also builds the served kit CSS |
| `src/ui/diagram.js` | v0.5 maps (`figure.tm-diagram`): groups and small boxes laid out by dagre (vendored, MIT) in the author's group order, curved arrows, labels placed on their own edge, flows as tabs with numbered steps, plan ghosts. Shared by the SDK and exports |
| `src/ui/wires.js` | The older `.tm-map` wire router, kept so v0.2-0.4 pages still render |
| `src/changes.js` | Change review: working-tree snapshots as git trees (through a throwaway index), diffs against a base, file-level attribution to boxes |
| `src/plan.js` | Plans: validation, `.truemap/plans/<slug>.json`, the plan as a chat message |
| `src/ui/workspace.*` | Workspace UI: zero dependencies, no build step |
| `src/ui/sdk.js` | Injected into served pages only (never written to files). Draws map wires, runs annotate mode and the comment card, decision forms and check marks |
| `kit/truemap.css`, `kit/fonts/` | The page kit and fonts (Instrument Sans, Commit Mono; IBM Plex kept for older copied kits), served to every page as `assets/truemap.css`, so repos always get the current kit. A repo that keeps its own `assets/truemap.css` (older setups) keeps it |
| `src/guide.md` | Printed by `truemap guide` |
| `skills/truemap/SKILL.md` | A short skill stub that sends the agent to the CLI |

Zero runtime dependencies, Node ≥ 20.

## Chat rules (listen / reply)

- **Messages queue.** Messages sent while the agent is busy are kept. The next `listen` returns all of them at once, in order, each with its page and its numbered comments (element or text, `data-src`, comment text).
- **Comments.** A click on a box opens the inspector with a comment field on top; a text selection offers a small Comment button. Each comment becomes a numbered pin on the page and a row in the panel; Send delivers all of them in one message. (v0.4's Annotate mode is gone: one click model.)
- **There is one listener at a time.** A new `listen` replaces the old one, which returns `replaced`.
- **`browser_closed`** is returned about 10 s after the last tab closes, so the agent never waits forever.
- **`reply --listen`** answers and keeps listening in one call, so the conversation doesn't drop when the agent forgets to listen again.
- **Per-agent guidance** is printed by the CLI, based on environment detection:
  - Claude Code runs `listen` with `run_in_background`. Waiting costs no tokens and the terminal stays free.
  - Codex runs it in the foreground.
- **The browser shows the agent's state**, by name (Claude Code, Codex): listening; working (with elapsed time and progress lines); not listening (it answered and went back to the terminal); no agent connected; or workspace closed (the server stopped). Each non-live state shows what to do next, with a copyable command. Messages sent while no one listens are marked *Waiting for the agent*.
- **Messages from page scripts** (`window.truemap.send`, untrusted decision submits) are tagged `from: page`, so the agent can tell them apart from the user.

## The checker: language-agnostic

For each `data-src="path#name"` (`#name` is optional):

1. **The path must exist** with exact case, relative to the repo root (`git ls-files`, including untracked files). If it doesn't: **✕ broken**.
2. **`name` must still appear in the file** as a case-sensitive whole word (`charge` does not match `recharge`). If it doesn't: **✕ broken**.
3. **The code must not have changed after the page.** The time of a file is now if it is dirty or untracked, otherwise its last commit time. The page's time is the later of its own time and a `<meta name="truemap-verified">` stamp. Code newer than the page: **● changed**. Without git, this step is skipped.
4. **`check --ok <page>`** writes the stamp, so a reviewed page stops showing ● and agents don't learn to ignore it.

The checker uses no AI, no per-language code and no hooks. It runs on open, on navigation, when pages change, every 30 s while a tab is open, and on `truemap check`.

## Security (local server baseline)

- **Network:**
  - Binds to `127.0.0.1` only.
  - A `Host` header other than `127.0.0.1`, `localhost` or `[::1]` on the right port gets a 403. This blocks DNS rebinding.
  - The API and the event stream need the per-launch random token, and `Origin` is checked.
- **Page isolation:**
  - Pages are served from a **separate origin** (a second port) that serves only `.truemap/` files and the SDK. Page scripts therefore can't reach the API, even though the iframe has `allow-same-origin`. That flag is needed because some embedded browsers block opaque-origin frames.
  - Paths are normalised; `..`, NUL and symlinks that lead outside `.truemap/` are refused.
- **Messages between workspace and page:** the workspace accepts `postMessage` only from its own iframe *and* the content origin.
- **Chat rendering:** agent replies are rendered from escaped text through a minimal Markdown subset. Links are limited to `https://` URLs and relative `.html` pages.

## Proactive use

The real test is whether the agent reaches for truemap without being asked:

1. **The skill description** says *when* to use it: explaining architecture or a flow, comparing options, a "how does X work" question, or any time `.truemap/` exists.
2. **A three-line project note.** When the CLI creates `.truemap/`, it prints a note and asks the agent to add it to `CLAUDE.md` and `AGENTS.md`. Both agents read those files every session, and the note travels with clones. It also carries the anti-annoyance rule: give a 1–3 line answer in the terminal, and open a page only for 3+ interacting parts or a decision.
3. **`next_step` in every command's output.**
4. **The `allowed-tools` field in the skill**, so `npx -y truemap-cli …` doesn't trigger a permission prompt on every `listen` and `reply`.

## How we'll know it works

- A local usage log (`~/.truemap/usage.jsonl`, outside the repo) records each CLI call.
- We will trial it for two weeks on a **different real project**, not this repo, and measure one number: **whether the agent opens and updates `.truemap/` pages without being prompted.**

## Not in v1

- Data model, IDs, relation graph
- One-click initialisation (pages appear on demand)
- Hooks, MCP server, background agent processes
- Team features
- Moving permission prompts into the browser

## The map is the interface (v0.4)

Why: developers mostly no longer read agent-written code line by line, and comprehension drops when they don't (Stack Overflow 2025, Anthropic's Jan 2026 study). What they need first is the logic (paths through the system and the intent behind them), then a way to check it against real code, because summaries can be wrong. So:

- **Click any box: the peek.** The workspace (not the page) shows a panel with the box's description, `data-why`, the real lines around `#name` (`/api/snippet`, git-tracked files only), and its wires in and out. The snippet never enters the page frame.
- **Behaviours as the way in.** `.tm-flows` buttons light up a path (`data-tm-flow="id id id"`); hovering a box brings its own wires forward. Wires are faint by default; only the main path is strong.
- **Two-way pointing.** `show`, `reply --focus` and `[text](#id)` links in replies light up boxes and pin a note beside them, live.
- **Ask rarely.** `ask` puts a choice card in the conversation and waits. The guide limits it to decisions that are hard to undo; otherwise the agent decides and states its assumption.
- **Navigation.** The map is the table of contents. The top bar keeps the blueprint one click away (`Blueprint › Page`), with back/forward (Alt+←/→).

## Plans, changes, many projects (v0.5)

Review is the bottleneck of working with agents, and it happens at two moments: before a larger change (the plan) and after it (the change). Both are overlays on the same map, so the user reviews in the picture they already know.

- **Plans are data,** not pages: `.truemap/plans/<slug>.json` names the boxes a change touches, adds (with group and connections) and removes, plus its steps. The SDK marks touched boxes and inserts the new ones, dashed, into their group, then lays the map out again. The plan bar offers Approve / Request changes; the comments go to the agent as usual. `listen` returns `kind: approval` or `kind: plan_changes`. The user can also say "go" in the terminal (`plan --approve`).
- **Changes are measured from snapshots,** taken as git tree objects through a copy of the index (`GIT_INDEX_FILE`), so the user's staging area is never touched: when the agent picks up a message (its turn begins), when a plan is approved, or against HEAD / the main branch. Files under `.truemap/` are left out.
- **Attribution is by file and says so.** A box owns the files its `data-src` path covers (a folder covers everything under it). A file shared by two boxes shows on both, marked as shared. Files no box covers are grouped by folder, with "Ask the agent to map these".
- **Many projects.** Each repo keeps its own server; the workspace reads the other servers' state files and asks each for its status (agent state, plan in review, a reply nobody has seen). The projects menu lists them; the tab title carries "(n)" when other projects need the user.
- **The look is fixed.** One typeface (Instrument Sans) and one mono (Commit Mono), neutrals and ink, a highlighter for "the agent points here", status colours for status only. The checker lints maps (size, groups, names, anchors, flows, no custom colours) so agents learn the rules from `check`.
