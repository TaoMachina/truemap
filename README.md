# truemap

**Agents explain your project with living HTML pages that stay true to the code.**
Click anything on a page to ask about it. Click an option to decide. The pages live in your repo and get checked against the code, so they never quietly lie.


---

## Why

Coding agents write code faster than anyone can read it. Their answers come back as walls of text, and the diagrams they draw are thrown away after one chat. truemap gives the agent a better way to talk to you:

- **Pages, not paragraphs.** The agent draws the architecture, a flow, or the options as an HTML page and opens it in your browser.
- **Point and ask.** Click a box on the page, ask in the chat panel next to it. The agent receives your question *and* the code that box points to. It is the same agent session you are already using, so there is no new login or extra app.
- **Click to decide.** When the agent needs your call, the page shows options. One click and the answer goes back to the agent.
- **Pages that stay true.** Every box carries a `data-src="path#name"` anchor. When the code moves on, truemap marks the box amber (changed) or red (gone), and the agent fixes the page.
- **It all stays in the repo.** Pages live in `.truemap/`, with `index.html` as the project blueprint. They are plain files you can commit, diff, and open anywhere.

## Install

Install the skill once. That is all the setup there is.

```sh
npx skills add TaoMachina/truemap --skill truemap
```

Then just talk to your agent (Claude Code or Codex): *"How does payment work?"* or *"Show me the project."* The agent writes or updates a page and opens it. You can also ask for it directly: `/truemap show me the architecture`.

It also works with no skill installed. Tell the agent: *"use `npx -y truemap --help`"*.

## How it works

```
your repo/
└── .truemap/
    ├── index.html        the blueprint: every module links to its page
    ├── payments.html
    ├── retry-decision.html
    └── assets/truemap.css   shared look (edit the tokens to match your brand)
```

| Command (run by the agent) | What it does |
|---|---|
| `npx -y truemap [page]` | Opens the workspace in your browser: pages on the left, the page in the middle, chat on the right |
| `npx -y truemap listen` | Waits for your next message from the chat panel |
| `npx -y truemap reply "…" --listen` | Shows the agent's answer in the chat, then keeps listening |
| `npx -y truemap check` | Checks every `data-src` anchor against the code |
| `npx -y truemap guide` | The page-writing guide for agents: kit components, anchors, decision forms |

The checker doesn't depend on the programming language. It uses only git and a plain-text search:

- **✕ broken**: the path is gone, or `#name` no longer appears in the file (whole word, case-sensitive).
- **● changed**: the file changed after the page was last updated. The agent reviews it, then updates the page or runs `check --ok`.

Everything runs locally:

- The server listens on `127.0.0.1` only and needs a token for every request.
- Pages render in a sandboxed iframe on a separate origin, so page scripts can't reach the chat API.

## Requirements

- Node.js 20 or newer
- git (optional; without it, only missing paths and names are checked)

## License

MIT

