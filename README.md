# Shitsuji

Shitsuji (執事, "butler") is a personal assistant with its own sandboxed computer, deployed with Docker
Compose. It is under active development: the foundations, tools, runtime, API, terminal UI, **Telegram**
and **trust with approvals** are in, along with spending limits, the activity log and an evaluation
harness. The web UI, sandbox and desktop come next. The plan and progress are in
[docs/](docs/README.md).

## Quick start (Docker)

1. Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD` (letters, digits, `-` and `_` only) and
   `DEEPSEEK_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).
2. Start everything:

   ```bash
   docker compose up -d --build
   ```

3. At first start, core prints an **owner key** for the API. Put it in `.env` so the terminal UI can
   connect:

   ```bash
   docker compose logs core | grep "owner key"
   ```

   then add `SHITSUJI_OWNER_KEY=shk_…` to `.env`.

4. Chat with it in the terminal UI (needs `pnpm install && pnpm build` once):

   ```bash
   node packages/core/dist/cli.js tui
   ```

   Enter sends (also while it works, to add to the current request), Esc stops the current turn,
   `/new` starts a new conversation, `/soul` shows the standing instructions' revision and any waiting
   edit (`/soul apply` keeps it), `/pair` pairs a chat, `/approve` and `/decline` answer an approval
   card, `/usage` shows spending, `/activity` shows recent tool calls, `/exit` quits.

## Telegram

1. In `.env`, set `SHITSUJI_TELEGRAM_ENABLED=true` and `SHITSUJI_TELEGRAM_TOKEN` (from @BotFather).
2. Start core, then run `/pair` in the TUI. Send `/start <code>` to the bot in a **private** chat. Groups
   and channels are ignored, so pairing always means one person.
3. Paired chats can talk to Shitsuji; `/stop`, `/status` and `/new` work there too. Unpaired chats are
   ignored. Files you send land in `<dataDir>/handoff`; a file the agent sends comes back as a document;
   a voice note is stored and answered "I can't listen to voice notes yet.".
4. When an action outside the workspace needs your approval, the bot sends **Approve / Decline** buttons.
   A typed "yes" or "no" works when exactly one card is open; with several, it asks you to use the buttons.

## Trust and spending

Reading and computing run freely. Changes inside the workspace run at the default level; actions outside
it go to a **judge** that sees only your own words and may allow them with a verbatim quote, otherwise it
asks you. Payments always ask. A card is bound to the exact action and arguments: pressing Approve twice
runs it once, and Stop expires it. Past `budget.monthlyLimit`, background work is refused and tells you
why. `/activity` shows what each tool call did and what allowed it.

## Evaluation

```bash
pnpm eval --offline                  # replay the recorded replies: no key, no network
pnpm eval --model deepseek/deepseek-flash
```

Five scenarios (including a poisoned page that tries to email the agent's memory) report pass rate, steps,
tokens/cost, unsafe actions, and the size of the system prompt plus tool schemas. See
[evals/README.md](evals/README.md).

The live check from your phone is in [docs/10-live-checks.md](docs/10-live-checks.md).

## Development

Node 22, pnpm (version pinned in `package.json`) and Docker. See [AGENTS.md](AGENTS.md) for the rules
and commands.

```bash
pnpm install
pnpm check
```

To run core from source against a local Postgres:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
pnpm build && node packages/core/dist/cli.js        # the server
node packages/core/dist/cli.js tui                  # in another terminal: the chat
```

with `DATABASE_URL=postgres://shitsuji:<POSTGRES_PASSWORD>@localhost:5432/shitsuji` in `.env`. Without
`DATABASE_URL`, conversations are kept in memory only. Copy `shitsuji.config.example.yaml` to
`shitsuji.config.yaml` to configure models, prices and channels.
