# Shitsuji

Shitsuji (執事, "butler") is a personal assistant with its own sandboxed computer, deployed with Docker
Compose. It is under active development: the foundations, tools, runtime, API and terminal UI are in;
Telegram, the web UI and the sandbox come next. The plan and progress are in [docs/](docs/README.md).

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
   edit (`/soul apply` keeps it), `/usage` shows spending, `/activity` shows recent tool calls, `/exit`
   quits.

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
