# Project Vision v0.2: A Visual Control Layer Shared by Humans and Agents (truemap)

> Status: draft v0.2 · 2026-11-19 · MIT open source
> The previous version ("session change review") and its red-team and neutral review records are in [archive/VISION-v0.1-session-diff.md](archive/VISION-v0.1-session-diff.md).
> Competitor data comes from a sub-agent's fact-finding on 2026-11-19; items marked "unverified" are second-hand.
>
> ⚠️ **Implementation follows [ARCHITECTURE.md](ARCHITECTURE.md) (the minimal version).** The designs for data files, entity IDs, inbox, hooks and so on in sections 3, 4 and 6 of this document have been cut: the first version is just "plain HTML in a `.truemap/` folder" plus "one command-line tool".

## 1. In one sentence

**A project has a set of "living" HTML views that sit in the git repo, and humans and agents both read and write them: humans use them to see progress, make choices and leave comments; agents treat them as task specs to write code from, then update the views to match reality when done; a checker makes sure the views and the code agree; the whole team shares the same set of views through git.**

Kid-friendly version: you and a robot builder share a **self-updating construction whiteboard**. The whiteboard shows the city map, the houses being built and every decision. You circle a spot and write "a garden here", and the robot goes and builds it; when it's done, it redraws the whiteboard. A little inspector compares the whiteboard with the real city every day, and any place drawn wrong lights up red. Your friends look at the same whiteboard too.

## 2. First principles

### 2.1 The bottleneck has moved

The speed at which agents write code is no longer the bottleneck. The real bottleneck is the **communication bandwidth between humans and agents**:

- **Human to agent (intent)**: today it is almost entirely typing in a terminal. But intents like "move this module over there", "pick the second of these three options", "skip this step for now" are much faster and more precise to express by pointing and clicking than by writing a paragraph.
- **Agent to human (status)**: today it is a long text summary. But architecture, flows, progress and trade-offs are structured information to begin with, and looking at them as diagrams with interaction is an order of magnitude faster than reading text.

### 2.2 Why HTML

HTML meets five conditions at once, and no other format meets them all:

1. Agents write it most fluently
2. It can express almost any visual and interaction
3. Every element can be precisely located (DOM and `data-*` attributes), so a human's annotation can point exactly at something
4. It is just a plain file: it goes into git, can be diffed, can be shared, and doesn't depend on any vendor
5. Any browser can open it, with no install

Markdown solves "expressing content"; HTML solves "expressing content, plus interaction". lavish's README says the same thing: "HTML is the new markdown".

### 2.2.1 HTML turns "answering the agent" into a click

Every day an agent asks you many questions: which option? Should this step be done? Do you accept this change? Today those questions are buried in long text, and you have to read it all and then type an answer. HTML can turn them into **decision cards**:

```
┌─ Decision: how to retry after a payment failure? ─┐
│  ○ A. Retry 3 times immediately   Simple; may be blocked by risk control │
│  ● B. Exponential backoff retry   Recommended; about 40 more lines of code │
│  ○ C. No retry, notify the user   Safest; poor experience │
│  [ Add a note…… ]                          [ Confirm ]   │
└────────────────────────────────────────────────────┘
```

- **Faster**: one click replaces reading a paragraph and writing a paragraph.
- **Easier to understand**: options, trade-offs and the recommendation sit together, so you can compare at a glance.
- **Less tiring**: cards, color and whitespace are far easier than a screen full of text; when you answer dozens of questions a day, the difference is obvious.
- **Answers are structured**: a click becomes data like `{decision: payment retry, choice: B, note: …}` written into the inbox, so the agent reads a definite answer and doesn't have to guess what your paragraph meant.
- **Decisions are kept automatically**: you pick B, and the record goes into the decisions view, bound to the payment module. Half a year later, when someone asks "why do we retry like this", the answer is right there.

The same logic applies to task status (drag to "done"), option comparison (choose one of two diagrams) and review (circle a node and write a comment). **The principle: whatever can be clicked, don't make people type.**

### 2.3 Why now: the "reusable rocket" moment

Docs, architecture diagrams and specs have always died, for two reasons:

- **Maintaining them takes human time**, so nobody does, and they quickly go stale.
- **People rarely come back to look**, because it is only reference material, not a place where work happens. CodeSee shutting down is a result of these two things.

Both have now changed:

- **Maintenance cost has dropped to nearly zero**: an agent can update the views automatically at the end of every session. This is like reusable rockets changing the cost structure of launches. "Keeping an accurate visual model of the project" becomes almost free for the first time.
- **Revisit frequency can be obtained by design**: if the views are **where you direct the agent**, and not just reference material, people come back every day, because that is where they work.

This is the core judgment of the project: **a visual model of the project was never feasible before, not because it was useless, but because maintenance was too expensive. Now that maintenance is cheap, it becomes possible.**

### 2.4 Others working on it doesn't mean the road is blocked

That others are already building this just shows the need is real. Cursor, GitHub, VS Code and Anthropic have all pushed in this direction over the past seven months (see section 7). The key is to see what they **structurally cannot do**:

- They all keep shared state in **their own cloud**, such as Cursor Projects, GitHub Next's Chopin and Claude artifacts. This is dictated by their business models, so they are unlikely to build an open, git-native version that isn't tied to one agent.
- Historically, open formats have often won in situations like this: Markdown, git, Mermaid, the Excalidraw file format, MCP.

## 3. The three bets we make

1. **git-native, open formats.** Views and the model are plain files in the repo. No account and no server needed; team collaboration relies on git and PRs.
2. **Anchors bind views to code, and checking is deterministic.** This is the technical hard part nobody has solved yet (see 7.2). Our approach is to **separate data from presentation**:
   - Facts live in a small structured model (JSON or YAML). Every entity (module, flow, decision, task) has a stable ID and anchors pointing at code (file, symbol, route).
   - HTML views are written by the agent, and elements in them bind to entities through attributes like `data-entity="payments"`.
   - "Do they agree" is checked deterministically: is the anchor still there? Has the code under the anchor changed since the last reconciliation? The check needs no LLM, gives stable results and is cheap. The LLM is used only for repairs.
   - git merges happen on the structured model, because it is plain text and can be merged line by line; HTML views can be regenerated, so "HTML merges badly in git" is no longer a problem.
3. **Not tied to any agent.** Claude Code, Codex, Cursor and other agents all read and write through the same files and one skill. Human actions become structured events that any agent can read.

## 4. What it consists of

```
repo/
└── .truemap/
    ├── model.yaml             entities + relations + code anchors + status (the single source of truth)
    ├── views/
    │   ├── architecture.html  system architecture (can drill down)
    │   ├── plan.html          current plan and tasks (humans can change status and pick options)
    │   ├── decisions.html     decision records (why we did it this way)
    │   └── ...                views the agent adds as needed (flows, design review...)
    └── inbox/                 human action events (comments, choices, status changes), waiting for the agent to read
```

| Part | What it does |
|---|---|
| **viewer** (local) | Browses all the views as one workspace; clicking an entity jumps between views; you can comment, pick options and change status, and these actions are written to `inbox/`. Interaction is modeled on lavish |
| **skill** | Teaches the agent: read the model and inbox before starting a task; update the model and views when done; follow the anchor rules |
| **check** (CLI) | Deterministically checks for drift: which entities have broken anchors and which views are stale. Can run in local hooks and CI, with results shown right on the PR |
| **hooks** | Run check automatically at the end of a session, and remind the agent or the human to fix anything stale |

The "risk delta check" work in the previous version was not wasted; it becomes part of `check`.

## 5. How to use it

**One person**:

1. Ask the agent to initialize; it reads the code and generates the model and three base views.
2. In the morning, open the viewer and check progress in the plan view; circle a module on the architecture diagram and write "split this into two services"; the three decision cards the agent left overnight are each answered with one click.
3. The agent reads the inbox, gets to work, and updates the views when done. check finds that an old dependency on the architecture diagram no longer exists, flags it automatically and fixes it.

**Team**:

- Everyone shares the `.truemap/` in the same repo. In a PR, besides the code diff, you can also see "what this PR changes in the architecture and the plan".
- CI runs check: if code changed but the views weren't updated, it warns.
- A new hire opens the viewer and gets an always-current project map and decision history.

## 6. What the first version does and doesn't do

**v0.1 (for one person only, for our own use first)**

- The model format, plus 3 views: architecture, plan, decisions
- A local viewer: browse, jump between views, comment, pick options, change status, with results written to the inbox
- skill: Claude Code first, then Codex
- `check`: file and symbol anchors for TS/JS and Python first
- **Eat our own dog food**: use this tool to develop this tool itself

**Not doing for now**

- A real-time multi-user collaboration server (teams rely on git first)
- Automatic inference of business-flow views (error-prone; let the agent write them by hand first, and they must be bound to anchors)
- Our own chat agent
- Drag-and-drop editing of the architecture (express intent through "comment plus choice" first)
- Cloud and accounts

## 7. Competitors (verified 2026-11-19)

### 7.1 Who gets which points

We care about four properties: **stays in the repo long term**, **two-way** (human actions become agent input), **team sharing**, and **stays automatically in sync with the code**.

| Product | Stays in repo long term | Two-way | Team sharing | Synced with code | Open source |
|---|---|---|---|---|---|
| **Nimbalyst** | Partial: docs are plain files; tasks live in its database | ✅ Humans and agents edit the same files; has decision blocks | Goes through its own server (team plan $20/person/month, free during beta; server is closed source) | Partial: file-level staleness hints, code-snippet drift checks | MIT, 2.1k stars · **closest**, see 7.3 |
| Cursor Projects (2026-11 multi-user beta) | ❌ Lives in the Cursor cloud | ✅ | ✅ Cursor teams only | ❌ | Closed source |
| Cursor Canvases | Saved in Cursor's workspace list | Partial | Read-only links | ❌ | Closed source |
| GitHub Next Chopin (2026-09 prototype) | Lives on a server, bound to a repo | ✅ Multi-user collaboration | ✅ | ❌ | MIT, 664 stars |
| Claude Code artifacts | Lives on claude.ai, not in the repo | ✅ Comments go back to the session that published it | ✅ | ❌ | Closed source |
| VS Code / Copilot canvases | Only in the current session by default | ✅ | ❌ | ❌ | From extensions |
| Plannotator | Lives locally in `~/.plannotator` | ✅ | Share links valid for 7 days; team edition on a waitlist | ❌ | Apache-2.0, 13.5k stars |
| lavish-axi | A single file | ✅ | ❌ | ❌ | MIT, 4.6k stars |
| Kiro / spec-kit / OpenSpec | ✅ Kept in git | Markdown only | ✅ | ❌ Needs manual sync | spec-kit MIT 150k stars; OpenSpec MIT 75k stars |
| Swimm | ✅ | ❌ | ✅ | ✅ CI checks code references | Closed source, text only |

**Nobody currently does all four at once**: HTML views kept in git, human actions becoming agent input, staying in sync with code through anchors, and multiple people and multiple agents reading and writing together.

### 7.2 Why nobody has done it yet (and our answer)

| Why nobody has done it | Our answer |
|---|---|
| **Technical**: free-form HTML has no anchors, so drift can't be checked; HTML is painful to merge in git | Separate data from presentation: the model carries anchors and checking is deterministic; merging happens on the model, and views can be regenerated (section 3, item 2) |
| **Behavioral**: teams don't even maintain Markdown specs (spec-kit #620, #4940 and Kiro #9435 all complain about stale specs) | Maintenance goes to the agent and hooks, not to people; the checker makes staleness visible at a glance and automatically fixable; the views are where work happens, not reference material |
| **Too new**: all of these related things appeared only in the past seven months; vendors keep state in their own clouds | This shows the window is open; an open, git-native version is exactly what vendors structurally won't build |

### 7.3 Findings from a close read of Nimbalyst (2026-11-19; a sub-agent read the source and did not run it)

**What it is**: an Electron desktop app, plus iOS and Android versions. It supports Claude (Agent SDK), Codex, Copilot, OpenCode, Cursor and several other agents. Team collaboration goes through a closed-source sync server (real-time collaboration with Yjs on Cloudflare). The core developers are two people, and it ships a stable release roughly every one to two weeks.

**What it does better than we imagined, worth learning from**:
- The ```` ```decision ```` decision block in documents: 6 question types (single choice, multiple choice, ranking, text edit, confirmation, rating), with votes and final results written directly into the file; once a decision is made in a team document, an agent is woken up.
- `local-wiki/FORMAT.md` is a formal, versioned file-format spec: permanent ULID IDs, declarable types, an append-only activity log.
- File-level staleness detection (a doc declares which `paths` it covers, and new commits to the code mark it stale); code-snippet drift checks (unchanged / moved / modified / lost).
- It can extract "what the human actually said at the time" from Claude Code session records.

**What it doesn't do, or is structurally hard for it to change**:
- HTML views are not the main thing, and view elements aren't attached to data (no binding like `data-entity`).
- Anchors go only to files and line numbers, not to functions and routes.
- No deterministic check command that can go into CI (the sub-agent didn't find one; it may have missed it).
- Team collaboration goes through its server rather than git and PRs. This is dictated by its pricing model.
- To use it, you first have to move into a new desktop app.

**Difference in positioning**: Nimbalyst is a new home you move into; we are a transparent film laid over the way you already work: no new editor, no new agent, no account, and team collaboration is just git.

**Recommendation**: build a lightweight, git-centered core ourselves, **compatible with Nimbalyst at the file-format level** (borrowing FORMAT.md's approach to IDs and types, and the decision block syntax), and possibly build a Nimbalyst extension later. This is for you to decide; see Q1 on the explainer page.

## 8. Risks and the most dangerous assumptions

| Assumption | Risk | How to validate |
|---|---|---|
| **A1 People are willing to direct agents on the views, not just by typing in the terminal** | **Highest**. This is the behavioral bet | Use it ourselves for two weeks and record how many times directing happens on the views versus in the terminal |
| A2 Agents can maintain the model and views reliably without making a mess over time | Medium | After 20 sessions, measure the drift rate with check |
| A3 Anchors can cover enough | Medium | Anchor only to files and symbols at first, and accept "what can't be anchored is marked as inferred" |
| A4 The token cost of maintaining views is acceptable | Medium | Update only the affected views each time, and record the extra cost per session |
| A5 Nimbalyst or Cursor soon fills in the missing piece | Medium | Study Nimbalyst first, and consider partnering or building a compatible format |

**Stop criterion**: after two weeks of our own use, if directing on the views is less than 20% of all directing, or we ourselves stop opening the viewer, stop and rethink.

## 9. Open source and community (short version)

- MIT license. One command installs it into an agent, and it is listed on both skills.sh and the Claude plugin marketplace; the README is bilingual (Chinese and English), with a live demo and a 20-second animated GIF.
- Contribution entry points: language anchor plugins, view templates and agent adapters, each on the scale of "one file plus one test".
- **The most valuable contribution is the format itself**: write the `.truemap/` format as a public spec that any agent or tool can read and write. Others adopting the format matters more than star count.

## 10. Open questions

- The name?
- Write our own viewer, extend lavish, or partner with Nimbalyst? (Read Nimbalyst's code first)
- YAML or JSON for the model? What is the minimal set of entity types?
- What event format should human actions on the views use when written to the inbox?
