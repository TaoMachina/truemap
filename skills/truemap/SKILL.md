---
name: truemap
description: Explain code on a page that opens in the user's browser instead of answering only in the terminal. Use this whenever the user asks you to explain or make clear any code, however it is phrased and in any language ("explain this", "can you just explain this", "how does X work", "what does this do", "walk me through", "break it down", "I don't get X"), even a single function or file; no project map is needed. Also use it before a change that touches 3+ parts (show the plan, wait for approval), after editing code (show what changed), and when asked to show the project. A question about what code does or how it works is a request to explain, not a short factual question. Skip it only for lookups (which file, which flag, yes or no).
allowed-tools: Bash(npx -y truemap-cli:*), Bash(npx truemap-cli:*), Bash(truemap:*)
license: MIT
---

# truemap

Pages live in `.truemap/` at the repo root (`index.html` is the project map). They stay with the project and are checked against the code.

Current instructions live in the CLI – this file stays short so it never goes stale:

- `npx -y truemap-cli --help` – commands and the chat loop
- `npx -y truemap-cli outline` – a fast repo outline for the first map
- `npx -y truemap-cli guide` – how to write maps, plans and anchors

Flow:
- Explaining something, big or small (how X works, "explain this function", "I don't get this", an idea): `npx -y truemap-cli draft "<name>"`, show it in the form that makes it obvious (a traced example, a drawing, a timeline, a side-by-side, something to try; not necessarily a diagram, never a wall of text), open it with `npx -y truemap-cli drafts/<file>`; keep the chat answer to a line or two. No map is needed first, and don't build one unless asked.
- The project map: `.truemap/index.html`; update it when the structure changes, run `npx -y truemap-cli <page>`, then follow the `next_step` it prints.
- Before a larger change: `npx -y truemap-cli plan --file plan.json`, wait for the approval.
- After editing code: `npx -y truemap-cli changes`.

Always also give the user a 1–3 line answer in the terminal.

## Request

$ARGUMENTS
