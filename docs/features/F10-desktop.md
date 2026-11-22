# F10 — Desktop environment and computer use

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 2 Own computer | 11 | L | F05, F11 | F09, F20 |

## What it is

The agent's **own graphical computer**: a Linux desktop (XFCE) on a virtual display, with Chromium, a file
manager, LibreOffice and a terminal. It is the **desktop capability of a sandbox driver**
([F08](F08-workspace-sandbox.md), decisions W1–W3): with the `shitsuji` driver it is the
`shitsuji/sandbox-desktop` image, the same `sandbox` container as the workspace with a desktop layer on top, so
commands and GUI apps share one filesystem. `sandboxd` gains the desktop endpoints, giving the agent the
accessibility tree, screenshots, mouse and keyboard ("computer use"), and noVNC lets you watch or **take
control** from the web UI. The browser
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
macOS.** On Linux containers, everyone falls back to screenshots. Using AT-SPI inside our desktop layer
would be new ground among these four, but it is the same idea they already rely on elsewhere.

## Design

### The desktop layer

The `sandbox` service from F08, switched to the desktop image. Only the differences are shown:

```yaml
sandbox:
  image: shitsuji/sandbox-desktop    # FROM shitsuji/sandbox + Xvfb/x11vnc + XFCE + D-Bus/AT-SPI + Chromium + LibreOffice
  shm_size: 1g                       # Chromium needs it
  mem_limit: 6g                      # workspace and desktop together
  pids_limit: 2048
  environment:
    SCREEN: 1440x900x24
```

Processes inside, started by **supervisord** (Debian's `supervisor`; s6-overlay would add a tarball and a
root init for no extra benefit, and Compose's `init: true` already reaps zombies):

| Process | Runs as | Listens on | Purpose |
|---------|---------|-------------|---------|
| `dbus-daemon --session` + `at-spi2-registryd` | 1000 | — (in-container only) | Accessibility bus the apps publish their trees on |
| `Xvfb :0` | 1000 | — | Virtual display `:0` |
| `xfce4-session` | 1000 | — | Window manager and desktop |
| `x11vnc` (full) | 1001 | `127.0.0.1:5900` | VNC with the full-control password |
| `x11vnc -viewonly` | 1001 | `127.0.0.1:5901` | VNC with the view-only password |
| `websockify` | 1001 | sandbox network 6080 | Raw WebSocket for full control |
| `websockify` | 1001 | sandbox network 6081 | Raw WebSocket for watch-only |
| `chromium --remote-debugging-pipe --force-renderer-accessibility`, launched by `sandboxd` | 1000 | — (a CDP pipe to `sandboxd`, no port; Y3) | The agent's browser ([F09](F09-browser.md)) |
| `sandboxd` desktop endpoints | 1001 | 4555 (the same daemon as F08) | Screenshots, OCR, input, window list, app launch, clipboard, the tree routes |
| the AT-SPI helper, a child of `sandboxd` | 1000 | — (the session bus) | Reads the accessibility tree the desktop apps publish (S54) |

Xvnc serves one password and one mode. Two passwords (view-only and full control) therefore need two VNC
servers on one display, so the image uses Xvfb plus two `x11vnc` instances. The two x11vnc servers and the
two `websockify` instances run as uid 1001: the passwords are generated at start into `/run/sandbox`
(0700) as 0400 files owned by 1001, and a command (uid 1000, no capabilities) must not be able to read
them, signal the stream servers or bind their ports. `sandboxd` (1001) reads the passwords for the viewer.
The VNC servers bind loopback; websockify is the only network-facing part. The passwords are new on every
container start.

No desktop port is published to the host. You watch through `core`'s authenticated viewer page at
`/desktop` (decision Y1; the web UI of [F07](F07-web-ui.md) absorbs it later): `core` serves the page and
its bundled noVNC client, and relays the raw WebSocket through `sandboxd-gateway` to websockify, with the
view-only VNC password until you take control. CDP stays inside the container (Y3). The viewer is on
`127.0.0.1` by default; it can be published on your LAN, with optional TLS (Y2).

### The S50 image

`docker/sandbox-desktop` is `FROM shitsuji/sandbox`, so the workspace, the Python venv, the token rules
and the capability split stay exactly as F08 built them; only a desktop layer is added. Build order
matters: build and tag `shitsuji/sandbox` first, which Compose does with its `sandbox-base` service.

- Package list (no recommends): XFCE, Xvfb and x11vnc, D-Bus and AT-SPI (`python3-gi`,
  `gir1.2-atspi-2.0`, `python3-pyatspi`), Chromium, LibreOffice with the GTK VCL plugin, Thunar,
  xfce4-terminal, `xdotool`, `wmctrl`, `xclip`, `scrot`, websockify, plus x11-utils. The noVNC client
  is not in the image: `core` serves it with the viewer page (S51).
- The base entrypoint still runs first as root (token, workspace repair, venv) and then execs
  `sandbox-desktop`, which generates the VNC passwords and starts supervisord. sandboxd is started by
  the supervisor as uid 1001 with the same four ambient capabilities; the desktop programs are uid
  1000. Only the stream servers (x11vnc and websockify) are 1001, so commands cannot read the
  passwords or take over the ports.
- Hardening is unchanged: setuid bits are stripped again after the desktop packages, `cap_drop: ALL`
  plus CHOWN/FOWNER/SETUID/SETGID/SETPCAP/KILL, `no-new-privileges`, a read-only root with `/tmp` and
  `/run/sandbox` as tmpfs, and no published port.
- Compose gives the service `shm_size: 1g`, `mem_limit: 6g`, `pids_limit: 2048` and
  `SCREEN=1440x900x24`. The `sandbox-image` CI job waits for `:0`, lists an XFCE window, starts
  Chromium, checks that no setuid file remains and that 5900/6080/6081 are unreachable from the host,
  checks that the supervisor's children keep no capabilities and that a command cannot signal the
  stream servers, and the conformance suite and egress probes also run against the desktop image.

### The S51 viewer

`core` serves the viewer itself; the sandbox only exposes the raw view-only stream.

- `GET /desktop/login` is a small form. `POST /desktop/login` takes the owner key in the body (never a
  query string), checks it with the same verifier as the API, and sets `shitsuji_viewer`: an
  `HttpOnly`, `SameSite=Strict`, `Path=/desktop` cookie, `Secure` when TLS is on, valid for one hour
  and bound to the owner. `GET /desktop` and `GET /desktop/credentials` answer 401 without it;
  `POST /desktop/logout` clears it.
- The page uses the pinned `@novnc/novnc` client served by core (no CDN). After the cookie check it
  fetches `GET /desktop/credentials`, which asks sandboxd's token-protected
  `GET /desktop/viewer-credentials` for the view-only password. The full-control password never
  leaves the sandbox until S55's owner mode; it has its own core-only route and only
  `GET /desktop/credentials` returns it, to this cookie-gated page (S55).
- `GET /desktop/stream` is a WebSocket, cookie-gated on the upgrade. Core connects to the
  `sandboxd-gateway`'s view-only listener on 6081 as a WebSocket client and bridges the frames; the
  gateway's second listener forwards to websockify's 6081 view-only stream. Core never joins the
  sandbox network. In owner mode the page opens `?control=full`, which core relays through the
  gateway's 6080 listener; `POST /desktop/take` and `/desktop/give-back` need the same cookie and
  `Origin` check as login, and Give back closes every open full stream at once (S55).
- `POST /desktop/login` is throttled: after five wrong keys from one address in five minutes it
  answers 429 until the window ends and logs once. Login, logout and the stream upgrade also reject a
  cross-origin `Origin` when one is present.
- Config (Y2): `api.listen` is the in-container bind (`SHITSUJI_API_BIND`); `api.publishedHost` /
  `api.publishedPort` describe what Docker publishes (`SHITSUJI_API_PUBLISH` /
  `SHITSUJI_API_PUBLISHED`). The warning follows the published host, so the default Compose
  `0.0.0.0` inside the container with a loopback published port stays quiet. `api.tls.cert` /
  `api.tls.key` serve HTTPS when both are set.
- `api.publicUrl` (`SHITSUJI_PUBLIC_URL`) is the base for every link core sends; it defaults to
  `http(s)://127.0.0.1:<published port>`. `/desktop` on Telegram and in the TUI replies with
  `api.publicUrl` + `/desktop`.

### Desktop endpoints of sandboxd

| Endpoint | Action |
|----------|--------|
| `GET /desktop/state` | display, width and height |
| `GET /desktop/screenshot?scale=` | PNG of the screen, scaled for the model |
| `POST /desktop/input/mouse` | move, click (left/right/double), drag, scroll at coordinates |
| `POST /desktop/input/keyboard` | type text, key combos |
| `GET /desktop/windows` | open windows with titles and geometry (`wmctrl`) |
| `GET /desktop/a11y/tree?window=&depth=&filter=&ref=` | AT-SPI tree of a window, as structured nodes with element refs (S54) |
| `GET /desktop/a11y/find?name=&role=` | Elements matching a name or role (S54) |
| `POST /desktop/a11y/act` | Run an action on an element ref (S54) |
| `GET /desktop/a11y/status` | Which allowed apps publish a tree, for the startup check and `/status` (S54) |
| `POST /desktop/ocr` | Text from a screen region (Tesseract), for apps with no tree |
| `POST /desktop/apps/launch` | start an allowed app (`chromium`, `libreoffice`, `thunar`, `xfce4-terminal`) |
| `GET/POST /desktop/clipboard` | read / write the clipboard (`xclip`) |
| `GET /desktop/frames` (WebSocket) | low-rate JPEG frames for thumbnails (later) |

S53 implements the state, screenshot, input, window, clipboard, OCR and launch routes. Input coordinates
are bounded by the real screen; keys come from a fixed allow-list and typed text is one argument, never a
shell string. Every desktop command has a deadline and is killed rather than retried. Screenshots are PNG
scaled to fit 1280 px on the long side (the reply carries the scale and the original size), and stay as
S52 image references under `sessions/<sessionId>/images/`; `computer.act` input coordinates are in the
latest scaled screenshot, and the tool maps them back to display pixels.

S54 adds the tree routes and the helper; `core` formats the compact text (about 8,000 tokens per window)
and exposes `desktop.inspect` / `desktop.act`. The driver advertises `accessibility: true` only while the
helper has answered; a sandbox where it cannot start keeps screenshots and `computer.act` but registers
no tree tools.

Implemented with `xdotool`, `ffmpeg` (`x11grab`) for captures, `wmctrl`, `xclip`, Tesseract and the
Python AT-SPI helper. Screenshots and OCR frames travel over pipes; the daemon never writes them to a
shared `/tmp` file.

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
window "Untitled 1 - LibreOffice Calc" (libreoffice) — snapshot s3
  menu bar
    menu "File" [e3]  menu "Edit" [e4]  …
  toolbar "Standard"
    push button "Save" [e12]  push button "Undo" [e13] (disabled)
  text "Name Box" [e20] = "A1"
  table "Sheet1"
    cell "A1" [e31] = "42"  cell "B1" [e32] = ""
```

Refs belong to a **snapshot**: `desktop.act({ snapshot, ref, action })` re-resolves the element and refuses
with "stale, take a new snapshot" when the window was created, destroyed or renamed, or when the element's
role, name or value no longer matches the snapshot (openbot and OpenMausBot use their snapshot ids the same
way). Refs map to private child-index paths in the helper; an AT-SPI object path never reaches the model.

The tree is capped at about 8,000 tokens per window; when it is cut, the result names the window and a ref
to continue from: `desktop.inspect({ window, ref, depth })`. `desktop.inspect({ window, find: { name } })`
lists matching elements as a flat list instead, and every match still carries a ref.

#### Making apps publish a tree in the container

Accessibility is often off unless something asks for it. The desktop image:

- runs a **session D-Bus** and `at-spi2-core` (the registry daemon) under the supervisor, before XFCE starts;
- sets `GTK_MODULES=gail:atk-bridge` and `NO_AT_BRIDGE=0` for GTK apps, and `QT_ACCESSIBILITY=1` /
  `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` for Qt apps;
- turns on the "toolkit accessibility" setting in the XFCE / GNOME settings store
  (`org.gnome.desktop.interface toolkit-accessibility true`);
- starts Chromium with `--force-renderer-accessibility` so web content also appears in the tree (useful for
  Electron apps, which have no CDP of their own); the image installs it, and `sandboxd` launches it with
  the flag when F09 needs it (the S50 CI check starts it with the same flag on the display);
- starts LibreOffice with its accessibility bridge enabled (it uses the GTK VCL plugin in this image).

At startup `sandboxd` asks the helper which allowed apps publish a tree. It logs one line per app and a
warning for each missing one; `/status` repeats the live answer, so a missing tree is visible instead of a
silent fall-back to pixels. The check runs again whenever `/status` or the status route asks.

#### Reading AT-SPI from the daemon

The daemon is TypeScript like the rest of the monorepo, but AT-SPI has no well-maintained Node binding. A
**small Python helper** (`python3-gi`, `gir1.2-atspi-2.0` and `python3-pyatspi` in the image) runs as a
long-lived child of `sandboxd` and speaks JSON lines over stdin/stdout: `ping`, `apps`, `tree`, `find`,
`act`. The alternative, speaking the AT-SPI D-Bus interfaces directly from Node with a D-Bus library,
avoids Python but means re-implementing what `libatspi` already does; the helper stays behind the daemon
API and can be swapped.

- **It runs as uid 1000**, not as `sandboxd`'s 1001: the session D-Bus accepts clients of the uid that owns
  the bus, and the desktop session — and its accessibility bus — is uid 1000's. It gets a fixed minimal
  environment (display and bus address, no token and no VNC password), so it cannot read what the daemon
  protects even if a sandbox command signals it. It starts with `python3 -I`, so the uid-1000 user site
  folder, which sandbox commands can write, is never on its import path.
- One request is in flight at a time. Each has a deadline (10 s by default) and its line has a 2 MiB cap;
  every reply is validated with zod, including the node count, names and values. A hung, oversized,
  malformed or internally failed helper is killed, the request in flight fails, and the next request starts
  a fresh process. Nothing is replayed.
- The **snapshot table lives in the helper**, keyed per window. It keeps only private child-index paths and
  the element's role, name and value; a stale check never exposes an object path. The map is bounded, so an
  old snapshot is refused after enough new ones.
- The helper can only see apps on the container's own session bus, never the host.

#### Safety

- Text from the tree and from OCR is **untrusted content** ([F11](F11-trust-and-approvals.md)), exactly like
  web pages: a document open in LibreOffice can contain instructions aimed at the agent. `desktop.inspect`
  and `desktop.act` mark their output untrusted, as `computer.act` does.
- `desktop.act` has the same effects as the matching `computer.act` call: `click` and `set_text` are
  `write_local`; a click on a button whose name looks like an outside action ("Send", "Pay", "Delete") in a
  browser is judged by the [F09](F09-browser.md) rules. Until those rules land, a Chromium click stays
  `write_local` (the recorded gap in [#136](https://github.com/ggiraudon/shitsuji/issues/136)).
- The helper can only see apps on the container's own session bus, never the host. It holds no token and no
  VNC password; a sandbox command that kills it only causes the next request to start a fresh one.

### Port and adapters

The desktop is the `desktop` capability of a sandbox driver ([F08](F08-workspace-sandbox.md#the-driver-port)):
`Sandbox.desktop` implements this interface, and the driver advertises
`desktop: { accessibility, screenshots, takeControl }`. `core` registers `desktop.*` and `computer.*` only when
the active driver has it; `desktop.inspect` and `desktop.act` are registered only when `accessibility` is
true, and the daemon sets that flag from a helper that actually answered.

```ts
export interface DesktopCapability {
  state(): Promise<ComputerState>;                       // stopped / starting / ready / busy / owner_control
  screenshot(opts?: { scale?: number }): Promise<Image>;
  act(action: ComputerAction, signal: AbortSignal): Promise<ActionResult>;
  inspect(request: TreeQuery, signal?: AbortSignal): Promise<Tree>;   // S54
  find(request: FindQuery, signal?: AbortSignal): Promise<Tree>;      // S54
  actOnElement(request: ActRequest, signal?: AbortSignal): Promise<ActResult>; // S54
  accessibilityStatus(signal?: AbortSignal): Promise<A11yStatus>;     // S54
  liveView(): Promise<LiveViewTicket>;                   // short-lived, owner-scoped URL
  setControl(mode: 'agent' | 'owner' | 'shared'): Promise<void>;
}
```

The `shitsuji` driver implements it first. Other drivers can add it later: a VM on your own server, a Windows
or macOS desktop (for example through cua's driver), or (much later, opt-in) your real desktop.

### Computer-use tool

Two tools, matching the levels above:

- `desktop.inspect({ window?, find?, depth? })` returns the AT-SPI tree or matching elements, with refs and
  a snapshot id, and `desktop.act({ snapshot, ref, action, text?, key? })` clicks an element, sets its
  text, types into it, or presses a key. After an action, the result holds a fresh tree and snapshot.
  `type` focuses the ref and sends the characters with the desktop keyboard; `key` presses one of the
  allow-listed chords. This is what commits a Calc cell: the cell itself is not an editable-text
  object, but it accepts typing once focused.
- `computer.act` with actions `screenshot`, `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`,
  `type`, `key`, `wait`, `launch_app`, `ocr`. The result always includes a fresh scaled screenshot, so the
  model sees the effect.

- `computer.request_takeover({ reason })` asks the owner for the desktop and pauses the turn with
  the question and viewer link (S55).
- **Tree registration:** `desktop.inspect` and `desktop.act` are registered only when the active driver
  advertises `accessibility`, which means the helper answered; structure does not need a vision model.
  `desktop.inspect` is `read`, `desktop.act` is `write_local`, and both mark their output untrusted. A
  ref whose window changed is refused with "stale, take a new snapshot" rather than clicked.
- In owner mode `computer.act` keeps only `screenshot` and `ocr`, and `desktop.act` is refused; the
  agent can still read the tree and screenshots.
- Needs a **vision-capable model** for `computer.act`; the router selects `purpose: vision`
  ([F03](F03-model-providers.md)). DeepSeek V4.1 Flash accepts images, so computer use can run on the same
  model as chat. Keeping `purpose: vision` separate still lets you point it at a stronger or local vision
  model later without touching the chat setup.
- **Registration:** `computer.act` is registered only when the active driver advertises a desktop and
  the `vision` purpose has a model with vision. The input is validated with zod in `sandbox-protocol`;
  coordinate actions are bounded by the real screen, keys come from an allow-list, typed text is passed
  as one argument, and only the four allowed apps can be launched (as uid 1000, never the daemon's 1001).
  Every desktop command has a deadline and is killed rather than retried.
- **Screenshots:** each action ends with a fresh PNG scaled to fit 1280 px on the long side (the result
  states the scale and the original size). The tool saves it under `sessions/<sessionId>/images/` and
  returns it as an S52 image reference, never bytes in the transcript. Its input coordinates are in that
  latest screenshot; the tool maps them back to display pixels.
- **Prefer structure over pixels.** Browser tools ([F09](F09-browser.md)) for web pages, `desktop.inspect` /
  `desktop.act` for desktop apps; `computer.act` only when neither tree can drive what is on screen.
- **Effects:** `screenshot`, `move` and `ocr` are `read`; every other action is `write_local` inside the
  desktop. A click in the browser on a submit control is judged by the browser rules in
  [F09](F09-browser.md).
- **Screenshot pruning:** the context keeps the newest N images as pixels
  (`context.imageHistoryLimit`, default 3); older screenshots become deterministic placeholders.

#### The Calc task (S56)

The end-to-end Calc task uses the tree, not pixels:

1. Launch LibreOffice, find "Calc Spreadsheet" and click it.
2. `desktop.inspect({ window: "Calc", find: { name: "A1" } })` (or a sub-tree ref) returns the cell
   ref; `desktop.act({ action: "type", ref, text: "42" })`, then `key: "Return"` commits it. Repeat for
   B1, then `key: "ctrl+s"`.
3. The Save dialog is a `file chooser`; its accessible name can be "Question" or "Export Text File"
   while `desktop.windows` shows the WM title. Inspecting the application (`soffice`) picks the active
   dialog. Set the name to `/workspace/calc.csv`, click Save, choose "Use Text CSV Format", then OK in
   the export options.
4. `workspace.exec` reads `/workspace/calc.csv`.

A Calc sheet publishes tens of thousands of cells, so the helper's traversal is capped (3,000 visits,
1,500 nodes); a cut tree says how to ask for a sub-tree. Use `find` by cell name or role for the grid
rather than reading the whole sheet. The integration test drives exactly this flow; the offline eval
runs a structure-only and a screenshot-only variant and reports them side by side.

The prompt includes a short computer-use section: `desktop.inspect` first, pixels last, use
`computer.request_takeover` for sign-ins and CAPTCHAs, and never type a secret the owner did not give.

### Take control

The desktop has two modes, held by `SandboxService` and reset to `agent` in every new process:

- In **agent** mode the agent drives the desktop and the viewer is watch-only.
- In **owner** mode the viewer gets the full-control stream. Every writing action of `computer.act`
  and `desktop.act` is refused with a clear message; `screenshot`, `ocr`, `desktop.inspect` and
  `desktop.find` still work, so the agent can look but not act. The full-control VNC password is
  only returned by core's cookie-gated credentials route while the mode is owner, and the stream
  only goes through core.

1. The agent calls `computer.request_takeover({ reason })` (or you press **Take control**).
2. The turn ends `waiting` with a question. The question starts with
   "The agent asked for control of the desktop." and quotes the agent's reason as its words, not
   verified, followed by the viewer link. It reaches the same reply channel as the turn (Telegram or
   the TUI); pressing **Take control** in the viewer works without a request too.
3. The desktop goes to `owner` mode: the agent's writes are refused and the viewer canvas becomes
   interactive. Pressing Take control yourself also pauses every running turn, so its desktop
   actions cannot race yours.
4. You sign in, solve the CAPTCHA, or fix something; then press **Give back**.
5. Give back returns the agent mode, closes every open full-control stream, and queues a `resume`
   turn. Its system note says the screen may have changed and, when the vision gate allows it,
   attaches a fresh screenshot; otherwise it tells the agent to take a new `desktop.inspect`
   snapshot. The resume is a compare-and-set from `waiting`, so two Give backs cannot resume twice.

**If nobody gives back**, the desktop returns to the agent after 15 minutes (the default takeover
timeout), the full streams close, and the paused turns resume with a "did not give the desktop back
in time" note.
**If core restarts** while in owner mode, the mode is lost with the process; the new process starts
in agent mode and resumes any waiting takeover turn with a "core restarted" note and a screenshot
when vision allows. The desktop is never left stuck in owner mode.

While you have control the page shows a permanent warning: the display has no X access control
(`Xvfb -ac`), so any process in the sandbox can read the screen and the keystrokes. Do not enter a
password, a one-time code or any other secret during Take control; credential entry belongs to the
[F12](F12-secrets-vault.md) path.

From Telegram, the agent sends a "Take control" link that opens the web UI on that screen.

## Workspace and desktop in one sandbox

With the `shitsuji` driver they are one container (decision W1): the workspace is the base image, the desktop a
layer on top. Commands, GUI apps and the browser see the same `/workspace` and `/handoff`, so a file downloaded
in Chromium can be processed by a script and opened in LibreOffice without moving it. A forged tool
([F20](F20-tool-forge.md)) declares the capabilities it needs (`exec`, `desktop`, `browser`).

## Acceptance criteria

- [x] `docker compose up` starts the desktop; the web UI shows it live.
- [x] The agent opens LibreOffice Calc, types numbers, saves a file to `/workspace`, and `workspace.exec` can read it.
- [x] The same Calc task completes **using only `desktop.inspect` / `desktop.act`**, with no screenshot sent to
  the model; an eval ([F22](F22-observability-and-cost.md)) compares its tokens and success rate with the
  screenshot-only run.
- [x] `desktop.inspect` on Thunar, the XFCE terminal and Chromium returns named elements; the startup check
  reports any allowed app that publishes no tree.
- [x] Acting on a ref after the window changed returns "stale" instead of clicking the wrong thing.
- [x] Take control / Give back works and the agent continues.
- [x] No desktop port is reachable from the host or LAN without going through `core`.

## Risks and open questions

- **Resource use.** A desktop plus Chromium wants 2–4 GB RAM. Allow stopping the desktop processes when idle and
  starting them on demand (`DesktopCapability.state()` + an idle timer); the shell stays up.
- **Chromium's process sandbox is off.** The setuid helper is stripped and the container has no user
  namespaces, so `sandboxd` starts Chromium with `--no-sandbox` ([F09](F09-browser.md), S57). The container
  is then the only boundary around a hostile page; that is why it holds no secrets, has no route to `core`
  and leaves only through `egress-proxy`.
- **The X display has no access control.** `Xvfb -ac` accepts every local client, so any process in the
  sandbox can read the screen and the keystrokes. During Take control that includes what you type; see the
  warning there and use the [F12](F12-secrets-vault.md) credential path, never the desktop, for secrets.
- **Chromium input is `write_local` for now.** Until the browser rules land in [F09](F09-browser.md), a
  `computer.act` click or key committed in Chromium is judged as a local desktop write, not as an outside
  action; a click on a submit control is not classified yet. The owner accepted this gap for S53; it is
  tracked as [#136](https://github.com/ggiraudon/shitsuji/issues/136).
- **Pixel-based control is slow and error-prone** with today's models; treat it as the fallback, not the main
  path.
- **Tree quality varies by app.** GTK and Qt apps are usually good; XFCE panel applets, some Electron apps
  and anything drawn on a canvas may be thin or empty. LibreOffice's Calc grid can be very large: read only
  the visible cells. Measure this early with the startup check rather than assuming.
- **XFCE vs GNOME.** XFCE is light, but most AT-SPI testing happens on GNOME. If too many apps misbehave,
  try a minimal GNOME Flashback or MATE session before giving up on the tree.
- **Image choice.** Build our own Debian image (full control) versus starting from a maintained desktop image
  (faster). Proposal: own Dockerfile, pinned package versions.
