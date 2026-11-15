# F10 — Desktop environment and computer use

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 2 Own computer | 11 | L | F05, F11 | F09, F20 |

## What it is

The agent's **own graphical computer**: a container running a Linux desktop (XFCE) on a virtual display, with
Chromium, a file manager, LibreOffice and a terminal. A **desktop daemon** gives the agent screenshots, mouse
and keyboard ("computer use"), and noVNC lets you watch or **take control** from the web UI. The browser
([F09](F09-browser.md)) runs on this desktop, so you can see what it does.

## Inspiration

- **openfuse:** a `ComputerBackend` interface with a Docker implementation and an **E2B desktop**
  implementation (Xfce, Firefox, Chrome, LibreOffice) with a VNC stream; GUI apps can be started from the
  terminal with `DISPLAY=:0`; the stream URL is a bearer secret.
- **OpenMausBot:** each bot gets a managed, hardened **Cua container** with a Linux desktop it can see and
  control; noVNC bound only to a random `127.0.0.1` port; the tunnel closes soon after you hand control back.
- **openbot:** Computer Use through a driver daemon exposed as one MCP server to every agent; the app draws the
  agent cursor itself.
- **nod:** headed Chromium on a private 1920×1080 virtual display; live JPEG frames for hand-off.

### How they read the screen

| Project | Web pages | Desktop apps |
|---------|-----------|--------------|
| nod | Browser accessibility snapshot | No desktop control; the display only hosts the browser |
| openfuse | Browser worker | **Screenshots only**: `xdotool` input, a `scrot` JPEG after every action |
| openbot | Browser accessibility snapshot over CDP | On your own Mac: `cua-driver`, which returns the **macOS accessibility tree** with element indices you act on. In its Linux container: screenshots and input on an Xvfb display (its docs don't mention AT-SPI) |
| OpenMausBot | `Accessibility.getFullAXTree` over CDP, plus page captures | On your own Mac: `cua-driver` with **accessibility element paths preferred over pixels**, which also work on hidden windows. Its "saved steps" replay finds targets by app, window title and accessibility label, never by pixel. Its cloud Linux desktop: **screenshots only** (the tool list has no tree) |

So the pattern is clear: **both projects that went furthest use the accessibility tree first, but only on
macOS.** On Linux containers, everyone falls back to screenshots. Using AT-SPI inside our desktop container
would be new ground among these four, but it is the same idea they already rely on elsewhere.

## Design

### Container

```yaml
desktop:
  build: ./containers/desktop        # Debian + Xvnc + XFCE + D-Bus/AT-SPI + Chromium + noVNC + daemon
  user: "1000:1000"
  init: true
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  shm_size: 1g                       # Chromium needs it
  mem_limit: 4g
  cpus: 2
  pids_limit: 2048
  volumes:
    - desktop-home:/home/agent       # browser profiles, desktop settings
    - handoff:/handoff
  networks: [sandbox]                # internet only through egress-proxy, tunnel-only mode (F12)
  environment:
    DESKTOP_TOKEN: ${DESKTOP_TOKEN}
    SCREEN: 1440x900x24
```

Processes inside, started by a small supervisor (s6 or supervisord):

| Process | Listens on (sandbox network only) | Purpose |
|---------|-----------------------------------|---------|
| `Xvnc` (TigerVNC) or `Xvfb` + `x11vnc` | VNC 5900 | Virtual display `:0` |
| `dbus-daemon --session` + `at-spi2-registryd` | — (in-container only) | Accessibility bus the apps publish their trees on |
| `xfce4-session` | — | Window manager and desktop |
| `chromium --remote-debugging-port=9222 --force-renderer-accessibility` | CDP 9222 (bound to the sandbox interface) | The agent's browser ([F09](F09-browser.md)) |
| `websockify` + noVNC | 6080 | Browser-based remote view, proxied by `core` |
| `desktop-daemon` (+ AT-SPI helper) | 8700 | Accessibility tree, screenshots, OCR, input, window list, app launch, clipboard |

`core` **proxies** noVNC and CDP; neither port is published to the host. You reach the desktop only through
`core`'s authenticated web UI.

### Desktop daemon API

| Endpoint | Action |
|----------|--------|
| `GET /screenshot?scale=` | PNG/JPEG of the screen (scaled for the model) |
| `POST /input/mouse` | move, click (left/right/double), drag, scroll at coordinates |
| `POST /input/keyboard` | type text, key combos |
| `GET /windows` | open windows with titles and geometry (`wmctrl`) |
| `GET /a11y/tree?window=&depth=&filter=` | AT-SPI tree of a window as compact text with element refs (see below) |
| `GET /a11y/find?name=&role=` | Elements matching a name or role, across windows |
| `POST /a11y/act` | Run an action on an element ref: `click`, `focus`, `set_text`, `select`, `toggle`, `expand` |
| `POST /ocr` | Text and boxes from a screen region (Tesseract), for apps with no tree |
| `POST /apps/launch` | start an allowed app (`chromium`, `libreoffice`, `thunar`, `xfce4-terminal`) |
| `GET/POST /clipboard` | read / write the clipboard (`xclip`) |
| `GET /frames` (WebSocket) | low-rate JPEG frames for thumbnails |

Implemented with `xdotool`, `scrot`/`import`, `wmctrl`, `xclip`, AT-SPI and Tesseract.

### Reading the screen: structure first, pixels last

X11 does not carry readable text for modern apps: GTK, Qt and Chromium draw glyphs or whole images
themselves. The reliable source of on-screen text is the **accessibility layer** that screen readers use. On
Linux that is **AT-SPI**, a service on the session D-Bus. Apps publish a tree of elements (window → panel →
button "Save", text field "Cell A1" = "42"), each with a role, a name, a value, states (focused, checked,
enabled), a screen position and the actions it supports.

The agent uses three levels, in order:

| Level | Source | Good for | Cost |
|-------|--------|----------|------|
| 1 Browser structure | CDP accessibility snapshot ([F09](F09-browser.md)) | Web pages | Low: text only |
| 2 Desktop structure | AT-SPI tree from the desktop daemon | GTK/Qt apps: LibreOffice, file manager, settings, terminal | Low: text only, exact click targets |
| 3 Pixels | Screenshot read by the vision model, with OCR text and boxes as a hint | Apps with a missing or broken tree, canvases, games, images | High: image tokens, coordinate guessing |

The prompt piece for computer use says so, and the tool results nudge it: a `computer.act` click on a point
that lies inside an element the tree knows returns a note with that element's ref.

#### Element refs

The tree is sent to the model as compact indented text, not JSON, limited to the interesting nodes (no empty
panels or decorative containers), with a ref for each actionable element:

```text
window "Untitled 1 - LibreOffice Calc" [w1]
  menu bar
    menu "File" [e3]  menu "Edit" [e4]  …
  toolbar "Standard"
    push button "Save" [e12]  push button "Undo" [e13] (disabled)
  text "Name Box" [e20] = "A1"
  table "Sheet1"
    cell "A1" [e31] = "42"  cell "B1" [e32] = ""
```

Refs belong to a **snapshot**: `a11y.act({ snapshot, ref, action })` re-resolves the element and refuses with
"stale, take a new snapshot" if the window changed underneath (openbot and OpenMausBot do the same with their
snapshot ids). Refs never leak raw AT-SPI object paths to the model.

The tree is capped (default about 8,000 tokens per window); the result says how to ask for a sub-tree when
it is cut, as openbot does when its 190 KB trees come back.

#### Making apps publish a tree in the container

Accessibility is often off unless something asks for it. The desktop image:

- runs a **session D-Bus** and `at-spi2-core` (the registry daemon) under the supervisor, before XFCE starts;
- sets `GTK_MODULES=gail:atk-bridge` and `NO_AT_BRIDGE=0` for GTK apps, and `QT_ACCESSIBILITY=1` /
  `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` for Qt apps;
- turns on the "toolkit accessibility" setting in the XFCE / GNOME settings store
  (`org.gnome.desktop.interface toolkit-accessibility true`);
- starts Chromium with `--force-renderer-accessibility` so web content also appears in the tree (useful for
  Electron apps, which have no CDP of their own);
- starts LibreOffice with its accessibility bridge enabled (it uses the GTK VCL plugin in this image).

A startup check lists the apps that publish a tree, so a missing one is a visible warning, not a silent
fall-back to pixels.

#### Reading AT-SPI from the daemon

The daemon is TypeScript like the rest of the monorepo, but AT-SPI has no well-maintained Node binding.
Proposal: a **small Python helper** (`python3-gi` + `gir1.2-atspi-2.0`, both Debian packages) that the daemon
starts once and talks to over stdin/stdout with JSON lines: `tree`, `find`, `act`. It keeps the snapshot
table and resolves refs. The alternative, speaking the AT-SPI D-Bus interfaces directly from Node with a
D-Bus library, avoids Python but means re-implementing what `libatspi` already does. Start with the helper;
it stays behind the daemon API, so it can be swapped.

#### Safety

- Text from the tree and from OCR is **untrusted content** ([F11](F11-trust-and-approvals.md)), exactly like
  web pages: a document open in LibreOffice can contain instructions aimed at the agent.
- `a11y.act` has the same effects as the matching `computer.act` call: `click` and `set_text` are
  `write_local`; a click on a button whose name looks like an outside action ("Send", "Pay", "Delete") in a
  browser is judged by the [F09](F09-browser.md) rules.
- The helper can only see apps on the container's own session bus, never the host.

### Port and adapters

```ts
export interface ComputerBackend {
  readonly id: string;                                   // "docker-desktop", "e2b", "remote-vm"
  state(): Promise<ComputerState>;                       // stopped / starting / ready / busy / owner_control
  screenshot(opts?: { scale?: number }): Promise<Image>;
  act(action: ComputerAction, signal: AbortSignal): Promise<ActionResult>;
  liveView(): Promise<LiveViewTicket>;                   // short-lived, owner-scoped URL
  setControl(mode: 'agent' | 'owner' | 'shared'): Promise<void>;
}
```

`DockerDesktopBackend` is the first adapter. The port leaves room for `E2BDesktopBackend`, a VM on your own
server, or (much later, opt-in) your real desktop.

### Computer-use tool

Two tools, matching the levels above:

- `desktop.inspect({ window?, find?, depth? })` returns the AT-SPI tree or matching elements, with refs, and
  `desktop.act({ snapshot, ref, action, text? })` acts on an element. After an action, the result holds the
  changed part of the tree (and a small screenshot only if asked for).
- `computer.act` with actions `screenshot`, `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`,
  `type`, `key`, `wait`, `launch_app`, `ocr`. The result always includes a fresh scaled screenshot, so the
  model sees the effect.

- Needs a **vision-capable model**; the router selects `purpose: vision` ([F03](F03-model-providers.md)).
  DeepSeek V4.1 Flash accepts images, so computer use can run on the same model as chat. Keeping
  `purpose: vision` separate still lets you point it at a stronger or local vision model later without
  touching the chat setup.
- **Prefer structure over pixels.** Browser tools ([F09](F09-browser.md)) for web pages, `desktop.inspect` /
  `desktop.act` for desktop apps; `computer.act` only when neither tree can drive what is on screen.
- **Effects:** `screenshot` and `move` are `read`; clicks and keys are `write_local` inside the desktop, but a
  click in the browser on a submit control is judged by the browser rules in [F09](F09-browser.md).
- **Screenshot pruning:** keep only the last N screenshots in context (nod: above twelve, drop the oldest in
  steps of eight, which keeps prompt caching stable).

### Take control

1. The agent calls `computer.request_takeover({ reason })` (or you press **Take control**).
2. The desktop goes to `owner` mode: the agent's input calls are refused; the web UI's noVNC canvas becomes
   interactive.
3. You sign in, solve the CAPTCHA, or fix something; then press **Give back**.
4. The waiting turn resumes with a note of what changed (new screenshot).

From Telegram, the agent sends a "Take control" link that opens the web UI on that screen.

## Workspace or desktop?

They are separate containers with different jobs:

| | Workspace ([F08](F08-workspace-sandbox.md)) | Desktop |
|-|-----------|---------|
| Purpose | Code, data, files, CLI tools | GUI apps and the browser |
| Speed | Fast, cheap to run | Heavier (X server, Chromium) |
| Self-authored tools | Scripts and programs ([F20](F20-tool-forge.md)) | Desktop automations (AT-SPI or `xdotool` scripts, browser scripts) |
| Shared | `/handoff` volume | `/handoff` volume |

A forged tool declares which one it runs in.

## Acceptance criteria

- `docker compose up` starts the desktop; the web UI shows it live.
- The agent opens LibreOffice Calc, types numbers, saves a file to `/handoff`, and the workspace can read it.
- The same Calc task completes **using only `desktop.inspect` / `desktop.act`**, with no screenshot sent to
  the model; an eval ([F22](F22-observability-and-cost.md)) compares its tokens and success rate with the
  screenshot-only run.
- `desktop.inspect` on Thunar, the XFCE terminal and Chromium returns named elements; the startup check
  reports any allowed app that publishes no tree.
- Acting on a ref after the window changed returns "stale" instead of clicking the wrong thing.
- Take control / Give back works and the agent continues.
- No desktop port is reachable from the host or LAN without going through `core`.

## Risks and open questions

- **Resource use.** A desktop plus Chromium wants 2–4 GB RAM. Allow stopping it when idle and starting on
  demand (`ComputerBackend.state()` + an idle timer).
- **Pixel-based control is slow and error-prone** with today's models; treat it as the fallback, not the main
  path.
- **Tree quality varies by app.** GTK and Qt apps are usually good; XFCE panel applets, some Electron apps
  and anything drawn on a canvas may be thin or empty. LibreOffice's Calc grid can be very large: read only
  the visible cells. Measure this early with the startup check rather than assuming.
- **XFCE vs GNOME.** XFCE is light, but most AT-SPI testing happens on GNOME. If too many apps misbehave,
  try a minimal GNOME Flashback or MATE session before giving up on the tree.
- **Image choice.** Build our own Debian image (full control) versus starting from a maintained desktop image
  (faster). Proposal: own Dockerfile, pinned package versions.
