# Self-evolution

You asked what "self-evolving" could mean for Shitsuji, and whether the other projects do anything like it. This
page lays out the options as a ladder from safe to risky, says what each reference project does, and proposes
how far to go and in what order.

## The ladder

| Level | What changes | How it is stored | How you undo it | Risk | Feature |
|-------|-------------|------------------|-----------------|------|---------|
| 1 **Remembers** | Facts about you | Memory notes with source quotes | Edit or forget a note | Low | [F13](features/F13-long-term-memory.md) |
| 2 **Learns procedures** | How to do a kind of task | Learned skills with revisions | Roll back a revision | Low | [F19](features/F19-learned-skills.md) |
| 3 **Configures itself** | Its profiles, schedules, MCP servers, tool selection | Settings rows with revisions | Revert in settings | Medium | [F24](features/F24-agent-profiles.md), [F16](features/F16-scheduler-and-routines.md), [F18](features/F18-integrations-mcp.md) |
| 4 **Builds tools** | New capabilities as sandboxed programs | Approved, immutable tool versions | Disable or roll back a version | Medium | [F20](features/F20-tool-forge.md) |
| 5 **Changes its own code** | Shitsuji itself | Git branches, built images | Automatic rollback, git revert | High | [F21](features/F21-self-modification.md) |

Each level adds power and needs stronger safeguards. Levels 1–4 change behaviour **through data inside the
sandbox**; level 5 changes the system that enforces the safeguards, which is why it is last and most guarded.

## What the reference projects do

| Level | nod | openbot | openfuse | OpenMausBot |
|-------|-----|---------|----------|-------------|
| 1 Remembers | ✔ owner-sourced, quoted | ✔ remember tools | ✔ editable memories | ✔ Markdown files, journal |
| 2 Learns procedures | ✔ learned skills, untrusted | (agents write skill folders) | — | ✔ skill drafts, background review |
| 3 Configures itself | partly (schedules, rules, with trust check) | ✔ creates agents, edits its profile, adds MCP servers with approval | — | ✔ Chief creates teammates, routines |
| 4 Builds tools | — (writes scripts in the workspace, not registered tools) | — | roadmap: "managed registry for generated tools" | — |
| 5 Changes its own code | — | — | — | — |

**Nobody goes past level 3 in production.** Level 4 is the natural next step and fits our Docker sandbox well.
Level 5 is new ground.

## Principles for every level

1. **Changes come from work you started.** Background, observer, schedule and helper turns may not create
   skills, tools, profiles or code changes. They can suggest one in a report.
2. **Self-change never widens permissions.** A skill cannot say "send without asking". A profile cannot loosen
   the approval level. A tool cannot get more than the sandbox already has. A code change cannot touch
   protected paths.
3. **Agent-written content is untrusted data** when it is read back (skills, tool output, reports).
4. **Everything is versioned and reversible**, with a visible diff.
5. **Review scales with risk:** levels 1–2 can be automatic with later review; levels 3–4 ask; level 5 needs your
   merge plus automatic checks.
6. **Measure it.** The eval harness ([F22](features/F22-observability-and-cost.md)) checks that a change helps and does
   not break safety scenarios.

## Recommended plan

- **Now (with the foundations):** nothing extra; build the hooks (revisions, `write_self` effect, review queue
  UI) so later levels plug in.
- **Phase 3–5:** levels 1 → 2 → 3 → 4, in that order.
- **Level 5:** design reviewed now ([F21](features/F21-self-modification.md)), then the low-risk stages first:
  bug reports with reproductions, then patch files you apply. Branches with a CI pipeline and canary deploys
  only once the eval suite is trusted.

## Questions for our discussion

- Should learned skills be active immediately or wait for your review? (Proposal: wait, at first.)
- For forged tools, is network access ever acceptable without an allowlist?
- For self-modification, are you comfortable with the agent having **read** access to its own repository in
  the workspace from the start? (Useful for bug reports; low risk.)
