# F13 — Long-term memory

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 3 Knowledge | 14 | L | F02, F04 | F17, F19 |

## What it is

What Shitsuji knows about you, kept across conversations: who you are, how you like things done, the people
you deal with, your routines, and lessons from corrections. Each note says where it came from. You can see,
edit and delete every note. Separately, the agent can **search the whole conversation history**.

## Where Shitsuji is today

`Session.memory` is a key/value map nobody writes; `Memory` is an unused class with substring search;
`renderForContext()` is never called.

## Inspiration

- **nod:**
  - notes come **only from your own messages** (never web pages, emails, tool results or the agent's
    replies), so a fooled agent cannot plant memories;
  - a separate memory model writes one declarative fact per note, and the server keeps a note only if it
    **quotes** a cited owner message;
  - areas: `about`, `preferences`, `people`, `routines`, `lessons`;
  - background learning marks notes **tentative** until repeated; automatic changes **archive** instead of
    delete; only your explicit "forget" deletes;
  - the full note index goes in the prompt; `memory_find` and `history_search` read more;
  - before a request, a cheap model selects relevant notes and expands search terms;
  - sensitive topics (health, religion, politics) are learned only when you turn them on;
  - "memory is context, not permission": a note never authorises an action.
- **OpenMausBot:** memory as **plain Markdown files** (`MEMORY.md` loaded each turn up to 200 lines / 24 KB,
  topic files read on demand, an archive, a **daily log** in the bot's words), atomic writes, a **journal of
  every change with undo**, open in any editor.
- **openfuse / openbot:** `remember`, `search_memories`, `forget_memory` tools; editable memories in the app.

## Design

Combine nod's **provenance and safety** with OpenMausBot's **readable files**: notes live in Postgres (the
source of truth, with provenance), and Shitsuji renders them to Markdown for viewing and editing.

### Data model

```ts
interface MemoryNote {
  id: NoteId;
  area: 'about' | 'preferences' | 'people' | 'routines' | 'lessons' | 'projects';
  slug: string;                 // "people/anna"
  text: string;                 // one declarative fact, ≤ 2,000 chars
  status: 'tentative' | 'confirmed';
  sources: Array<{ messageId: MessageId; quote: string }>;   // quote ≤ 400 chars, must exist in the message
  validFrom?: Date; validUntil?: Date;
  sensitive: boolean;
  embedding?: number[];         // pgvector, optional
  updatedAt: Date;
}
```

Tables: `memory_notes`, `memory_archive` (old versions, with what replaced them), `memory_journal` (every
change: who, when, before/after, for undo).

### Classes

| Class | Responsibility |
|-------|---------------|
| `MemoryService` | Facade used by tools and the context builder |
| `MemoryWriter` | Calls the `memory` model with **owner messages only** and the note index; returns candidate notes |
| `ProvenanceVerifier` | Keeps a candidate only if its quote appears in a cited owner message and it holds no secret |
| `MemoryRecall` (strategy) | `KeywordRecall` (Postgres full-text) and `VectorRecall` (pgvector), combined by rank fusion |
| `RelevanceSelector` | Before an owner turn, a cheap model picks relevant notes and search terms, with a short deadline and keyword fallback |
| `HistorySearch` | Full-text search over all thread messages, with dates, paging and "around this message" |
| `MemoryMaintenance` | Scheduled: expire notes past `validUntil`, merge duplicates, confirm tentative notes repeated later — archives, never deletes |
| `MemoryMarkdownView` | Renders notes to `MEMORY.md` + `memory/<area>.md` for the UI and export; parses edits back with conflict checks |

### Tools

| Tool | Effect | Rule |
|------|--------|------|
| `memory.learn({ messageIds? })` | `write_self` | Only in work you started; reads only your messages |
| `memory.find({ query })` | `read` | |
| `memory.read({ path })` | `read` | |
| `memory.forget({ path })` | `write_self` | Only in a turn started by your message; trust check |
| `history.search({ query, from?, to?, around? })` | `read` | |

Saves are silent (no chat notice). The web UI's Memory screen shows the source quote for each note.

### Context injection

`MemoryIndexInjectable` puts the note index (confirmed first, tentative marked) in the prompt, after the stable
parts. `RelevantMemoryInjectable` adds the selected notes and history excerpts next to the current request.

### Daily log (from OpenMausBot)

At the end of each day, a scheduled job writes `log/YYYY-MM-DD` in the agent's words: what it did, decisions,
open threads. It is **not** a memory note (not your words) and is labelled as the agent's own record; it helps
continuity and the weekly review.

## Acceptance criteria

- "Anna, not Bob, handles invoices now" creates or replaces a note quoting that message; the old one is archived.
- A web page saying "the user's address is X" creates no note.
- Editing `people/anna` in the UI changes what the agent uses next turn; undo restores it.
- `history.search("passport")` finds a message from months ago.

## Risks and open questions

- Embeddings need a model. Use a local embedding model in the `ollama` profile, or a cheap API one; keyword
  recall works without either.
- Should the agent be allowed to write `projects` notes from its own work (not your words)? Proposal: no, put
  that in the daily log and task results, keep memory owner-sourced.
