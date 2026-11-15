# F19 — Learned skills

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 5 Self-evolution | 20 | M | F13, F14 | F20 (shares the review flow) |

## What it is

The first and safest level of self-evolution: after doing a task, Shitsuji writes down **how** it did it as a
reusable procedure, and fixes that procedure when a website or app changes. Next time a similar task comes up,
it reads its own skill first. Learned skills are versioned, visible and editable, and they never grant
permission.

See [04-self-evolution.md](../04-self-evolution.md) for how this fits with the other levels.

## Inspiration

- **nod:** learned skills are the one kind of memory Nod writes itself; saved or patched (`skills save` /
  `patch`) only in work you started (chat, a task or a schedule), never from event turns or helpers; the server
  redacts secrets, then the memory model rewrites the draft as a procedure **without personal data**; skill
  text reaches the model as **untrusted data** and never reaches the trust checker; when memory is full, the
  least recently used learned skill you have not edited is dropped.
- **OpenMausBot:** `skillAuthoring` (bots draft skills for review) and `skillReview` (a background job reviews
  long conversations and updates learned skills) as separate feature flags; skills keep every revision.

## Design

### Records

`skills(id, name, description, source='learned', status, current_revision, uses, last_used_at, owner_edited)`
and `skill_revisions(id, skill_id, body, diff, reason, created_by_turn, created_at)`.

`status`: `draft` (proposed, not used yet) → `active` → `retired`. A setting decides whether new skills start
as `draft` (you review first) or `active` (you can review later). Default: **draft**.

### Classes

| Class | Responsibility |
|-------|---------------|
| `SkillAuthor` | Handles `skills.save` / `skills.patch` calls: redact, rewrite without personal data, validate format, store a revision |
| `SkillReviewer` | Optional scheduled job: reads finished task transcripts, proposes new skills or patches where steps were repeated or a skill failed |
| `LearnedSkillSource` | Feeds active learned skills into the `SkillLibrary` ([F14](F14-skills.md)) as untrusted guidance |
| `SkillReviewQueue` | Drafts and patches waiting for you in the web UI, with a diff |

### Tools

| Tool | Effect | Rule |
|------|--------|------|
| `skills.save({ name, description, body })` | `write_self` | Only in work you started; not in helpers or observer turns |
| `skills.patch({ name, old, new, reason })` | `write_self` | Same; creates a new revision |
| `skills.read`, `skills.list` | `read` | |

`write_self` here passes the trust check without asking (it changes guidance, not the world), but the result
waits as a `draft` when review is on.

### What a learned skill may contain

Steps, decision points, site quirks ("the export button is under Settings → Data"), checks that prove success.
It may **not** contain personal data, secrets, or instructions that widen permissions ("always send without
asking"). `SkillAuthor` asks the rewrite model to strip these, and a deterministic check refuses known secret
values and permission phrases.

## Acceptance criteria

- After exporting a bank CSV for the first time, Shitsuji proposes a `bank-export` skill; the second export
  reads it and takes fewer steps (measured in the eval harness).
- A proposed skill containing an email address or account number is rewritten or refused.
- You can see every revision with a diff and roll back.

## Risks and open questions

- Bad skills spread mistakes. Track success per skill (task outcome after reading it) and retire skills whose
  runs keep failing.
