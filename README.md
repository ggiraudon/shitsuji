# Shitsuji

Shitsuji (執事, "butler") is a personal assistant with its own sandboxed computer, deployed with Docker
Compose. It is under active development: the foundations (structure, storage, model routing) are in;
the runtime, channels, tools and sandbox come next. The plan and progress are in [docs/](docs/README.md).

## Quick start (Docker)

1. Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD` (letters, digits, `-` and `_` only) and
   `DEEPSEEK_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).
2. Start everything:

   ```bash
   docker compose up -d --build
   ```

3. Talk to it through the webhook (the terminal and web interfaces are next):

   ```bash
   curl -X POST -H 'content-type: application/json' -d '{"content":"Hello"}' http://localhost:3000/webhook
   ```

   Replies are printed in `docker compose logs core` for now (the webhook does not send them back yet).

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
pnpm build && node packages/core/dist/cli.js        # or: node packages/core/dist/cli.js tui
```

with `DATABASE_URL=postgres://shitsuji:<POSTGRES_PASSWORD>@localhost:5432/shitsuji` in `.env`. Without
`DATABASE_URL`, conversations are kept in memory only. Copy `shitsuji.config.example.yaml` to
`shitsuji.config.yaml` to configure models, prices and channels.
