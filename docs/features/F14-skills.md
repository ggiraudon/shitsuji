# F14 — Skills library

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 3 Knowledge | 15 | S | F05 | F19, F24 |

## What it is

Task guides that teach the agent how to do a kind of work well (research, travel planning, inbox triage,
spreadsheets, writing, home admin…). Only the names and one-line descriptions go into the prompt; the agent
reads a full guide when a task matches. This keeps the prompt small and still gives detailed advice.

## Inspiration

- **nod:** follows the [Agent Skills](https://agentskills.io) format; **progressive disclosure** in three
  levels (catalogue in the prompt → `SKILL.md` → reference files when a condition applies); 27 built-in guides;
  guides add no tools and grant no permission; reads are confined to the skill folder; an eval showed a modest
  task-completion gain (71% → 77%).
- **openbot:** the same format; skills installed per workspace; a lock file of hashes; disabled skills kept
  aside; a `$` tag to point the agent at a skill.
- **OpenMausBot:** skills with saved revisions; teams of bots shipped with their skills in one Markdown file.

## Design

### Format

```
skills/
└── research/
    ├── SKILL.md            front matter: name, description (when to use), optional "disable-model-invocation"
    └── references/
        └── academic-sources.md
```

```md
---
name: research
description: Investigate a question across several sources and report with citations. Use for "find out",
  "compare", "what's the best". Not for a single fact lookup.
---
Decisions this task needs, failure cases, and the evidence that proves the result.
```

### Classes

| Class | Responsibility |
|-------|---------------|
| `SkillSource` (port) | Lists and reads skills; implementations: `BuiltInSkillSource` (in the image), `UserSkillSource` (a mounted folder), `LearnedSkillSource` (database, [F19](F19-learned-skills.md)) |
| `SkillLibrary` | Merges sources, validates front matter at startup, resolves name conflicts (user > learned > built-in), exposes the catalogue |
| `SkillIndexInjectable` | Puts `name: description` lines in the prompt |
| `skills` tool | `list`, `read({ name, file? })` |

Validation: `name` matches the folder, description 1–1,024 characters, only regular Markdown files, reads stay
inside the skill folder after resolving links. Invalid metadata fails startup with a clear error.

### Trust level

| Source | Treated as |
|--------|-----------|
| Built-in and your own folder | Trusted guidance |
| Learned ([F19](F19-learned-skills.md)) or installed from elsewhere | **Untrusted data**: wrapped like web content; can suggest steps, never grants permission |

### First built-in skills (proposal)

`research`, `writing`, `inbox`, `calendar`, `documents-and-forms`, `spreadsheets-and-data`, `shopping`,
`travel`, `personal-finance`, `home-admin`, `software-and-scripts`, `browser-tasks`, `desktop-apps`.

## Acceptance criteria

- The prompt carries only the catalogue; a task about travel reads `travel/SKILL.md` first.
- A skill with a path that escapes its folder is refused.
- Adding a folder to the user skills volume and restarting makes it available.

## Risks and open questions

- Writing good skills is real work. Start with five, measure with the eval harness
  ([F22](F22-observability-and-cost.md)), then add more.
