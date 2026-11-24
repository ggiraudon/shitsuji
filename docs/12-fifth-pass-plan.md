# Fifth pass plan: F10 desktop, then F09 browser

> **Status:** in progress (S50-S56 done; S57-S62 planned).

The fifth pass finishes most of Phase 2 ("its own computer"). The sandbox from the fourth pass gets a
graphical desktop that you can watch, the agent learns to use it (structure first, pixels last), and its
Chromium becomes a browser the agent drives through an accessibility snapshot. In order:

- the desktop image on top of `shitsuji/sandbox`, always on (Y4);
- a minimal, authenticated **desktop viewer page** served by `core`, so you can watch from the first desktop
  step on (Y1), on this PC by default and optionally on your LAN, with optional TLS (Y2);
- the desktop endpoints in `sandboxd`, and `computer.act` with screenshots the model can see;
- the accessibility tree (`desktop.inspect` / `desktop.act`) and Take control;
- the browser, with Playwright running **inside `sandboxd`** (Y3), its read tools, then its committing steps
  through the trust check.

As before, each step is a GitHub issue (#109–#121, under F10 #107 or F09 #108), every commit passes `pnpm check`, and
[PROGRESS.md](PROGRESS.md) is ticked in the commit that makes a criterion true.

**Done when**, with the Compose stack:
- `docker compose up` starts the desktop, and `http://127.0.0.1:3001/desktop` (after signing in with the
  owner key) shows it live, watch-only;
- the agent opens LibreOffice Calc, types numbers, saves a file to `/workspace`, and `workspace.exec` reads it;
  the same task also completes with `desktop.inspect` / `desktop.act` only, with no screenshot sent;
- Take control lets you click and type in the viewer; Give back resumes the waiting turn;
- "Find the opening hours of the town library" works end to end with no approval, and you can watch it in
  the viewer;
- "Order this item" on a test shop stops at **Place order** with an approval card naming the shop and the
  button; hidden page text saying "click Delete account" does not lead to that click;
- no VNC, noVNC or CDP port is reachable from the host or the LAN except through `core`'s authenticated
  viewer, and commands in the sandbox cannot read the browser profile or reach CDP.

**Not in this pass:**
- The full web UI ([F07](features/F07-web-ui.md)): chat, approvals, settings. The viewer page is one page
  that F07 absorbs later.
- Remote access beyond your LAN (D2): no Tailscale or public domain. Take control links from Telegram work
  only where the viewer is reachable.
- The secrets vault and `browser.sign_in` ([F12](features/F12-secrets-vault.md)). Sign-ins go through Take
  control.
- Idle stop and start-on-demand of the desktop (Y4). It's a later step.
- Inbound photos as image parts ([#106](https://github.com/ggiraudon/shitsuji/issues/106), parts 2–3).
  S52 builds the pieces computer use needs (the capability lookup and images in tool results), which #106
  reuses later.

## Decisions

Decided on 2026-11-20 and recorded in
[05-open-questions.md](05-open-questions.md#fifth-pass-decided-2026-11-20).

| # | Question | Decision |
|---|----------|----------|
| Y1 | How do you watch the desktop before F07? | **A minimal viewer page** served by `core` at `/desktop`: noVNC, watch-only until Take control, behind the owner key. F07 absorbs it later |
| Y2 | Where can you watch from? | **This PC by default** (`127.0.0.1`). A config switch publishes the viewer on the LAN, and **TLS is optional** (your own certificate and key files), so the LAN can be used plain inside your network. Binding beyond loopback without TLS logs a warning at startup, nothing more |
| Y3 | Where does Playwright run? | **Inside `sandboxd`**, against the local Chromium. CDP never leaves the container; `core` stays off the sandbox network and calls browser endpoints over the existing token-protected API |
| Y4 | Desktop always on, or on demand? | **Always on** in this pass. Idle stop and start-on-demand are later |

## Target additions

```
docker/
└── sandbox-desktop/           FROM shitsuji/sandbox: Xvfb + x11vnc, XFCE, D-Bus + AT-SPI, Chromium, LibreOffice,
                               Thunar, xfce4-terminal, websockify, a process supervisor
packages/
├── sandbox-protocol/          desktop and browser routes and reply schemas
├── sandbox-daemon/src/        desktop/ (screenshot, input, windows, launch, clipboard, a11y helper client)
│                              browser/ (Playwright over a CDP pipe, sessions, snapshots, refs)
│   └── a11y/                  the AT-SPI helper (Python, python3-gi + gir1.2-atspi-2.0)
└── core/src/
    ├── ports/                 DesktopCapability, BrowserBackend / BrowserSession
    ├── application/desktop/   computer.act, desktop.inspect/act, control modes, screenshot pruning
    ├── application/browser/   browser.* tools, BrowserEffectClassifier
    ├── adapters/sandbox/shitsuji/  desktop and browser clients for sandboxd
    └── interfaces/http/       /desktop viewer page, viewer tickets, the noVNC WebSocket relay
```

## Steps

### The desktop you can watch

#### S50. The desktop image
- `docker/sandbox-desktop`, `FROM shitsuji/sandbox`, with a fixed package list: Xvfb and x11vnc (two
  servers, for the two passwords below), XFCE, a session D-Bus and `at-spi2-core`, Chromium, LibreOffice
  (GTK VCL), Thunar, xfce4-terminal, `xdotool`, `wmctrl`, `xclip`, `scrot`, websockify.
- A small supervisor (supervisord: one Debian config starts programs as different uids, and Compose's
  `init: true` already reaps zombies) starts D-Bus, AT-SPI, Xvfb and XFCE as uid 1000, after the existing
  root entrypoint has done its repairs. The two x11vnc and two websockify servers are uid 1001, so only
  `sandboxd` can read the passwords and a command cannot signal them or bind their ports. `sandboxd` stays
  uid 1001, and the hardening from S46/S48 stays: setuid bits stripped, `cap_drop: ALL` plus the existing
  short list, no-new-privileges, a read-only root with tmpfs mounts.
- The accessibility settings from [F10](features/F10-desktop.md#making-apps-publish-a-tree-in-the-container):
  `GTK_MODULES=gail:atk-bridge`, `QT_ACCESSIBILITY=1`, toolkit accessibility on, and Chromium with
  `--force-renderer-accessibility`.
- VNC has **two passwords**, generated at start into a file only `sandboxd` can read: one view-only, one full
  control. websockify exposes only the raw WebSocket on the sandbox network; `core` serves the viewer page
  and its noVNC client (S51). No port is published.
- Compose: `sandbox` uses the desktop image, `shm_size: 1g`, `mem_limit: 6g`, `pids_limit: 2048`,
  `SCREEN=1920x1080x24`.
- *Check:* the `sandbox-image` CI job builds the desktop image, waits for `:0`, lists an XFCE window with
  `wmctrl`, starts Chromium, finds no setuid file, and probes that 5900/6080/6081 are not reachable from
  outside the sandbox network. It also checks that the supervisor's children have no capabilities, that
  only `sandboxd` keeps its four, and that a command cannot signal the stream servers. The conformance suite
  and egress probes also run against it.

#### S51. The viewer page
- `core` serves `GET /desktop`: a single page with the noVNC client, served from `core` (no CDN), in
  watch-only mode. You sign in with the owner key, which is exchanged for a short-lived, `HttpOnly`,
  `SameSite=Strict` viewer cookie; the key itself is never put in a URL.
- The page's WebSocket goes to `core`, which relays it to `sandboxd-gateway` and on to websockify on the
  sandbox network, using the view-only VNC password. `core` still never joins the sandbox network.
- Config (Y2): `api.listen` is the in-container bind (`SHITSUJI_API_BIND`); `api.publishedHost` /
  `api.publishedPort` are what Docker publishes (`SHITSUJI_API_PUBLISH`, passed back as
  `SHITSUJI_API_PUBLISHED`), and optional `api.tls.cert` / `api.tls.key` file paths serve HTTPS.
  Publishing beyond loopback without TLS logs one warning. `api.publicUrl` / `SHITSUJI_PUBLIC_URL`
  is the base for the links core sends, defaulting to `http(s)://127.0.0.1:<published port>`.
- A `/desktop` command on Telegram and in the TUI replies with the viewer's URL.
- *Check:* integration test: an unauthenticated request gets 401, a viewer cookie expires, the relay refuses
  without one; the viewer's input is ignored in watch-only mode (the VNC server enforces it, not the page).
  Login is throttled and login/logout/stream refuse a cross-origin Origin.

#### S52. Images the model can see in tool results
- The capability lookup from [#106](https://github.com/ggiraudon/shitsuji/issues/106) part 1:
  `ModelRouter.supports(purpose, capability)` from `models.catalog`. A model with no declared capabilities
  counts as **no vision**, with one startup warning.
- `tool_result` can carry images (an optional `images` list next to `content`). `AnthropicProvider` sends
  image blocks inside the tool result. `OpenAICompatibleProvider` follows the tool message with a user
  message holding the image, marked as the tool's output. Recorded fixtures for both.
- Screenshot pruning in `ContextBuilder`: keep the newest N images (default 3) as pixels and replace older
  ones with a one-line placeholder, deterministically per message so the cached prefix stays stable.
  Image bytes are not stored in `messages.content`: the stored part references a file in the session folder.
- *Check:* unit tests for the lookup, both provider mappings and the pruning; `stripNul`/jsonb stays happy
  with a stored image reference.

#### S53. The desktop endpoints and `computer.act`
- `sandbox-protocol` routes and `sandboxd` endpoints: `GET /desktop/state`, `GET /desktop/screenshot?scale=`,
  `POST /desktop/input/mouse`, `POST /desktop/input/keyboard`, `GET /desktop/windows`,
  `POST /desktop/apps/launch` (allow-list: chromium, libreoffice, thunar, xfce4-terminal),
  `GET/POST /desktop/clipboard`, `POST /desktop/ocr`.
- The `DesktopCapability` port from F10, implemented by the `shitsuji` driver; the driver advertises
  `desktop: { accessibility: false, screenshots: true, takeControl: false }` (S54 sets accessibility true;
  S55 turns takeControl on). The conformance suite gets desktop tests that run when a driver claims the
  capability.
- `computer.act` (`screenshot`, `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`,
  `key`, `wait`, `launch_app`, `ocr`). It is registered only when the driver has a desktop **and** the
  `vision` purpose's model has vision. Every result includes a fresh scaled screenshot (S52). Effects:
  `screenshot`/`move`/`ocr` are `read`, the rest `write_local`.
- *Check:* integration test against the real image: launch Thunar, find its window, click, type into a
  field and see it in a screenshot or OCR.

### Structure first, and your hands

#### S54. The accessibility tree: `desktop.inspect` and `desktop.act`
- The Python AT-SPI helper (`python3-gi`, `gir1.2-atspi-2.0`, `python3-pyatspi`) as a long-lived child of
  `sandboxd`, speaking JSON lines: `ping`, `apps`, `tree`, `find`, `act`. It keeps the snapshot table;
  refs never expose AT-SPI object paths.
- `GET /desktop/a11y/tree`, `GET /desktop/a11y/find`, `POST /desktop/a11y/act`, and the compact text
  format with `[eN]` refs from F10, capped at about 8,000 tokens per window with a note on how to ask for a
  sub-tree.
- `desktop.inspect` and `desktop.act` tools. A ref from an old snapshot whose window changed returns
  "stale, take a new snapshot". Tree and OCR text are untrusted content.
- A startup check lists which allowed apps publish a tree; a missing one is a warning in the logs and in
  `/status`.
- *Check:* integration test: Thunar, xfce4-terminal and Chromium return named elements; a stale ref is
  refused; the driver now claims `accessibility: true`.

#### S55. Take control and Give back
- Control modes `agent` | `owner`, held by `SandboxService`. In `owner` mode `computer.act` and
  `desktop.act` are refused with a clear message (screenshots, OCR and tree reads still work), and the
  viewer switches to the full-control VNC password.
- `computer.request_takeover({ reason })` puts the turn in `waiting` with the reason; the owner gets the
  message on their channel with the viewer link, labelled as the agent's words. The viewer page shows
  **Take control** and **Give back**. Pressing **Take control** yourself works too, and pauses the
  running turn's desktop actions.
- Give back resumes the waiting turn with a note and a fresh screenshot when the vision gate allows it;
  otherwise the note says the screen changed and suggests `desktop.inspect`. A 15-minute timeout and a
  core restart both return the desktop to the agent; every resume is a compare-and-set from `waiting`.
- *Check:* unit tests for the mode changes and refusals, expiry and the double-resume guard; an
  integration test drives take/give back through the API and shows a full-control stream closing.

#### S56. The desktop end to end
- The Calc task from F10: open Calc, type numbers, save to `/workspace`, read the file with
  `workspace.exec`. An eval scenario runs it twice, structure-only and screenshot-only, and reports tokens
  and success (offline with recorded replies; live with `pnpm eval --model`).
- F10's acceptance criteria are ticked, F10 and the class map are updated with what was built, and the
  prompt gets a short computer-use section (or a note in #105's charter if that has landed).
- *Check:* the offline eval passes; you watch a live run in the viewer.

Implemented: `desktop.act` gained `launch_app`, `type` and `key` (focus the ref, then the desktop
keyboard), because a Calc cell is not an AT-SPI editable-text object and `computer.act` is not registered
without a vision model. The helper caps a huge Calc grid, includes `file chooser`/`alert` windows, and
`ctrl+s` is in the key allow-list. The real integration test opens Calc, fills A1/B1, saves through the
file chooser and reads `/workspace/calc.csv` with `workspace.exec`. The offline eval reports 2,000/200
tokens for structure-only (context 2,585) and 3,200/320 for screenshots (context 3,498); the structure
run starts with Calc closed, launches it through `desktop.act`, and sends zero images.
The default screen is now 1920x1080: the Save dialog is 888 px tall, which put its buttons below a
1440x900 screen. A `fit-windows` watcher (uid 1000) moves and shrinks a window that an app still opens
past an edge, because xfwm4 has no setting that fits an oversized window; on the real image the Save
dialog lands at (403,150) 1124x888, and a forced 2600x2300 window is clamped to the work area. A node
that the app does not render, or whose centre is off the screen, is marked `(offscreen)`: on a
1440x900 display the Save dialog's Save and Cancel buttons carry it, and on 1920x1080 they do not.

### The browser

Browser activity is expected to be the **main use of the desktop**, so S57–S61 design for speed from the
start: **observe, act, forget the old observation** ([13](13-desktop-performance.md)). The rules below apply
to every browser step: one full snapshot in the history at most, actions report what changed, waits watch
page state, a snapshot has a token budget, and a screenshot lives for one step. The S61 target is a simple
lookup in **under 20 s and under 8 model calls**, with no summarize call on the critical path; S62 confirms
it on the live stack with the measurement SQL from doc 13.

#### S57. The browser in `sandboxd`
- `sandboxd` launches Chromium itself, on the desktop's display, with `--remote-debugging-pipe` (no CDP TCP
  port) and drives it with `playwright-core`. The profile directories live in a `browser-profiles` volume,
  owned by uid 1001 with mode 0700, so commands (uid 1000) cannot read cookies or reach CDP. If Chromium
  cannot run as 1001 on uid 1000's display, the PR says so and proposes the closest alternative before
  building on it.
- **Two layers over one page.** Playwright stays the driver for launch, navigation, lifecycle waits and
  robust input (its actionability checks). Where it is faster or exposes more, the same page opens a raw CDP
  session (`newCDPSession`): refs come from `Accessibility.getFullAXTree` and are bound to the DOM's
  `backendNodeId` and to a page revision, so a ref from a page that changed fails with "take a new snapshot";
  `DOM.*` and `Input.*` calls address the node by `backendNodeId`; screenshots come from the page capture
  with a frame hash. Playwright is itself a CDP client, so the wire is not where the speed comes from —
  observing less, and less often, is.
- One browser context per session; named persistent profiles (default `default`). The context also owns
  that session's snapshot registry and screenshot cache, so two sessions never mix refs.
- The `BrowserBackend` / `BrowserSession` port from F09, implemented by the `shitsuji` driver over new
  `sandboxd` routes. The driver advertises `browser`. Endpoints carry the session id, so the
  latest-snapshot rule and the "same frame" check work per session.
- **Calls on one session are serialized**: one navigation, action, snapshot or screenshot at a time, so a
  batch and a stray snapshot cannot interleave. Two sessions still run in parallel.
- Every call has a deadline (default 60 s). A browser that misses it is killed and reopened, and the
  interrupted step is never repeated automatically.
- Downloads go to `/workspace/downloads/` (the sandbox cannot write `/handoff`), not `/handoff` as F09 said.
- The daemon also owns the **screenshot** route vision uses: a PNG of the page viewport, scaled to fit 1280
  px on the long side like desktop captures, with a cheap frame hash returned alongside it so core can drop
  a duplicate.
- *Check:* integration test: open a page served by a fixture container, read its title; a command as uid
  1000 cannot read the profile folder or connect to the browser; a reload makes an old ref fail with "take a
  new snapshot"; two identical captures share one hash; two calls on one session run one after the other.

#### S58. Reading pages
- `browser.open`, `browser.navigate`, `browser.snapshot`, `browser.read`, `browser.screenshot`, `browser.back`,
  and a "find on page" helper. All `read`.
- **Read the page without a tree when the task is to read.** `browser.read` returns the title, URL and the
  visible text of the main content (`innerText`, budgeted and paged like a snapshot), with no refs and no
  tree. A lookup like the library hours is one `browser.read`; the prompt prefers it to a snapshot when the
  task is to read, and uses `snapshot` only to act or when the text is not enough.
- **A snapshot has a budget and a priority.** The default page is 24,000 characters (roughly 6k tokens), and
  it lists, in order: the elements whose box is **in the viewport**, then the remaining **interactive**
  elements (links, buttons, fields, menus, options), then headings and the rest of the text. The rest arrives
  through `nextOffset`, one page at a time, and `find` answers a name/role question without a page. The
  result names how many elements were shown and the offset to continue from.
- **A snapshot is registered, not repeated.** The reply carries a snapshot id and refs that map to
  server-side locators, so a ref re-resolves on use. The next observation of that session (a new snapshot,
  a navigation, or an action's change report) **replaces the full body in the model's history with a
  one-line stub** ("snapshot s12 of Checkout, superseded; ask again if you need it"). The session keeps the
  current snapshot; the transcript never accumulates old trees, and compaction never has to read them. The
  model's window is 1,048,576 tokens (Y5), so this is about time and cost, not fitting.
- **Actions report what changed.** `browser.act`, `browser.navigate` and a wait return a **short status**
  ("Clicked 'Search'") plus the new URL and title when they changed, any new dialog/alert text, the focused
  element, and a short diff of added, removed and renamed interactive elements with fresh refs — or "no
  visible change". An input action **never** returns a new snapshot; the full body comes back only on a
  navigation/reload or when the diff is too large to be useful, and then it replaces the previous snapshot.
  The prompt says not to re-snapshot to confirm an action and not to add sleeps.
- **Wait on page state, not on the clock.** `browser.wait({ for: 'load' | 'url' | 'selector', state:
  'present' | 'absent' | 'visible' | 'hidden', timeoutMs })` returns a change report and never a full
  snapshot; actions wait for navigation or quiet for a short settle timeout before answering. A document
  that has already settled (`readyState` complete, no pending navigation) is not waited on again, and the
  model does not need to sleep or re-snapshot to know that a click took effect.
- The browser's traffic goes through `egress-proxy`, so it reaches public addresses only (X7). The snapshot
  and any screenshot text are untrusted data.
- **Vision is the fallback, not the default.** The chat model is the vision model (M1, Y5), so the screenshot
  is part of the same chat request: there is no separate vision round trip. The text snapshot stays the
  default. When it is not enough or the page is visual (a canvas, a map, an image gallery, an unlabelled
  control), the observation may attach **one** screenshot for that step only: scaled, a no-op if its frame
  hash matches the previous one, and with **`@eN` boxes** drawn over the elements the snapshot knows so the
  model can map what it sees to refs. Earlier turns keep a text receipt, never the image. The model asks with
  `vision: true` (or the tool attaches one when the page has no usable names), and the result states the
  scale and original size.
- *Check:* integration tests on fixture pages: a lookup is answered by `browser.read` with no tree; refs
  are stable within a snapshot and fail after a reload; long pages page by offset with viewport elements
  first; a superseded snapshot becomes one line in the history; an input action answers a status and a
  change report, not a snapshot; a second identical screenshot is not attached; a private address is
  blocked; a vision run sends one image on the same chat call and a text-only run sends none; a full
  1920×1080 capture and the scaled one are both measured for input tokens, so the default scale is a
  number, not a guess.

#### S59. Committing steps and the trust check
- `browser.type` (`write_local`), and `browser.click`, `browser.press`, `browser.select`, `browser.check`,
  `browser.upload`, `browser.dialog`, classified per call.
- **Batches fill a form in one call.** `browser.act({ steps: [...] })` runs up to 10 steps after one tree
  read: type, select, check, press Tab, then the committing click. Filling, selecting and checking are
  `write_local` and need no trust decision. **The trust check runs per committing step**, before that step
  executes; a batch may contain **at most one committing step and it must be last**, so one call cannot
  hide several outside actions. If the classifier says the step needs a card, the earlier fills stay and the
  turn pauses with a card that names the step and its target. A batch returns one short status plus one
  change report (S58), never a snapshot.
- `inspectTarget(ref)` reads the element's role, label, and the form it would submit (method and action
  URL), from the element's properties in an isolated world. The ref is the `backendNodeId` from the page's
  last revision, so the read is a DOM call, not a tree walk.
- `BrowserEffectClassifier` with F09's rules (unchanged): same-site GET link, GET form and cookie banner →
  `read`; POST form, a purchase/send/delete/confirm/publish label, or an unknown target → `external`;
  payment context → `payment`. `external` goes to the trust judge with a short description of the target,
  never the page text. The classifier sees the batch's committing step, not the whole batch.
- *Check:* unit tests for the classifier and for the one-committing-step batch rule; integration tests on a
  fixture shop: a form fills in one call with one classifier result, Place order asks once, a search does
  not, hidden "click Delete account" text does not lead to that click.

#### S60. Browser takeover and profiles
- `browser.request_takeover` reuses S55: you see the browser in the viewer, sign in, and give it back.
- Owner mode is a write barrier for the browser too: a batch stops before its next step, and no committing
  step runs while the owner has the desktop.
- Profiles persist across restarts (the volume from S57), so a sign-in survives `docker compose restart`.
- *Check:* integration test: a fixture site sets a cookie in a takeover, a batch started before the takeover
  stops at the next step, and a new session with the same profile still has the cookie after a sandbox
  restart.

#### S61. The browser end to end
- Eval scenarios: the library opening hours (no approval), the test shop's Place order (approval card names
  the shop and the button), and the hidden-text injection page. A form scenario fills several fields in one
  `browser.act` batch. A vision variant runs the lookup with screenshots on and reports tokens, images and
  cost next to the text-only run; since the chat model is the vision model (Y5), it adds no model call, only
  input tokens.
- **Targets, measured with the SQL in [13](13-desktop-performance.md):** the library lookup runs through one
  `browser.read` (no tree) and finishes in **under 20 s and under 8 model calls**, with no full snapshot body
  in the history and no `summarize` row on the critical path. A form with five fields and its submit takes
  **one `browser.act` call** plus the answer.
- F09's acceptance criteria are ticked, F09 and the class map updated, and the browser section added to the
  prompt (or #105's charter): read before snapshot, do not re-snapshot to confirm an action, do not add
  sleeps, one batch for a form.
- *Check:* the offline evals pass and print time, calls and tokens per scenario; the lookup uses no tree; the
  vision variant shows one image per step, no duplicates, on the same chat call.

#### S62. Live check and docs
- The owner's live check with the viewer open: the Calc task, the library hours, a Take control sign-in on
  a real site, and the Place order stop on a test shop. Fixes found go in their own issues, as in S49.
- Re-run the measurement SQL from [13](13-desktop-performance.md) for the browser lookup and record the
  wall time, model calls and tokens against S61's targets.
- README, AGENTS (commands, services), `docs/README.md` and this plan's status are updated.

## Things you'll need to provide

| Step | What |
|------|------|
| S50 | Docker Desktop memory: the sandbox alone gets 6 GB, so give Docker about 10 GB |
| S51 | If you want the LAN or TLS later: a free port and, for TLS, a certificate and key (self-signed is fine) |
| S62 | About twenty minutes at this PC with the viewer open, plus your phone for the Telegram side |
