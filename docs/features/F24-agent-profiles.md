# F24 — Agent profiles and specialists

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 5 Self-evolution | 22 | M | F04, F14, F15 | — |

## What it is

Named **profiles** that change how Shitsuji works for a kind of job: its instructions, model, tool selection,
skills and approval level. Examples: "Researcher" (strong model, web tools, research skill), "Bookkeeper"
(finance skills, workspace tools, no browser purchases), "Desktop operator" (vision model, computer use).
Profiles are used by the coordinator when it starts tasks or delegates to helpers. The agent can propose new
profiles for itself, which is a practical form of self-evolution.

Shitsuji stays **one assistant** with one memory. Profiles are hats it wears, not separate bots with separate
memories.

## Inspiration

- **openbot:** prompt-driven agent creation and editing (`create_agent`, `update_profile`) with validation of
  provider, model and effort; backup models; a specialist differs only by profile, skills and memories;
  delegation to a teammate whose description covers the work.
- **OpenMausBot:** a team of bots with a **Chief of Staff**; per-bot `SOUL.md`, model and computer; a fast
  decision model routes messages in a room; whole teams shared as one Markdown file with routines paused and
  connections off on import.

## Design

```ts
interface AgentProfile {
  id: AgentProfileId;
  name: string;                       // "Researcher"
  description: string;                // when the coordinator should use it
  instructions: string;               // added to SOUL.md for this profile
  models: Partial<Record<ModelPurpose, ModelRef>>;   // overrides of the router defaults
  tools: { allow?: string[]; exclude?: string[] };   // selectors, F05
  skills: string[];                   // preferred skills listed first
  approvalLevel: ApprovalLevel;       // can only be equal to or stricter than the default (F11)
  createdBy: 'owner' | 'agent';
  status: 'active' | 'proposed' | 'retired';
}
```

| Class | Responsibility |
|-------|---------------|
| `ProfileRepository` | CRUD with revisions |
| `ProfileResolver` | Applies a profile to a session: merges instructions, model bindings and tool selection |
| `ProfileSelector` | Optional: a cheap `classify` call suggests a profile for a new task from descriptions |

Tools: `profile.list` (`read`), `profile.propose({ … })` (`write_self`, asks), `task.start({ profile })`,
`delegate({ profile })`.

**A profile can never raise permissions:** its approval level must be the default or stricter, and its tool
selection can only narrow the available tools.

### Import and export

A profile (with its preferred skills) exports to one Markdown file with YAML front matter. Imported profiles
start as `proposed`, with no secrets, memory or connections.

## Acceptance criteria

- "Use the Bookkeeper for this" starts a task with that profile's model and tools.
- The agent proposes a "Travel planner" profile after several travel tasks; it appears only after you approve.
- A profile that tries to set a looser approval level is refused.

## Risks and open questions

- Do we ever want truly separate agents with separate memory (OpenMausBot's model)? Proposal: not for a
  personal assistant; revisit if Shitsuji is shared with family or a team.
