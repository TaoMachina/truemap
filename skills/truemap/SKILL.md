---
name: truemap
description: Explain a codebase with living HTML pages the user can click, ask about, and decide on. Use when explaining architecture, a module, a flow, or a data model; when comparing options or needing the user to decide; when asked "how does X work" or "show me the project"; and whenever a .truemap/ folder exists and you are about to explain something it may already cover. Not for one-line answers.
allowed-tools: Bash(npx -y truemap:*), Bash(npx truemap:*), Bash(truemap:*)
license: MIT
---

# truemap

Pages live in `.truemap/` at the repo root (`index.html` is the project blueprint). They stay with the project and are checked against the code.

Current instructions live in the CLI – this file stays short so it never goes stale:

- `npx -y truemap --help` – commands and the chat loop
- `npx -y truemap guide` – how to write pages: folder rules, `data-src` anchors, page kit, decision forms

Flow: look in `.truemap/` first → update or write the page → `npx -y truemap <page>` → follow the `next_step` it prints.
Always also give the user a 1–3 line answer in the terminal.

## Request

$ARGUMENTS
