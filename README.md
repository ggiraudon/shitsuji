# Shitsuji

Shitsuji (執事, "butler") is a personal assistant with its own sandboxed computer, deployed with Docker
Compose. It is under active development: the foundations, tools, runtime, API, terminal UI, **Telegram**
and **trust with approvals** are in, along with spending limits, the activity log and an evaluation
harness. The sandbox (F08) is in: commands and workspace files run in their own container, with
`egress-proxy` as their only way out. The web UI and desktop come next. The plan and progress are in
[docs/](docs/README.md).

## Quick start (Docker)

`packages/shared` is a git submodule ([shitsuji-shared](https://github.com/ggiraudon/shitsuji-shared)),
so clone with `git clone --recurse-submodules`, or run `git submodule update --init` in an existing
clone.

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

## Sandbox

`docker compose up` runs the agent's commands and file tools in the `sandbox` container, through `sandboxd`
(F08). The workspace and handoff folders are the existing `coredata` volume; `/handoff` is read-only to the
sandbox. Its only way out is `egress-proxy`: private, loopback, link-local, CGNAT and cloud-metadata
addresses and `core` are always refused, and the optional `sandbox.egress.allow` / `deny` lists narrow the
open default. Commands get `HTTP_PROXY` / `HTTPS_PROXY`, so pip, npm, git and curl work. Core never joins the
sandbox network: a small `sandboxd-gateway` relay is the only path to the daemon.

`pnpm dev` from source keeps the `host` driver: commands run in core's own process, with no isolation. To
use a running sandbox from source, set `SHITSUJI_SANDBOX_DRIVER=shitsuji` and `SHITSUJI_SANDBOX_URL`, and
point `SHITSUJI_SANDBOX_TOKEN_FILE` at its token.

## Desktop viewer

`core` serves the desktop at `http://127.0.0.1:3001/desktop`; sign in there with the owner key. The page
and the noVNC client come from core, and the stream goes through core and `sandboxd-gateway`, never
directly to the sandbox (F10, S51). The agent's screen is **1920×1080** by default (`SCREEN` on the
sandbox service; a Compose override can change it), and a small `fit-windows` watcher keeps a window an
app opens past an edge on the screen (S56).

The viewer is **watch-only** until someone takes control. The page's **Take control** button switches it
to the full-control stream and pauses every running turn, so the agent cannot write while you type. The
agent can also ask: `computer.request_takeover` pauses its turn with a question that contains the reason
and this link, sent to the same chat (Telegram or the TUI). **Give back** returns the desktop to the agent
and resumes the paused turns with a note and, when a vision model is configured, a fresh screenshot. If
you never give it back, it returns to the agent after **15 minutes**. In owner mode `computer.act` keeps
only screenshots and OCR, and `desktop.act` is refused, so the agent can still look but not act.

To watch from another device on your LAN, publish the API beyond loopback and tell core the address
the owner will use (Y2):

```bash
# .env
SHITSUJI_API_PUBLISH=0.0.0.0
SHITSUJI_PUBLIC_URL=http://192.168.1.20:3001
```

Then `docker compose up -d core`. `SHITSUJI_API_BIND` is only the in-container bind (Compose keeps it
at `0.0.0.0`); `SHITSUJI_API_PUBLISH` is the host address Docker publishes and the one core checks
when it warns that the API is exposed without TLS.

TLS is optional but recommended on a LAN. Mount the certificate and key into core (a Compose override
is the simplest way) and set their paths inside the container:

```bash
SHITSUJI_API_PUBLISH=0.0.0.0
SHITSUJI_PUBLIC_URL=https://shitsuji.lan:3001
SHITSUJI_API_TLS_CERT=/run/secrets/tls.crt
SHITSUJI_API_TLS_KEY=/run/secrets/tls.key
```

If `SHITSUJI_PUBLIC_URL` is unset, links default to `http(s)://127.0.0.1:<published port>`; set it
whenever the owner reaches core by another name.

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
why. `/activity` shows what each tool call did and what allowed it. Standing rules in `trust.rules`
(`tool`, `verdict`, optional `target` and `detail`) can force a card or refuse an action before the judge.

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
pnpm run docs   # API docs + walkthroughs in docs-site/index.html
```

To run core from source against a local Postgres:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
pnpm build && node packages/core/dist/cli.js        # the server, on the host driver
node packages/core/dist/cli.js tui                  # in another terminal: the chat
```

with `DATABASE_URL=postgres://shitsuji:<POSTGRES_PASSWORD>@localhost:5432/shitsuji` in `.env`. Without
`DATABASE_URL`, conversations are kept in memory only. Copy `shitsuji.config.example.yaml` to
`shitsuji.config.yaml` to configure models, prices and channels.
