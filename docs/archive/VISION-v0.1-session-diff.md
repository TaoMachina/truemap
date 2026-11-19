> Archived document (translated from the original Chinese).

# Project Concept: What Did the AI Change in My System (working title)

> Status: draft v0.1 · 2026-11-19 · MIT open source · side project
> All competitor data in this document was verified on 2026-11-19; items marked "unverified" are second-hand.
>
> ⚠️ **After review by a red team and a neutral reviewer, the conclusion is that the original plan in sections 1 to 7 should not be followed.** The revised direction is in **section 13** at the end. Sections 1 to 12 keep the original draft for comparison.

## 1. One sentence

**Every time a coding agent finishes a job, one diagram tells you what it changed in your system; you point at something on the diagram, and it changes it accordingly.**

Kid version: a robot spent the night building lots of things in your block city and left behind only a long note you can't read. We give you a "what changed in the city today" comparison diagram: which new room was built, which new pipe was connected, which new door to the outside was opened. You point at that door and say "close it," and the robot goes and closes it. Over time, these comparison diagrams piece together into a map of the whole city, plus a diary of "why we built it this way."

## 2. The problem to solve

People who write software with Claude Code / Codex / Cursor write code much faster than they can understand it.

- Each session touches dozens of files, and the agent gives a natural-language summary. It may miss important changes, and it may play down the risk.
- Reading the diff line by line is too slow, so in the end many people just click accept without looking.
- A few weeks later, the user no longer recognizes their own project: when something breaks they don't know where to look, and they can't direct the next change precisely.

Existing evidence:

- Stack Overflow 2025 survey: developers' biggest complaint is AI code that is "almost right, but not quite" (66%); 45% think debugging AI code takes more time.
- Anthropic research (52 developers): the group using AI scored 50 on the comprehension test and the group not using AI scored 67; those who delegated entirely to AI scored below 40.
- HN thread "How to deal with shipping AI-written code you don't understand?" (2026-10, about 630 points, 767 comments). Most of the top answers advocate "design first, then hand it to the agent"; **nobody asked for a map unprompted**.

## 3. Target users and moments of use

- **Users**: indie developers who use a coding agent every day. They can read code, but can't keep up with how much it grows.
- **Moment**: **after every agent session ends**, possibly several times a day. Not an occasional look at the whole-system map when a newcomer onboards.

## 4. What the first version does (v0.1)

1. **One-command install**, supporting Claude Code, Codex and Cursor as a skill plus hooks.
2. **Runs automatically at session end.** The scope of analysis is `git diff <commit at session start>..HEAD`, plus the session transcript for this session (if obtainable).
3. **Generates a local HTML page** called "System changes in this session":
   - **Change cards**: modules added or removed; dependency edges (A → B) added or removed; routes or endpoints added; database schema changes; environment variables added; external service calls added; changes to sensitive code such as login, permissions and payments.
   - **Local structure diagram**: draws only the changed parts and their neighbors, with the changes highlighted.
   - **Every item comes with evidence**: links to the specific file, line number and diff fragment, viewable with a click.
   - **Explains why it changed**: if a session transcript is available, extracts the reason the agent gave for that change at the time.
4. **Annotations go back to the agent**: write a comment on any card or node, the comment goes into a queue, and the agent takes it and makes the change. The interaction is modeled on lavish-axi's "annotate → poll" loop.
5. **History accumulates automatically**: each session's change manifest (JSON) is stored in a `.xxx/` directory in the repo. After many sessions, these naturally piece together into a project map and a decision log.

## 5. What the first version does not do

- A big all-in-one multi-view workspace
- Its own chat agent. We only hand context to the agent the user already uses
- Drag-and-drop architecture editing (the semantics of such operations are vague, and they are rarely used)
- Business flow diagrams (poor accuracy, and once one is drawn wrong, users stop trusting it)
- Cloud, team collaboration, accounts
- A fancy 3D graph

## 6. Design principles

1. **Facts come from parsing, not from LLM guesses.** Dependencies, routes, schemas, environment variables and external calls are all extracted with deterministic methods, such as tree-sitter and each framework's conventions. The LLM only handles naming, grouping and explanation, and every statement it makes must point to evidence that actually exists. Claims with no evidence are simply dropped.
2. **Distinguish "extracted" from "inferred."** What can be confirmed from the code is shown as a solid line; what is inferred is shown as a dashed line and labeled as inferred.
3. **Local first**: neither code nor session transcripts leave the machine.
4. **Not tied to any one agent, and no reinventing the wheel.** Read other people's data wherever possible: for structure, use the graphs from Understand-Anything or Graphify; for "why," use Entire's checkpoints, Agent Trace or git-ai records. We only build the "session-level system change review" layer.
5. **The generated artifacts are ordinary files** (JSON and HTML) that can be committed to the repo and opened without the tool.

## 7. Rough architecture

```
agent session ends (hook)
   │
   ▼
Collect: git diff base..HEAD + session transcript (optional)
   │
   ▼
Deterministic extractors (one plugin per language or framework)
   → change manifest change-manifest.json (every item carries evidence)
   │
   ▼
LLM explanation layer (naming, grouping, extracting "why") → verify evidence → discard items with no evidence
   │
   ▼
Generate a local HTML page (change cards + local structure diagram)
   │
   ▼
User annotates → comment queue → agent polls and takes them → makes changes → next round
```

Extension points external contributors can plug into: language or framework extractors, risk rules, agent adapters, views.

## 8. Competitors (verified 2026-11-19)

| Project | What it does | License / scale | Relationship to us |
|---|---|---|---|
| Understand-Anything | Code knowledge graph, drill-down, with a business-domain view, updated after each commit; `/understand-diff` shows the impact scope of a change | MIT, 93k stars | The global map and change-impact analysis already exist; no loop back to the agent |
| Graphify | Turns code into a queryable graph, distinguishing extracted edges from inferred edges | Apache-2.0, 150k stars | Same as above, mainly serves agent retrieval |
| Archify | Draws the codebase as an interactive diagram; Architecture Delta compares the base and head snapshots (verified, but the snapshots are not deterministically extracted from code) | Apache-2.0, 98k stars | Closest to our change view |
| visual-explainer | The `/diff-review` command: before/after structure diagrams, risk tables, dependency diagrams, and `<ve-ask>` lets the user tick items to fix and hand them back to the agent. **In essence it is a prompt** (original text read) | MIT, 11k stars | **Already covers most of this plan's v0.1**; only lacks deterministic evidence |
| GitNexus | Code intelligence engine | 49k stars | Map category |
| Entire (entireio/cli) | Attaches agent sessions to commits and explains why a change was made; Trails offers risk and deviation review and can apply fixes directly (depends on the entire.com cloud) | CLI is MIT, 5.3k stars; per GeekWire, raised a $60M seed round in 2026-02 | **One of the most direct threats**: session records plus a code graph |
| Plannotator | Annotates plans, HTML and diffs and hands them back to the agent; its tagline is "The workspace to stay in the loop and on top of agents" | Apache-2.0, 13.5k stars | **One of the most direct threats**: a review loop, now adding graphs to code review |
| git-ai / Agent Trace | Records which conversation each line of AI code came from | Apache-2.0, 3k stars / draft industry standard | Can serve as a data source for us |
| lavish-axi | Annotates HTML; the agent takes the comments via poll | MIT, 4.6k stars | The review loop can be modeled on it directly |
| CodeRabbit, Codex review panel, Claude Code diff comments | Review per PR or per line | Commercial products | Only down to the code-line level, not the system level |
| DeepWiki, Google Code Wiki, Windsurf Codemaps | Hosted wikis and maps | Commercial products | Map category |
| CodeSee | Code map | Shut down 2024-02 | A cautionary tale for map-type products |

**The one combination not yet fully built**: taking an agent session as the unit, showing changes at the module level, with deterministic evidence for every item, and reviewable and hand-back-able to the agent.

## 9. Core assumptions (the premises this project depends on; attacks welcome)

- **H1**: After each session, users really are willing to spend 1 to 3 minutes looking at a page of changes instead of just accepting.
- **H2**: A system-level change view exposes problems faster and more accurately than "the agent's own summary plus git diff."
- **H3**: Deterministic extraction covers enough real changes, at least for mainstream frameworks in TS/JS and Python. Dynamic calls, dependency injection and event buses are blind spots.
- **H4**: This can't be done by just a good prompt that has the agent generate it itself. Our value lies in deterministic evidence, cross-session history and the review loop.
- **H5**: The platform vendors (Anthropic, OpenAI, Cursor), Entire and Plannotator will not make this "good enough" in the short term. Even if they do, an agent-agnostic open-source tool will still have users.
- **H6**: A small hobbyist team can maintain multi-language extractors (one reason Sourcetrail stopped being updated is said to be the cost of maintaining indexers; unverified).

## 10. Validation plan and stop criteria (about 2 weeks)

1. **Manual comparison experiment**: gather 6 to 8 developers and about 15 real agent sessions, and first build the change diagrams by hand (with an agent's help). The control group is the diff plus the agent's own summary. Compare two things: the time taken to answer "what changed, and is there risk," and the number of problems found.
2. **Minimal plugin**: build a skill plus hook of about 300 lines that generates a change manifest JSON and renders it as HTML, opened in lavish for annotation. **Use it ourselves every day first**, then post to r/ClaudeAI, HN, V2EX and linux.do.
3. **Stop criterion**: if after two weeks fewer than 30% of users still have the hook enabled, or even we stop opening this page, stop and rethink. **Don't look at star counts.**

## 11. Promotion and community (short version)

- One-command install for all agents, listed on both skills.sh and the Claude plugin marketplace; prepare an online demo, a 20-second animated GIF, and a bilingual Chinese-English README.
- Time the release to ride a big event in the agent ecosystem; prepare about 30 good-first-issues before release.
- External contributions mainly come through plugins: one extractor or one risk rule is "one file plus one test."
- Set a bar for AI-written PRs: they must pass regression tests.
- License: MIT.

## 12. Open questions

- Name?
- Write our own extractors, or first depend on the output of Understand-Anything or Graphify?
- Which languages and frameworks come first? (Suggested: TS/JS with Next.js/Express, plus Python with FastAPI/Django)
- Session transcript formats differ between vendors and may change; how do we adapt?

---

## 13. Three-way review and revised direction (2026-11-19)

Three parties took part in the review: a red-team subagent (dedicated to arguing why this should not be built), a neutral subagent (judging from first principles), and the main analysis (me). All three verified the competitors independently.

### 13.1 Conclusions all three agree on

1. **What users want is not "understanding," but "the least effort to confirm whether this time is safe to accept."** Understanding is a cost, not the goal. The positioning should change from "help you understand the system" to "**help you know where to take a look this time**," that is, risk triage.
2. **The original plan's v0.1 (change page plus local structure diagram plus annotation loop) has basically already been done by others.** visual-explainer's `/diff-review` is just a prompt, and it produces before/after diagrams, a risk table and fix options handed back to the agent. Plannotator has importance-ranked diff review and a hand-back-to-agent loop, and it also exposes a local findings API so external tools can paste results straight onto the diff (red team verified, not rechecked). Archify and Understand-Anything both have diff views.
3. **"Free, local, open source" is a barrier to entry in this space, not an advantage.** Nearly all the main competitors are open source, and Entire's CLI is MIT too.

### 13.2 Verdicts on the assumptions

| Assumption | Verdict | Reason |
|---|---|---|
| H1 Users are willing to look every time | Doubtful | A report several times a day soon gets treated as noise and skipped |
| H2 A system view beats summary plus diff | Doubtful | Only effective for changes like "a new door opened." Most problems are logic errors inside functions (inverted conditions, missing validation, skipped tests), which a structure diagram can't see |
| H3 Deterministic extraction has enough coverage | Doubtful | Next file routes, FastAPI decorators, Prisma and `process.env` are easy; Server Actions, tRPC, Drizzle, `import.meta.env`, concatenated URLs, middleware and authorization, and infrastructure code all get missed |
| H4 Can't be done with just a prompt | **Does not hold for the original plan** | visual-explainer is exactly that prompt. Only "deterministic evidence" is something a prompt can't give |
| H5 Others won't make it good enough soon | **Does not hold** | At least five projects have already done part of it |
| H6 A small team can maintain the extractors | Doubtful | Four or five mainstream frameworks, yes; long-tail frameworks and yearly convention changes, no |

### 13.3 What still stands

What LLM-generated review pages (including visual-explainer, Plannotator and the agent's own summaries) **lack most is a deterministic factual foundation**:

- **Risk delta checks**: use rules and parsing to deterministically report the external calls, environment variables, dependencies, migrations or schema changes added in this session, authorization, payment or CI files that were modified, and tests that were deleted or skipped. Every item comes with file and line number. **Stay quiet when there is no risk**; "nothing this time needs your attention" is itself value.
- **Reconciling what the agent said against what actually changed**: if the agent's summary says "only changed styles" but the diff adds an outbound request, flag it red right away. The party being checked can't check itself, and a prompt can't do that.

The revised form is a **CLI or library, not a new page**. It runs in agent hooks, git hooks and CI, and outputs to interfaces others already have: lavish, Plannotator's findings API, visual-explainer, GitHub Checks, and it can also generate a bare-bones HTML page. This way we don't fight 100k-star projects for the user's attention, and H1 stops mattering, because we only interrupt the user when something is up.

### 13.4 Revised validation (do this first, about 1 day, no external users needed)

1. Take 15 to 20 of your own past agent sessions. The git history and the local Claude Code session transcripts already exist.
2. Manually mark the "changes that really need a human to look" in each session, and optionally plant a few problems: add an outbound request, loosen an authorization condition, skip a test.
3. Blind comparison of four groups:
   - A: the summary the agent wrote itself at the time
   - B: visual-explainer's `/diff-review`
   - C: re-asking the agent with a structured risk prompt
   - D: a rule script of about 200 lines, plus the "what the agent said versus what actually changed" reconciliation
4. **Criterion to continue**: D catches problems that B and C miss, in 20% to 30% or more of sessions, without too many false positives. **Criterion to stop**: D ties with B and C.
5. If continuing, use it ourselves for two weeks first. If after two weeks we don't even look at it ourselves, stop.

### 13.5 If validation fails

Redirect the effort into contributing plugins or rules to existing projects, such as visual-explainer, Plannotator and lavish. That is often the fastest way to get more people using your work.
