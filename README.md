<img src="docs/images/mark.svg" width="44" height="44" alt="">

# truemap

**A map of your code that your agent keeps true.**

Your coding agent keeps a map of your project in your repo: small boxes in groups, each pinned to real code and checked against it.

You talk to the agent in a panel next to that map, in your browser. It explains things on the map, draws its plan there before a bigger change, and shows you there what it changed.

![truemap on the Umami codebase: asked how a page view is recorded, the agent explains on a page whose steps link back to the map; asked for rate limits, it draws its plan on the map; after approval the new box lands where the plan drew it, with what changed, and one click opens the diff](docs/images/demo.gif)

## Install

```sh
npx skills add TaoMachina/truemap --skill truemap
```

That is the whole setup. Then ask your agent *"show me the project"*: a first map takes a few minutes. After that, work as usual. Ask how something works, or ask for a change that touches several parts, and the agent uses the map on its own.

No skill installer? Tell your agent:

> Use `npx -y truemap-cli --help` and draw a map of this project.

## What you do on the map

- **Understand.** Ask how something works. The agent answers with a page that shows it: a real input traced to its output, a timeline, options side by side. The boxes it talks about light up on the map. Click a box to light up what it connects to. Double-click it to see what it is and leave a comment; **Details** shows its real code, read live from your repo.
- **Approve the plan.** Before a change that touches several parts, the agent draws what it will add and touch, and waits. Double-click a box to comment on it, then approve or ask for changes.
- **Review the change.** After the agent edits, each changed box shows its +/− lines, and a card in the conversation lists them. Click a box there to see its diff. Changed files that no box covers are listed separately.

## Why

Agents now write code faster than anyone can read it, and people slowly stop understanding their own systems. Maps of a codebase used to die because nobody kept them current and nobody came back to them. Now the agent keeps the map true at almost no cost, and because you talk to it on the map, you have a reason to come back.

Plan reviewers and HTML editors show you one page, once. truemap keeps one picture of your whole system that every explanation, plan and change lands on, checked against the code.

→ [The vision](docs/VISION.md)

## Also

- **True, or marked.** Every box carries a `data-src="path#name"` anchor. When that code changes or disappears, the box is marked, and the agent fixes the map. The check is plain git and text search, no AI.
- **Yours, in the repo.** Maps are plain HTML files in `.truemap/`. You commit, diff and share them like code. `export` writes any page as one self-contained file.
- **Any agent.** Claude Code, Codex, OpenCode, Cursor CLI, or agents inside hosts such as T3 Code: anything that can run a shell command.
- **Many projects.** Every project with truemap running is one click away. The tab tells you when another one needs you (a plan to review, a new reply).
- **Your look.** Light, dark, or follow the system. Ask the agent for your colours or fonts ("a blue accent", "like our brand"). Every page follows, and truemap checks that everything stays readable.

## How it works

```
your repo/
└── .truemap/
    ├── index.html        the map of the whole system
    ├── payments.html     a page per module, when one is needed
    ├── drafts/           explanations the agent made, numbered
    └── plans/            plans the agent proposed (JSON)
```

The panel talks to the agent session you already run. truemap starts no agent and needs no login: your agent waits for your next message with `truemap listen`, answers on the map, and listens again. In Claude Code the wait runs in the background; other agents wait in the foreground.

The map is declared, not drawn. The agent writes groups, boxes and connections in HTML, and truemap lays them out: one reading direction, few crossings, a verb on each connection. The drawing rules are fixed on purpose, so every map reads the same; the colours and fonts are yours.

Changes come from git. truemap snapshots the working tree through a throwaway copy of the index, so your staging area is never touched. Each changed file is then attributed to the boxes whose anchors cover it.

<details>
<summary>Commands (run by the agent, not by you)</summary>

| Command | What it does |
|---|---|
| `npx -y truemap-cli [page]` | Opens the workspace in your browser, or switches the tab you already have open |
| `npx -y truemap-cli outline` | A compact outline of the repo, so the first map takes minutes |
| `npx -y truemap-cli draft "<name>"` | A new numbered page that explains one thing |
| `npx -y truemap-cli plan --file plan.json` | Draws a plan on the map for review; `--approve` / `--done` from the terminal |
| `npx -y truemap-cli changes [--base head\|main]` | What changed, by box; also posted to the conversation after each turn |
| `npx -y truemap-cli listen` | Waits for your next message, comments or approval |
| `npx -y truemap-cli reply "…" --listen` | Shows the answer in the panel, then keeps listening |
| `npx -y truemap-cli show [page] --focus ids --note "…"` | Points at the map while explaining |
| `npx -y truemap-cli check` | Checks every anchor against the code, and that each map follows the drawing rules |
| `npx -y truemap-cli export <page>` | Writes a page as one self-contained HTML file to share |
| `npx -y truemap-cli theme` | Checks that your colours stay readable in light and dark |
| `npx -y truemap-cli guide` | The guide for agents: maps, anchors, drafts, plans, changes |

</details>

## Everything stays on your machine

- The server listens on `127.0.0.1` only and needs a random token, kept in a private file.
- Pages render in a sandboxed frame on a separate origin, so page scripts can't call the agent's API.
- Nothing leaves your machine. truemap keeps a local log of which commands ran (`~/.truemap/usage.jsonl`), plus the chat history and change snapshots for each repo (`~/.truemap/`). Delete them any time.

## Requirements

- Node.js 20 or newer
- git (for change review; without it, only missing paths and names are checked)

## License

MIT. Fonts: Instrument Sans and Commit Mono, SIL Open Font License (`kit/fonts/`).
