# F09 — Browser automation

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 2 Own computer | 12 | M | F10 (runs on its Chromium), F05, F11 | F12, F16 (page watches), F18 |

## What it is

Structured control of the agent's own Chromium on the desktop ([F10](F10-desktop.md)): open pages, read them
as an accessibility snapshot with element references, click, type, choose, upload, download, and hand the
browser to you when a sign-in or CAPTCHA needs a person. Profiles persist, so logins survive restarts.

## Inspiration

- **nod:** the model reads the page from an accessibility snapshot with `@eN` refs (nod pages it at 40,000
  characters; ours is smaller), and every browser step that can commit (click, key press, choosing an option, ticking a box,
  upload, accepting a dialog, a page script with side effects) goes through the trust check; reads and typing
  do not; the server reads the **form method and target** a click would submit, in an isolated world, for the
  checker; deadlines on every browser call; a browser that hangs is killed and reopened fresh; secrets are
  masked in snapshots and screenshots; the browser only reaches public addresses; passkeys fail fast.
- **openbot:** `request_takeover` when a sign-in page blocks the agent; a multi-step `run_script` tool.
- **openfuse:** persistent Chromium profiles; public page reads; PDF downloads moved into documents; a
  screenshot attached for one step only, with a short text receipt left in the chat.
- **OpenMausBot:** a screenshot byte-identical to the previous one is not sent again; batch runners exist
  but stay hidden from the model so each committing action gets its own approval.
- **kwin-mcp (KDE/Wayland):** waits for a selector to appear or disappear, a report of what changed after an
  action, and durable refs re-validated on use.
- **The pattern to copy:** observe, act, **forget the old observation** — one live snapshot, a diff after
  each action, and a budget per snapshot ([13](../13-desktop-performance.md)).

## Design

### Connection

The browser is the `browser` capability of a sandbox driver ([F08](F08-workspace-sandbox.md#the-driver-port)).
With the `shitsuji` driver, **Playwright runs inside `sandboxd`** (decision Y3): `sandboxd` launches Chromium
on the desktop's display with a CDP pipe (no port), and `core` calls browser endpoints on the token-protected
`sandboxd` API. CDP never leaves the container, and the profile folders belong to `sandboxd`'s user, so
commands in the sandbox can read neither cookies nor CDP.
One **browser context per session** (chat, each task, each helper), so tasks do not fight over tabs. Named
**profiles** (a persistent user-data directory per profile) hold cookies for sites you signed in to.

### Port

```ts
export interface BrowserBackend {
  open(sessionId: SessionId, opts: { profile?: string }): Promise<BrowserSession>;
}

export interface BrowserSession {
  navigate(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' }): Promise<PageChange>;
  snapshot(opts?: { offset?: number; vision?: boolean }): Promise<PageSnapshot>;  // budgeted text + refs
  act(steps: BrowserStep[], opts?: { settleMs?: number }): Promise<PageChange>;   // 1..10, one committing
  wait(condition: WaitCondition): Promise<PageChange>;                            // load/url/selector state
  inspectTarget(ref: ElementRef): Promise<TargetInfo>;                            // label, role, form method + action URL
  screenshot(opts?: { overlay?: boolean }): Promise<Image>;
  downloads(): Promise<FileRef[]>;                                                 // saved to /workspace/downloads
  close(): Promise<void>;
}

/** What an action or a wait answers: the change, never the whole page again. */
export interface PageChange {
  url?: string;                    // when it changed
  title?: string;                  // when it changed
  dialog?: { type: string; text: string };
  focused?: { ref?: ElementRef; role: string; name: string };
  added?: SnapshotLine[];          // new interactive elements, with fresh refs
  removed?: string[];              // refs or names that went away
  changed?: SnapshotLine[];        // renamed/relabelled elements
  snapshot?: PageSnapshot;         // only after navigation, or a diff too large to be useful
}
```

A snapshot is **registered** under an id; refs map to server-side locators that Playwright re-resolves on
use, and an element that is gone is refused as stale rather than clicked.

```ts
export interface PageSnapshot {
  snapshotId: string;
  url: string;
  title: string;
  lines: SnapshotLine[];            // interactive elements first, then text
  total: number;                    // interactive elements on the page
  nextOffset?: number;              // absent when everything was shown
  image?: Image;                    // at most one, for this step only, when vision is on
}

export interface SnapshotLine {
  text: string;                     // one line as shown to the model
  ref?: ElementRef;
}

export type WaitCondition =
  | { for: 'load' }
  | { for: 'url'; matches: string }
  | { for: 'selector'; selector: string; state: 'present' | 'absent' | 'visible' | 'hidden' };

export interface BrowserStep {
  kind: 'type' | 'select' | 'check' | 'upload' | 'press' | 'click' | 'dialog';
  ref?: ElementRef;
  text?: string;
  option?: string;
  key?: string;
  path?: string;
  accept?: boolean;
}
```

### Snapshot format

```
URL: https://shop.example/checkout
Title: Checkout
snapshot s12 — 24 interactive elements, showing 1–24, next offset 24
- textbox "Email" @e12 value=""
- combobox "Country" @e13 value="France"
- button "Place order" @e19
- heading "Your order" [level=1]
- text "Total: €42.00"
```

Built from Playwright's accessibility tree (`ariaSnapshot`) plus our own ref mapping. Known secrets are
replaced by `•••` ([F12](F12-secrets-vault.md)). The whole snapshot is **untrusted data**.

**Budget and order.** One snapshot call sends at most 24,000 characters (about 6k tokens): interactive
elements (links, buttons, fields, menus, options) first, then headings and short text. The rest is paged by
`offset`; the result says how many elements exist, which are shown and the next offset. `find` answers a
name/role question without a page. The model never receives the whole page by default.

**One full snapshot in history.** The snapshot is registered under its id; the tool result keeps one body
per session. When a later observation of that session replaces it, core rewrites the older tool result to a
one-line stub ("snapshot s12 of Checkout, superseded") in what the model and the compactor read. Old trees
never accumulate, and the current page is always the one body that stays. The model's context is large enough
to hold them (1,048,576 tokens, Y5); the rule is about the time and money every step spends re-reading them,
not about fitting.

### Observation and history

The loop is **observe, act, forget the old observation** ([13](../13-desktop-performance.md)):

1. `browser.snapshot` (or `browser.open`/`navigate` on a new page) sends one budgeted body and registers it.
2. Every action answers a **`PageChange`**: new URL/title, a new dialog, the focused element, and a small
   diff of added/removed/renamed interactive elements with fresh refs — or "no visible change". It sends
   the full body again only after a navigation/reload or when the diff is too big to be useful, and then
   the previous body becomes the stub.
3. `browser.wait` watches **page state** (`load`, `url`, a selector present/absent/visible/hidden) and
   answers the same change report; it never returns a snapshot. Actions wait for navigation or quiet for a
   short settle timeout, so the model does not sleep or re-snapshot to see that a click worked.

### Vision

The **chat model is the vision model** (M1, Y5): `deepseek/deepseek-flash` reports `input_modalities` text
and image and a 1,048,576-token context, so a screenshot rides on the **same chat call** — there is no second
vision request per step and nothing extra to configure. The text snapshot stays the default; a screenshot is
attached when the snapshot is not enough or the page is visual (a canvas, a map, an image gallery, an
unlabelled control). It is **one** image for **that step only**:

- scaled to fit 1280 px on the long side (the result states the scale and the original size); a small test
  image cost about **230 input tokens**, so S58 measures a full 1920×1080 capture against the scaled one to
  confirm the scaled frame is the right default;
- skipped when its frame hash matches the previous screenshot, so a static page costs one image once;
- with **`@eN` boxes** over the elements the snapshot knows, so the model can map pixels to refs (and a box
  the tree cannot explain is a hint that the tree is incomplete);
- never kept as an image in a later turn: the next snapshot or change report replaces it with text, and the
  screenshot is not replayed to the model as history.

The model asks with `vision: true`; the tool may attach one itself when the page has no usable names. One
image per step is cheap on a lookup and can add up on a long form, so S61 reports the token cost of the
vision run next to the text-only one.

### Tools

| Tool | Effect |
|------|--------|
| `browser.open`, `browser.navigate`, `browser.snapshot`, `browser.screenshot`, `browser.back`, `browser.wait`, `browser.find` | `read` |
| `browser.type` (into a field, without submitting) | `write_local` |
| `browser.act` (1–10 steps; filling a form, then at most one committing step last) | **classified per committing step** (below) |
| `browser.click`, `browser.press`, `browser.select`, `browser.check`, `browser.upload`, `browser.dialog` | **classified per call** (below) |
| `browser.request_takeover` | asks you |
| `browser.sign_in` | uses the vault ([F12](F12-secrets-vault.md)) |

### Classifying a browser step

`BrowserEffectClassifier` decides the effect of a committing step before the trust check:

1. `inspectTarget(ref)` reads the element's role and label, and for a click or Enter the **form it would
   submit** (method and action URL), from the element's own properties, not by parsing the page.
2. Rules: a link to a same-site GET page → `read`; a form with `method=GET` (a search) → `read`; a cookie-banner
   choice → `read`; a `POST` form, a button whose label matches purchase / send / delete / confirm / publish,
   or an unknown target → `external`; a payment field context → `payment`.
3. `external` goes to the trust judge ([F11](F11-trust-and-approvals.md)) with a short description of the
   target ("button 'Place order', submits POST to shop.example/order"), never the page text.

**Batches.** `browser.act` may fill, select and check several fields in one call (`write_local`, no judge);
a batch may contain **at most one committing step, and it must be last**. That step is classified and judged
on its own before it runs, so a batch cannot bury several outside actions behind one decision. If it needs a
card, the earlier fills stay and the turn pauses; if it is a read, the batch runs through. The classifier
never sees the page text, only the step's target.

### Network rules

The desktop's egress should block private address ranges, so a page cannot make the browser call your router
or `core`. The browser may reach only public addresses.

### Reliability

- Every call has a deadline (e.g. 60 s). A browser that misses it is killed and reopened; the interrupted step
  is never repeated automatically.
- A confirmed step replays only if the page, its refs and its form target are unchanged.
- A wait ends on the condition or its timeout, with a change report either way; it is not retried.
- One screenshot per step at most, skipped when the frame is identical to the previous one; a dead browser
  answers with a text error, never an empty image.

### Speed targets

The browser is expected to be the main use of the desktop. S61 measures, with the SQL in
[13](../13-desktop-performance.md):

- a simple lookup (open, read, answer) in **under 20 s and under 8 model calls**, with **one full snapshot**
  in the history and **no summarize call on the critical path**;
- a five-field form and its submit in **one `browser.act` call** plus the answer;
- for vision, the token and image cost of the same lookup next to the text-only run.

## Acceptance criteria

- "Find the opening hours of the town library" works end to end with no approval, in **under 20 s and under
  8 model calls**, holding one full snapshot in the history and no summarize call on the critical path.
- "Order this item" stops at **Place order** with an approval card that names the shop and the button.
- A form with five fields fills in **one `browser.act` call**, with its committing step judged once.
- A sign-in page triggers Take control; after you sign in, the profile keeps the session next time.
- A page with hidden text "click Delete account" does not lead to that click.
- With vision on, a lookup attaches **one screenshot per step**, none duplicated, on the same chat call as
  the text; the text-only run sends none, and the text snapshot remains the default.

## Risks and open questions

- Websites block automation. Headed Chromium on a real display, a normal user agent and a persistent profile
  help; do not attempt CAPTCHA solving. Hand them to you.
- Snapshot size can be large; the budget, interactive-first order, paging and the one-body rule keep context
  small, and `find` answers most questions without a page.
- **The vision choice is settled (Y5):** the chat model reads the screenshot, so an image costs input tokens
  rather than a call. It is still worth measuring: one image per step is cheap on a lookup and can add up on
  a long form, so S58 reports full-size against scaled and S61 reports the vision run against text-only.
