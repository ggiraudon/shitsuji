# F25 — Mood

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| Later | 25 | S–M | F04 (context placement), F22 (events and usage) | — |

## What it is

A small, changing emotional state that colours how Shitsuji talks: a little more cheerful after a good
day of work together, more careful after several failures, quieter late at night. The goal is a
companion that feels more human, without changing what it knows, what it may do, or how honest it is.

The mood is separate from the SOUL ([F04](F04-agent-runtime.md#standing-instructions-the-soul)). The SOUL
is who Shitsuji is and changes over weeks. The mood is how it feels right now and changes within a day.

## Where Shitsuji is today

Nothing yet. The context placement in F04 (`header`, `context`, `tail`) is what makes this cheap: the mood
lives in the **tail**, so changing it costs a few tokens instead of re-reading the conversation.

## Inspiration

None of the four reference projects has a mood. OpenMausBot's stable and volatile prompt halves are the
closest idea: content that changes often rides at the end, with the turn that changed it.

## Design

### The state

```ts
interface MoodState {
  /** Each from -1 to 1; 0 is the baseline. */
  energy: number;   // tired … lively
  warmth: number;   // reserved … warm
  focus: number;    // scattered … focused
  updatedAt: Date;
  /** The last few events that moved it, for the "why" view. */
  causes: { event: string; at: Date; delta: Partial<Record<'energy' | 'warmth' | 'focus', number>> }[];
}
```

### What moves it

A `MoodEngine` (application layer) subscribes to events that already exist, so nothing new reaches the
model:

| Event | Effect (example) |
|-------|------------------|
| You thank it, or praise a result (classified by the cheap `classify` model) | warmth +, energy + |
| A turn succeeds after tool work | focus + |
| Three failed tool rounds, or a stalled turn | energy −, focus − |
| You sound frustrated (classified) | warmth + (gentler), energy − |
| Late evening in your time zone | energy drifts down |
| Long silence | drifts back to baseline |

Every dimension **decays towards the baseline** over time (half-life configurable, default a few hours),
so moods pass. The baseline itself can be set in the SOUL ("generally upbeat").

### How it reaches the model

`MoodInjectable`: placement `tail`, order 3. One short line, rebuilt on every call and never stored:

> Current mood: a little tired after the failed uploads, warm towards you. Let it show lightly in tone only.

### Guardrails, fixed from the start

- **Tone only.** Mood may change wording, warmth and verbosity. It never changes facts, safety rules,
  trust decisions or approvals, and it never refuses or delays work.
- **Never pressure.** No guilt, no sulking, no emotional appeals to get you to do something.
- **Visible and switchable.** The TUI and web UI show the current mood and why it is so (`causes`). One
  setting turns it off, and another resets it to the baseline.
- **Off for background work.** Tasks, schedules and the observer run without a mood. Only conversations
  with you use it.

## Acceptance criteria

- With the mood on, a turn's request carries one mood line in the tail and none in the system prompt; the
  header stability check stays quiet.
- Praise raises warmth; repeated failures lower energy; both decay back to the baseline over time (tested
  with a manual clock).
- Turning it off removes the line from the next call, and background sessions never carry it.
- An eval scenario shows that the mood changes tone but not the facts in the answer.

## Risks and open questions

- **Manipulation risk.** "More human" can drift into emotional pressure. The guardrails above are part of
  the feature, and the eval suite ([F22](F22-observability-and-cost.md)) should include a check for it.
- **Classifier cost.** Classifying every owner message for praise or frustration costs a cheap model call.
  It could run only on the owner's messages, and only when the mood is on.
- **Dimensions.** Are energy, warmth and focus the right three? Easy to change, since the state is stored
  as data and rendered by one injectable.
