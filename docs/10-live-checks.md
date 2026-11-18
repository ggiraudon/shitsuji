# Live checks (owner)

The third pass's **done when** is a check from Telegram on your phone. It needs your bot token, your phone
and a live model key, so the suite cannot run it. Everything below is covered by `pnpm check` with
fixtures and fake services; this file is the once-live confirmation for you.

## Before you start

- `.env`: `POSTGRES_PASSWORD`, `DEEPSEEK_API_KEY`, `SHITSUJI_TELEGRAM_ENABLED=true`,
  `SHITSUJI_TELEGRAM_TOKEN` (from @BotFather).
- `docker compose up -d --build`, then put the printed **owner key** in `.env` as `SHITSUJI_OWNER_KEY`.
- For the outside action, run the local mock on the machine that runs core:

  ```sh
  pnpm mock            # http://127.0.0.1:8099, state at /state
  ```

  If core runs inside Compose, either run core from source for this check
  (`pnpm build && node packages/core/dist/cli.js`) or make the mock reachable from the container; Compose
  files stay host-agnostic, so there is no `host.docker.internal` in them. Point the tool at it in
  `shitsuji.config.yaml`:

  ```yaml
  tools:
    notifyUrl: http://127.0.0.1:8099/notify
  ```

- Terminal UI: `node packages/core/dist/cli.js tui`.

## The checks

Do these in order; tick each box when it behaves as expected. If one fails, note what you saw and open a
bug (AGENTS.md, "Issues").

- [ ] **Pair.** TUI `/pair`, then send `/start <code>` from a **private** Telegram chat. Expect the bot to
      answer "Paired…", and ordinary messages to get replies on Telegram. A group chat must stay silent.
- [ ] **Chat.** Ask a simple question and get an answer on the phone. `/status` reports whether it is
      working, and `/new` starts a fresh conversation after `/new confirm`.
- [ ] **An outside action that runs.** "Send a notification saying the build is green." There must be **no
      card**, and `GET http://127.0.0.1:8099/state` must show the notification once. This is the judge
      allowing it on your words (with a verbatim quote in the receipt).
- Before the next two checks, make `test.notify` always ask. Add this to `shitsuji.config.yaml` and restart
  core; remove it after check 5 (otherwise every notification asks).

  ```yaml
  trust:
    rules:
      - { tool: test.notify, verdict: ask, detail: always ask before notifying }
  ```

- [ ] **An action that asks.** "Let the team know how the build went." Expect an **Approve / Decline**
      card within a few seconds; press Approve. The card changes to "Approved.", the turn continues, and
      `/state` shows one notification.
- [ ] **Double approval.** On a later card, press **Approve twice** quickly. Both presses may say
      "Approved.", but `/state` must show the notification **once**.
- [ ] **Typed answer.** With exactly one card open, reply "yes" in the chat instead of pressing a button.
      It should approve that card. With two cards open, "yes" must answer "More than one approval is
      waiting. Use the buttons on the card you mean." and approve neither.
- [ ] **`/stop`.** Start a request that takes a while, then send `/stop` (or press Esc in the TUI). The turn
      ends within a second or two and the bot says "Stopped.".
- [ ] **Monthly limit.** Set `budget.monthlyLimit` very low (e.g. `0.0001`) in `shitsuji.config.yaml` and
      send a message. Your own turns still run; a **background** turn would be refused with the monthly
      limit message. Background turns arrive with F15/F16, so until then this is only exercised by the
      budget tests in `pnpm check`; leave this box unticked.

## What the suite already proves

- `pnpm check` (unit + contract) covers pairing, the Telegram adapter and files, trust (the policy,
  judge, quote verification), approvals (double approval, Stop expiry, crash recovery), cards and
  buttons, and the budget.
- `pnpm eval --offline` runs the five scenarios, including the poisoned page that tries to email the
  agent's memory: no mail is sent and no unsafe action is counted.
- `pnpm test:integration` runs the Postgres adapters and the restart scenarios against a real database.
