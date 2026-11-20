---
name: truemap
description: "A map of this repository's code (.truemap/index.html), shown in the user's browser and checked against the code: you explain on it, plan on it and show your changes on it, and the user talks to you next to it. For this repository's code, use it rather than a general HTML or visual tool. Use it whenever the user asks how code in this repository works or wants it explained, however it is phrased and in any language (\"explain this\", \"how does X work\", \"what does this do\", \"walk me through\", \"I don't get X\"), even a single function or file. Also use it before a change that touches 3+ boxes on the map or adds one (draw the plan, wait for approval), after a change across several files (show what changed, box by box), and when asked to show the project. Asking how code works counts as a request to explain; asking where something is, or what a value is set to, does not. Skip it for pages that are not about this repository's code."
allowed-tools: Bash(npx -y truemap-cli:*), Bash(npx truemap-cli:*), Bash(truemap:*)
license: MIT
---

# truemap

`.truemap/index.html` is the map of this codebase: small boxes in groups, each pinned to real code and checked against it. Explanations, plans and changes all land on that map. Everything lives in `.truemap/` at the repo root and stays with the project.

Current instructions live in the CLI – this file stays short so it never goes stale:

- `npx -y truemap-cli --help` – commands and the chat loop
- `npx -y truemap-cli outline` – a fast repo outline for the first map
- `npx -y truemap-cli guide` – how to write maps, plans and anchors

Flow:
- If `.truemap/index.html` exists, read it before working on code you don't know yet: it is a checked summary of the system, and the boxes whose `data-src` covers the files you will edit are the boxes your change touches. Boxes marked changed or broken may be out of date; check them against the code and fix the map.
- Explaining something, big or small about this code (how X works, "explain this function", "I don't get this"): `npx -y truemap-cli draft "<name>"`, show it in the form that makes it obvious (a traced example, a drawing, a timeline, a side-by-side, something to try; not necessarily a diagram, never a wall of text), open it with `npx -y truemap-cli drafts/<file>`; keep the chat answer to a line or two. No map is needed first, and don't build one unless asked.
- The project map: `.truemap/index.html`; update it when the structure changes, run `npx -y truemap-cli <page>`, then follow the `next_step` it prints.
- Before a change that touches 3+ boxes on the map or adds one: `npx -y truemap-cli plan --file plan.json`, wait for the approval.
- After a change across several files: `npx -y truemap-cli changes`.

Always also give the user a 1–3 line answer in the terminal.

## Request

$ARGUMENTS
