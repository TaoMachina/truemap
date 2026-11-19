<img src="docs/images/mark.svg" width="44" height="44" alt="">

# truemap

**A map of your codebase that your agent draws, and that stays true to the code.**

Your coding agent explains the project as HTML pages in your repo: a blueprint of the whole system, a page per module, the options when it needs your call. You read them in the browser, click any box to comment on it, and the agent answers right next to the page. Every box is pinned to real code, so when the code moves on, the map tells you.

![The truemap workspace: a project blueprint with wires, a comment pinned to a box, and the agent's answer in the conversation panel](docs/images/workspace.png)

## Why

Coding agents write code faster than anyone can read it. Their explanations come back as walls of text, and the diagrams they draw are gone after one chat.

- **Pages, not paragraphs.** The agent draws the architecture, a flow, or the options as a page and opens it for you.
- **Click any box, see the real code.** Every box opens a panel: what it does, why it is built that way, the actual lines it points to (read live from your repo), and what it calls and what calls it.
- **Follow a behaviour.** "Follow a path" buttons light up how a request travels through the system; hover a box and its own wires come forward.
- **The agent points back.** While it explains, the agent lights up the boxes it is talking about and pins a note beside them. Its answers link straight to boxes on the map.
- **Point at it.** Switch on Annotate, click a box or select a sentence, write a comment. Comments go out together, each with the code it points to. It is the agent session you already have open: no login, no extra app.
- **Decide only when it matters.** The agent asks only when it is blocked on a choice that is hard to undo; the options show up in the conversation and one click answers.
- **Pages that stay true.** Every box carries a `data-src="path#name"` anchor. When that code changes or disappears, the box is marked and the agent fixes the page.
- **It stays in the repo.** Pages live in `.truemap/`, with `index.html` as the blueprint. Plain files you commit, diff and share.

## Install

Install the skill once. That is the whole setup.

```sh
npx skills add TaoMachina/truemap --skill truemap
```

Then talk to your agent (Claude Code or Codex) as usual: *"How does payment work?"* or *"Show me the project."* The agent writes or updates a page and opens it. You can also ask directly: `/truemap draw the architecture`.

No skill installed? Tell the agent: *"use `npx -y truemap-cli --help`"*.

## How it works

```
your repo/
└── .truemap/
    ├── index.html          the blueprint: every module links to its page
    ├── payments.html
    ├── retry-decision.html
    └── assets/theme.css    optional: your brand colors and font
```

| Command (run by the agent) | What it does |
|---|---|
| `npx -y truemap-cli [page] [--annotate]` | Opens the workspace in your browser, or switches the tab you already have open |
| `npx -y truemap-cli outline` | A compact map of the repo, so the first blueprint takes minutes, not an hour |
| `npx -y truemap-cli listen` | Waits for your next message or comments from the page |
| `npx -y truemap-cli reply "…" --listen [--focus ids]` | Shows the answer in the conversation panel (lighting up boxes it is about), then keeps listening |
| `npx -y truemap-cli show [page] --focus ids --note "…"` | Points at the map while explaining: lights up boxes and pins a note |
| `npx -y truemap-cli ask "…" --option "A \| why" …` | Asks the user to choose, only when the agent is blocked on a real trade-off |
| `npx -y truemap-cli check` | Checks every `data-src` anchor against the code, and that every map wire has a target |
| `npx -y truemap-cli export <page>` | Writes the page as one self-contained HTML file to share (also in the workspace ⋮ menu) |
| `npx -y truemap-cli guide` | The page-writing guide for agents: the map, anchors, decisions, design rules |

The checker works for any language. It uses git and a plain-text search:

- **No longer matches**: the path is gone, or `#name` no longer appears in the file (whole word, case-sensitive).
- **Changed in code**: the file changed after the page was last updated. The agent reviews it, then updates the page or runs `check --ok`.

Everything runs on your machine:

- The server listens on `127.0.0.1` only and needs a per-launch token.
- Pages render in a sandboxed frame on a separate origin, so page scripts can't reach the agent.
- Nothing leaves your machine. truemap keeps a local log of which commands ran (`~/.truemap/usage.jsonl`) and the chat history per repo (`~/.truemap/history/`); delete them any time.

## Requirements

- Node.js 20 or newer
- git (optional; without it, only missing paths and names are checked)

## License

MIT. Fonts: IBM Plex Sans and IBM Plex Mono, SIL Open Font License (`kit/fonts/OFL.txt`).
