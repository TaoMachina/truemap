# Vision

**A map of your code that your agent keeps true, and the place where you talk to it.**

## The problem

Coding agents now write code faster than anyone can read it. People stop reading it line by line, and slowly stop understanding their own systems. They still ship, but they can no longer say how the parts fit together, what a change will touch, or what the agent just did.

So the bottleneck has moved. It is no longer writing code. It is the understanding you and your agent share: what the system is, what the agent plans to do to it, and what it actually did.

Today that understanding travels as text. The agent writes paragraphs, you write paragraphs back, and a 40-file diff arrives at the end. Structure (parts, paths, what touches what) is the hardest thing to get across in prose and the easiest thing to see in a picture.

## Why maps of code always died

Architecture diagrams, wikis and code maps have been tried for decades. They die for two reasons:

1. **Keeping them current costs human time.** Nobody pays it, so they go stale, and a stale map is worse than none.
2. **Nobody comes back to them.** They are reference material, not a place where work happens.

## What changed

1. **Upkeep is almost free.** The agent that changes the code can update the map in the same turn. A checker tells it exactly which boxes went stale.
2. **The map can be where you work.** When you ask questions, approve plans and review changes on the map, you have a reason to open it every day, not once.

A visual model of a codebase was never useless. It was too expensive to keep. Now it isn't.

## What truemap is

One map per project, kept in the repo, pinned to the code and checked against it. Everything you and your agent do lands on that map:

- **Understand.** You ask how something works; the agent shows it, and the boxes it talks about light up.
- **Plan.** Before a bigger change, the agent draws what it will add and touch, and waits for you.
- **Review.** After it edits, the changed boxes carry their lines and diffs, next to what the plan said.

The map gets better as you work. Once a plan is built, the agent adds its new boxes to the map. Boxes whose code moved on are marked, and the agent fixes them when it reads the map before a change. Explanations are kept as numbered drafts that link to the boxes they talk about. A page shown once leaves nothing behind; the map stays and grows with the code.

## What we believe

1. **Point, don't type.** Whatever you can point at, you shouldn't have to describe. A click on a box carries the code it stands for.
2. **True, or marked.** Every box is anchored to real code. The check is deterministic (git and text search, no AI), so a box is either still true or visibly marked.
3. **Plain files in your repo.** Maps are HTML in `.truemap/`. You commit, diff, review and share them like code. No account, no cloud.
4. **Any agent.** Anything that can run a shell command can use truemap. The map belongs to the project, not to one vendor.
5. **Nothing extra to learn.** Every feature has to pass two questions: does the user have to do one more thing? Does the agent have to learn one more rule? If yes, it goes.
6. **One look.** Maps follow fixed drawing rules, so every map reads the same in every repo.

## What truemap is not

- Not a new editor or IDE. You keep your agent and your editor.
- Not a hosted service. Nothing leaves your machine.
- Not a tool for pages that aren't about your code. A product plan or a comparison of libraries belongs elsewhere.
- Not documentation you write once and forget. If the map is wrong, it says so.

## Where this goes

- **The agent reaches for the map on its own.** That is the test that matters: does the agent open and update the map without being asked?
- **`.truemap/` as an open convention.** Any agent or tool can read and write it. A repo that carries the folder brings its map to everyone who clones it.
- **Teams through git.** A shared map reviewed in pull requests, before any server.
