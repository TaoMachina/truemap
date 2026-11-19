# Architecture (v0.1, solo)

> 2026-11-19, v0.2. This describes what is implemented. Earlier, heavier designs are kept in [archive/](archive/).

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
| `npx -y truemap-cli [page] [--annotate]` | Opens the workspace in the user's default browser, or switches the tab that is already open. Defaults to `index.html`. `--annotate` turns on comment mode. Prints the check result for the page and a `next_step` |
| `npx -y truemap-cli outline` | A compact repo outline (folders, sizes, manifests, likely entry points) so the first blueprint is fast |
| `npx -y truemap-cli listen [--timeout s]` | Long-polls for the user's next chat message. Returns `message`, `browser_closed`, `replaced` or `timeout` |
| `npx -y truemap-cli reply "<text>" [--listen] [--file path\|-]` | Shows the answer in the chat. With `--listen` it keeps listening in the same call |
| `npx -y truemap-cli check [page…]` / `check --ok <page>` | Checks anchors / marks a page as reviewed |
| `npx -y truemap-cli guide` | The page-writing guide: folder rules, anchors, kit components, decision forms |
| `npx -y truemap-cli progress "<text>"` | Shows a short status line in the chat while the agent works |
| `npx -y truemap-cli stop` | Stops the background server |

- **Zero install:** `npx -y` runs it directly.
- **No login:** the chat panel talks to the user's current Claude Code or Codex session. truemap never starts an agent and never touches credentials.
- **The output tells the agent the next step**, in the AXI style. Agents learn the tool by using it.

## Components

```
browser workspace (http://127.0.0.1:<port>/?t=<token>)
 ├─ top bar: mark + page switcher (Ctrl/Cmd+K) + check status + Annotate switch + one panel toggle
 ├─ center: the page in a sandboxed iframe from a SEPARATE origin (http://127.0.0.1:<contentPort>)
 │    the injected SDK draws map wires (data-to), shows check marks, and in annotate mode turns
 │    clicks and text selections into numbered comments
 └─ conversation panel (collapsible): agent state, history, queued comments, composer, state notices
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
| `src/ui/workspace.*` | Workspace UI: zero dependencies, no build step |
| `src/ui/sdk.js` | Injected into served pages only (never written to files). Draws map wires, runs annotate mode and the comment card, decision forms and check marks |
| `kit/truemap.css`, `kit/fonts/` | The page kit and IBM Plex fonts, served to every page as `assets/truemap.css`, so repos always get the current kit. A repo that keeps its own `assets/truemap.css` (older setups) keeps it |
| `src/guide.md` | Printed by `truemap guide` |
| `skills/truemap/SKILL.md` | A short skill stub that sends the agent to the CLI |

Zero runtime dependencies, Node ≥ 20.

## Chat rules (listen / reply)

- **Messages queue.** Messages sent while the agent is busy are kept. The next `listen` returns all of them at once, in order, each with its page and its numbered comments (element or text, `data-src`, comment text).
- **Comments.** With Annotate on, a click on a box or a text selection opens a comment card on the page. Enter adds the comment (a numbered pin on the page, a row in the panel); Send delivers all of them in one message. Ctrl+Enter sends at once. Outside annotate mode, links work normally and a text selection offers a small Comment button. The agent can switch annotate on with `--annotate` or `<meta name="truemap-annotate" content="on">`.
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
