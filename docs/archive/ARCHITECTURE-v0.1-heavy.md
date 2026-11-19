> Archived document (translated from the original Chinese).

# Architecture Design v0.1 (single-user edition)

> Status: draft · 2026-11-19 · corresponds to [VISION.md](VISION.md) v0.2
> Decisions made: Q1 build a lightweight core ourselves, with the file format as compatible with Nimbalyst as possible; Q2 build our own browser viewer, with interaction modeled on lavish and reusing what we can; Q3 the first version supports both Claude Code and Codex; Q4 the checker is not tied to any programming language (see section 5).
> The first version does not do team collaboration.
> The product name is not set yet; below it is temporarily called **Atlas**, with the directory `.atlas/`.

## 1. Design principles (in priority order)

1. **Lowest friction.** Start with one command, no account, no extra API key. Anything clickable shouldn't make people type; whatever is selected automatically becomes context; all changes show in real time, with no manual refresh.
2. **The dialog box on the right is the core**, and must be a truly real-time multi-turn conversation: answers stream out, and you can ask follow-ups or interrupt at any time.
3. **Leave the smart things to the agent and the deterministic things to the program.** Understanding code, drawing views and fixing staleness are all done by the agent; the checker only does simple, deterministic, language-independent comparisons.
4. **All artifacts are ordinary files in the repo.** They open without Atlas, and git can roll them back.
5. **Not tied to any agent.** Dealing with agents goes through a single adapter layer; adding an agent means adding an adapter.

## 2. Overall structure

```
┌────────────────────────── Browser (workspace) ──────────────────────────┐
│  Left: view list     Middle: view (sandboxed iframe)   Right: dialog (agent)│
│  Architecture / Plan / Decisions   Select, circle, annotate, decision cards   Streaming answers, context chips│
│  Stale indicator lights   Live refresh   Approval buttons, interrupt  │
└───────────────┬───────────────────────────────────────────────┬────────┘
                │ WebSocket (bidirectional, real-time)           │
┌───────────────▼────────────── Local server (Node, started with npx) ─▼────────┐
│  Message queue (browser → agent)   File watcher (.atlas/ and source)             │
│  Checker (check)                   Inbox                                         │
└───────▲───────┬──────────────────────────────────────────────────────────┘
        │ atlas listen / atlas reply (ordinary command-line commands)
┌───────┴───────┴─── The agent session you're using (Claude Code or Codex) ────────┐
│  Learned through a skill: first listen for messages → answer, change code, change views → reply → listen again │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ reads and writes ordinary files
┌───────────────▼──────────── Your git repo ───────────────────────────────┐
│  .atlas/model/…    Entities (modules, decisions, tasks...) + anchors      │
│  .atlas/views/…    HTML views written by the agent (elements attach to entities via data-entity)  │
│  .atlas/inbox.jsonl  Annotations and choices you leave for the agent (used when asynchronous)    │
│  .atlas/.local/      Local machine state such as session IDs (not in git)                       │
│  src/…             Your code                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

## 3. Interaction flow (single user)

### 3.1 First use

1. Install the skill, only once: `npx skills add <repo> --skill atlas` (same as lavish).
2. In Claude Code or Codex, type `/atlas`, or just say "open atlas." No login needed; it uses the very agent you are talking to.
3. The default browser opens the workspace automatically. When the project has no views yet, the dialog on the right asks you directly: "I haven't drawn this project yet. Want me to read the code first and draw three diagrams: architecture, plan and decisions?" Below it is one button, **[Start]**.
4. Click once and the agent starts working. The dialog shows in real time what it is doing ("reading src/pay/…"), and the views appear one by one in the middle, with no refresh needed.

### 3.2 Day to day: look, ask, change

| What you do | What happens on screen |
|---|---|
| **Click a module** in a view | The module is highlighted, a context chip "📌 Payments module" appears above the input box on the right, with four quick buttons below: **Explain it / What is it connected to / Why designed this way / Change it** |
| **Select a piece of text**, or **box-select an area** | Also becomes a context chip; several can be attached at once |
| Click a quick button, or type and send yourself | The answer streams in; modules mentioned in the answer are clickable tags, and clicking one highlights the corresponding spot in the view |
| **Follow up** | Just keep typing. Same session, and the agent remembers what was said before |
| The agent **needs you to decide** | A decision card (options, trade-offs, recommendation) appears in the dialog. Click once and the agent carries on immediately. Project-level decisions are automatically recorded in the decisions view |
| The agent **wants to change files or run commands** | Approval still appears in CC's own interface (see 4.0). When using Atlas, we suggest setting CC to "auto-accept file edits" to reduce switching back and forth |
| The agent **changed code** | Views update in real time; after this turn the checker runs automatically, and a summary card appears in the dialog: "Changed 3 files · architecture diagram updated · checker ✓" |
| Want to **stop it** | Click **[Stop]**, interrupt at any time |

### 3.3 Leaving and coming back

- Closing the browser loses nothing: views and the model are in the repo, and the conversation can pick up where it left off.
- On the next open, if the code was changed in the meantime (say you had the agent change it in the terminal), the right side first says: "2 items are stale since last time. Update? [Update]"

### 3.4 Coexisting with the terminal

It doesn't force you to leave the terminal:

- The skill teaches the agent in the terminal to read the inbox before starting work and to update the views when done.
- The browser still shows the views in real time, and annotations you leave on a view go into the inbox, waiting for the terminal agent to pick them up (this is lavish's approach).
- Whether the conversation in the dialog and the one in the terminal can continue each other depends on the agent's support; see section 4.

### 3.5 Checklist of rules for reducing friction

1. One command to start, zero configuration, zero accounts.
2. Don't make people type what they can click: quick buttons, decision cards, approval buttons.
3. Selection is context: no copying and pasting file names, and no describing "that box on the left."
4. Everything real time: answers stream in, and views and stale indicator lights update automatically.
5. No fear of loss or mistakes: the inbox persists; all changes are in git and can be rolled back.
6. Interrupt only when something is up: the checker stays quiet when it finds no problems.

## 4. Agent connection layer (how the real-time conversation works)

> Verification date: 2026-11-19. Local versions: Claude Code 2.1.312, codex-cli 0.170.0. I personally read the original text of Anthropic's policy.

### 4.0 Default approach: skill mode (no login needed)

**The dialog on the right connects to the very agent you are using**, that is, the session you already have open in Claude Code (or Codex). Atlas doesn't launch an agent of its own, so there is no login problem and it never touches any credentials. This is exactly lavish's approach.

```
You type /atlas in CC
   │  The skill runs `npx atlas open`
   ▼
The default browser opens the workspace
   │
   ▼
CC enters a "listening" state: runs `atlas listen` (long polling), waiting for messages from the browser
   │
You select a module in the browser and ask ──► local server ──► listen returns (with context) ──► CC receives it
                                                                          │
CC thinks, reads code, changes views if needed                            │
   │  `atlas reply "answer"` ──► the answer appears in the browser's right-hand dialog  │
   └──► `atlas listen` again, waiting for your next message ◄──────────────────────────────┘
```

- **Multi-turn conversation**: you ask one thing, it answers one thing, then listens again, and this can go back and forth indefinitely. CC remembers the whole conversation, because it is the same session to begin with.
- **Visible progress**: each time CC reads or edits a file, Claude Code hooks push "reading src/pay/…" to the dialog, so you never face an interface just sitting idle. Codex currently doesn't run plugin hooks, so there you only see the answers themselves.
- **Compared with true streaming**: answers appear in chunks, not character by character. The agent can first reply "let me take a look" and then give the full answer.
- **Approval**: when CC wants to change files or run commands, approval still appears in CC's own interface, because that is CC's own permission system. To avoid switching back and forth, we suggest setting CC to "auto-accept file edits" while using Atlas. Whether approval can also be moved into the browser still needs checking against Claude Code's hook capabilities (to do).
- **Codex is the same**: Codex supports skills, and `atlas listen` and `atlas reply` are just ordinary command-line commands, so both work.

### 4.1 Optional later: background mode (the browser launches the agent itself)

The limits of skill mode are that you must first type `/atlas` in CC, and the conversation isn't streamed character by character. Later we can add a **background mode**: the browser launches an agent in the background itself, with an experience more like a standalone app. What follows is the research done for background mode, which **the first version does not build**.

#### Two native adapters, unified into one set of events

| agent | How to connect | Real-time streaming | Multi-turn | Approval | Login |
|---|---|---|---|---|---|
| **Claude Code** | Launch the **user's own, unmodified `claude` program**: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`, conversing continuously over stdin/stdout | ✅ character-by-character output | ✅ messages sent continuously to the same process | `--permission-prompt-tool` points to an Atlas MCP approval tool, which shows buttons in the browser | Reuses the user's own login; we **never touch credentials** |
| **Codex** | `codex app-server` (JSON-RPC over stdin/stdout), which is also the interface Codex's official VS Code extension uses | ✅ `item/agentMessage/delta` | ✅ `turn/start`; `turn/steer` can also add input in the middle of a turn | Approval requests for command execution and file changes are mapped to browser buttons | Reuses the user's own ChatGPT login |

- **Why not use ACP to connect both**: ACP's Claude adapter is built on the Agent SDK, which in policy terms sits in the same gray area as the SDK (see 4.2); the native interfaces get the full capabilities first (approval, mid-turn input, resumption). ACP could later be added as a third adapter, for example to connect other agents.
- **Why Claude doesn't use the Agent SDK**: the SDK bundles its own copy of the Claude Code program, which may differ from the version installed on the user's machine; and the official docs explicitly say "developers building products with the Agent SDK should use an API key." Launching the user's own installed `claude` program is the clearest in terms of how it is characterized.

#### Claude's login policy (relevant only to background mode; skill mode is unaffected)

Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page (original text):

- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication…"
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens"
- Also: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription"
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

**Our situation**: Atlas runs on the user's own computer and launches the user's own unmodified `claude`, using the user's own account. We provide no login, and we don't read, store or forward any credentials, nor pay on the user's behalf. This fits the "end user … unmodified Claude Code binary" clause above. But the line "developers should use an API key" is a gray area, and Anthropic can change enforcement without notice (around January 2026 it blocked third-party clients that impersonated subscription logins; this comes from second-hand reports).

**So**: the first version only builds skill mode (4.0), which avoids the problem entirely. If background mode is built later, it will launch the user's own `claude` and offer a "use my own API key" option, with a one-sentence explanation of the policy on first use.

Also: the product's name and logo must not contain "Claude Code" or "Anthropic".

#### The Codex situation (background mode)

- The official docs describe app-server as "the interface Codex uses to power rich clients (for example, the Codex VS Code extension)", which reuses the user's ChatGPT login, and I found no statement prohibiting it. OpenAI also has an official route specifically for open-source tools to use the user's plan.
- Risk: app-server is still labeled "experimental," and the interface changes often. It has to be isolated inside an adapter, with compatibility tests tracking versions.

#### Interoperating with the terminal (background mode)

- A session in the dialog can "continue in the terminal": `claude --resume <id>` for Claude, `codex resume <id>` for Codex.
- **Both sides must not write to the same session at once**: the official docs warn that messages would be lost. So at handoff, stop one side first, or use `--fork-session` to fork a new session.

#### Adapter interface (background mode draft)

```ts
interface AgentAdapter {
  detect(): Promise<{ installed: boolean; loggedIn: boolean; version?: string }>
  startSession(opts: { cwd: string; resumeId?: string; instructions: string }): AgentSession
}

interface AgentSession {
  id: string                                         // can be resumed
  send(msg: { text: string; context: ContextChip[] }): void
  events: AsyncIterable<AgentEvent>                  // see below
  answerApproval(requestId: string, allow: boolean, always?: boolean): void
  interrupt(): void
  close(): void
}

type AgentEvent =
  | { type: 'text_delta'; text: string }             // streamed text
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'approval_request'; requestId: string; action: string; detail: string }
  | { type: 'ask_user'; requestId: string; question: Decision }   // decision card
  | { type: 'turn_end'; usage?: unknown }
  | { type: 'error'; message: string }
```

**How the agent "does things" in the interface**: in skill mode, the following are all subcommands of the `atlas` command line (such as `atlas ask` and `atlas show`), which the agent runs directly, needing no extra configuration, just like lavish. If needed for background mode later, they will be wrapped as MCP tools.

- `atlas_ask(question, options, recommend)`: pops up a decision card in the dialog and returns the result after the user clicks.
- `atlas_show(view, entity)`: switches the middle view to a given diagram and highlights an entity.
- `atlas_check()`: runs the checker and returns the stale list.
- `atlas_approve(action)`: for Claude's `--permission-prompt-tool`; turns an approval request into a browser button and returns after the user clicks.
- `atlas_inbox()`: in attach mode, the agent in the terminal uses it to read questions and annotations from the browser and write answers back to the dialog.

**How context is injected**: when a message is sent, the server expands the context chips into a structured prefix: which view was selected, which entity, what anchors that entity has, and the text snippet of the selected element. From this the agent knows what you are pointing at and which code it corresponds to.

## 5. The checker: not tied to any language

Your judgment was right: if the checker is written per language, we tie our own hands. The first principle is this: **understanding code is the agent's job, and the agent already understands any language; the checker only needs to be a simple "tripwire."**

### 5.1 There are only three kinds of anchors, all language-independent

| Anchor | Notation | How it is checked |
|---|---|---|
| Path | `path: src/pay/` | Whether the file or directory still exists |
| Name | `symbol: { path: src/pay/charge.ts, name: charge }` | Whether the file still contains this whole word (plain-text search, works for any language) |
| Text | `text: { path: src/routes.ts, contains: "/api/pay" }` | Whether the file still contains this text (works for routes, config keys and environment variable names) |

### 5.2 Each entity has three states

- **✓ Normal**: the anchors are all there, and the code hasn't changed since the last verification.
- **● Changed**: the anchors are all there, but the code under the anchors changed after the last verification (compared with the git content at the last verification). This is only a hint that "it may need a look"; the agent decides whether the view needs changing, and after confirmation updates the verification record.
- **✕ Broken**: an anchor can't be found (file deleted, function renamed). The view lights up red, and the agent is responsible for repairing it.

### 5.3 Why it is enough

- It uses only git and text search, so it **works for any language and any framework**, is fast, gives stable results, and is fine to put in CI.
- It may misjudge (for example, the function was deleted but the name remains in a comment), but its job is only to remind, and the agent does the final recheck.
- Later, if more precision is needed, optional plugins can be added (such as tree-sitter), but they will never be required.

## 6. File format (draft)

```
.atlas/
├── atlas.yaml              version number, settings (default agent, approval mode)
├── model/
│   ├── payments.md         one file per entity: YAML header + Markdown body (description)
│   ├── orders.md
│   └── decisions/
│       └── retry-policy.md decisions are entities too: options, choice, who decided, when, why
├── views/
│   ├── architecture.html
│   ├── plan.html
│   └── decisions.html
├── inbox.jsonl             asynchronous annotations and choices (for the terminal agent)
└── .local/                 not in git: session IDs, verification cache
```

Example entity file:

```markdown
---
id: 01JD3K8Q7Z5X0V2N4M6P8R0T2W     # ULID, never changes
key: payments                      # referenced in views as data-entity="payments"
type: module
title: Payments module
anchors:
  - path: src/pay/
  - symbol: { path: src/pay/charge.ts, name: charge }
  - text: { path: src/routes.ts, contains: "/api/pay" }
relations:
  - { to: orders, kind: called-by }
  - { to: retry-policy, kind: decided-by }
verified: { commit: 3f2a9c1, at: 2026-11-19 }
---
Responsible for collecting payments and refunds. Integrates with Stripe; failures are retried with exponential backoff (see retry-policy).
```

- **One file per entity**: far fewer git conflicts when we do team collaboration later.
- **Compatible with Nimbalyst**: IDs are ULIDs, using Markdown with a YAML header, and types are extensible. How exactly to map to its `FORMAT.md` will be decided after going through it item by item (to do).
- **Views are ordinary HTML**: they attach to entities only through attributes such as `data-entity`, don't depend on any Atlas runtime, and open with a double-click. Interactive capabilities (selection, highlighting, decision cards) are injected by the viewer when it opens, the same approach as lavish.

## 7. Technology choices (draft)

| Part | Choice | Reason |
|---|---|---|
| CLI and local server | Node + TypeScript, distributed via npm and `npx` | Same ecosystem as lavish, and the Claude and Codex SDKs both have TS versions |
| Browser UI | A lightweight frontend framework, bundled into the npm package | Fast to start, no extra installation for the user |
| View display | Sandboxed iframe + injected SDK | Safe; the views themselves remain ordinary HTML |
| Between browser and server | WebSocket | Need bidirectional, real-time, streaming |
| File watching | A library like chokidar | Push to the browser when views and the model change |
| Checker | git commands + text search | Doesn't depend on any language |
| License | MIT | Decided |

## 8. First-version milestones (draft)

1. **M1 Skeleton**: `npx atlas` starts, three-column browser layout, can open the HTML in `.atlas/views/`, and refreshes automatically when files change.
2. **M2 Dialog**: skill mode. `atlas listen` and `atlas reply` implement the multi-turn back-and-forth; Claude Code hooks push progress. Claude Code and Codex supported together.
3. **M3 Selection is context**: click selection, text selection and box selection become context chips, plus quick buttons.
4. **M4 Model and checker**: entity file format, the three kinds of anchors, `atlas check`, stale indicator lights.
5. **M5 skill and initialization**: one-click "draw this project for me" generates the three views; decision cards (`atlas_ask`).
6. **M6 Eat our own dog food**: develop Atlas itself with Atlas for two straight weeks, recording "the proportion of direction given on the views."

## 9. Open questions

- The product name.
- Whether the policy risk of Claude's default mode is acceptable (see 4.2), and whether to write to Anthropic directly and ask.
- The cost of tracking versions of the Codex app-server's experimental interface.
- The item-by-item mapping to Nimbalyst's `FORMAT.md`.
- Which frontend framework to use for the browser UI.
