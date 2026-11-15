# F23 — Voice

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| Later | 24 | M | F03, F06 | — |

## What it is

Talking to Shitsuji: send a **voice note** on Telegram or in the web UI and it is transcribed; ask for replies
**read aloud**; later, a live **call** mode in the web UI.

## Inspiration

- **OpenMausBot:** speak a reply on demand or automatically; a call mode that hears you, says what it is doing
  while it works, and asks for approvals out loud; several TTS providers (cloud and a local Chatterbox server);
  a **spoken register** that says the prose, names artifacts and drops syntax (no reading file paths or code
  aloud); one request per utterance with prefetching instead of a streaming socket; keys stay on the server.
- **nod:** transcribing your own voice message ignores the monthly limit; a recording caught mid-transcription
  by Stop is cancelled before it is saved.

## Design

| Port | Adapters |
|------|----------|
| `SpeechToText` | OpenAI-compatible `/audio/transcriptions` (Groq, OpenAI, a local `faster-whisper` server in the `local-models` profile) |
| `TextToSpeech` | OpenAI-compatible `/audio/speech`, ElevenLabs, a local Piper or Kokoro server |

| Class | Responsibility |
|-------|---------------|
| `VoiceNoteHandler` | Gateway hook: audio attachment → transcript → stored as your message (with the audio file kept) |
| `SpokenRegister` | Turns Markdown into speakable utterances: drops code blocks, names files ("a Python script"), shortens links |
| `SpeechService` | Synthesises per utterance, caches, meters cost in the usage ledger ([F22](F22-observability-and-cost.md)) |

Approvals by voice are **never** accepted: a spoken "yes" is only a hint; the card must be confirmed by a tap.

## Acceptance criteria

- A Telegram voice note becomes a text message in the thread and the agent answers it.
- "Read that to me" returns a Telegram voice reply without code or paths read aloud.

## Open questions

- Local speech-to-text needs a GPU for good latency. Use a cheap API first.
