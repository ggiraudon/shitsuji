# Shitsuji research docs

This folder holds the research and design notes for taking Shitsuji from an early prototype to a capable,
proactive personal assistant. It is documentation only. No code has changed yet.

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

## Ground rules from the brief

- **Docker Compose** is the deployment target, with several containers, including a desktop the agent owns.
- **Bring-your-own-key models** come first: DeepSeek and other OpenAI-compatible APIs, then local models
  (Ollama, LocalAI) later.
- **Channels:** a Web UI and Telegram first, behind an abstraction so more can be added.
- **Object-oriented design** with clear patterns. We may reshape Shitsuji but keep the parts that work.
- **Ideas only.** We borrow ideas from the reference projects, never code. See the licensing note in
  [01-inspiration-survey.md](01-inspiration-survey.md#licences).
