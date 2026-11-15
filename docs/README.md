# Shitsuji research docs

This folder holds the research and design notes for taking Shitsuji from an early prototype to a capable,
proactive personal assistant. Implementation follows [08-second-pass-plan.md](08-second-pass-plan.md); the first pass is done.

## Read in this order

| # | File | What it covers |
|---|------|----------------|
| 1 | [00-current-state.md](00-current-state.md) | What Shitsuji implements today, what works, and what is broken or missing |
| 2 | [01-inspiration-survey.md](01-inspiration-survey.md) | What nod, openbot, openfuse and OpenMausBot do, and which ideas are worth borrowing |
| 3 | [02-target-architecture.md](02-target-architecture.md) | The proposed design: patterns, layers, Docker Compose layout, what we keep from today |
| 4 | [03-feature-overview.md](03-feature-overview.md) | **The ranked feature list**, phases and dependency graph |
| 5 | [features/](features/) | One file per feature: how to build it and how it depends on the others |
| 6 | [04-self-evolution.md](04-self-evolution.md) | What "self-evolving" can mean, what the other projects do, and the safeguards it needs |
| 7 | [05-open-questions.md](05-open-questions.md) | Decisions to make together before implementation |
| 8 | [06-class-map.md](06-class-map.md) | Mermaid class diagrams of the target code structure, one per area |
| 9 | [07-first-pass-plan.md](07-first-pass-plan.md) | The first pass (done): F01 + F02 + F03 as steps S1–S14 |
| 10 | [08-second-pass-plan.md](08-second-pass-plan.md) | **The current plan**: F05 + F04 + HTTP API and TUI as steps S15–S26 |
| 11 | [PROGRESS.md](PROGRESS.md) | The checklist: every pass's steps and every feature's acceptance criteria |

Rules for working on the code (commits, layers, tests) are in [AGENTS.md](../AGENTS.md).

## Ground rules from the brief

- **Docker Compose** is the deployment target, with several containers, including a desktop the agent owns.
- **Bring-your-own-key models** come first: DeepSeek and other OpenAI-compatible APIs, then local models
  (Ollama, LocalAI) later.
- **Channels:** a Web UI and Telegram first, behind an abstraction so more can be added.
- **Object-oriented design** with clear patterns. We may reshape Shitsuji but keep the parts that work.
- **Ideas only.** We borrow ideas from the reference projects, never code. See the licensing note in
  [01-inspiration-survey.md](01-inspiration-survey.md#licences).
