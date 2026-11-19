---
name: truemap
description: Review what you plan and what you changed on a living map of the codebase that stays true to the code. Use before a change that touches 3+ parts or adds one (show the plan, wait for approval), after editing code (show what changed, by box), when explaining architecture, a module or a flow, when asked "how does X work" or "show me the project", and whenever a .truemap/ folder exists and you are about to explain something it may already cover. Not for one-line answers.
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
- Explaining: look in `.truemap/` first, update or write the page, run `npx -y truemap-cli <page>`, then follow the `next_step` it prints.
- Before a larger change: `npx -y truemap-cli plan --file plan.json`, wait for the approval.
- After editing code: `npx -y truemap-cli changes`.

Always also give the user a 1–3 line answer in the terminal.

## Request

$ARGUMENTS
