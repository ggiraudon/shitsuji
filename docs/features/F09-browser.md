# F09 — Browser automation

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 2 Own computer | 12 | M | F10 (runs on its Chromium), F05, F11 | F12, F16 (page watches), F18 |

## What it is

Structured control of the agent's own Chromium on the desktop ([F10](F10-desktop.md)): open pages, read them
as an accessibility snapshot with element references, click, type, choose, upload, download, and hand the
browser to you when a sign-in or CAPTCHA needs a person. Profiles persist, so logins survive restarts.

## Inspiration

- **nod:** the model reads the page from an accessibility snapshot with `@eN` refs (up to 40,000 characters,
  rest by offset); every browser step that can commit (click, key press, choosing an option, ticking a box,
  upload, accepting a dialog, a page script with side effects) goes through the trust check; reads and typing
  do not; the server reads the **form method and target** a click would submit, in an isolated world, for the
  checker; deadlines on every browser call; a browser that hangs is killed and reopened fresh; secrets are
  masked in snapshots and screenshots; the browser only reaches public addresses; passkeys fail fast.
- **openbot:** `request_takeover` when a sign-in page blocks the agent; a multi-step `run_script` tool.
- **openfuse:** persistent Chromium profiles; public page reads; PDF downloads moved into documents.

## Design

### Connection

`core` connects with Playwright `chromium.connectOverCDP('http://desktop:9222')` through the sandbox network.
One **browser context per session** (chat, each task, each helper), so tasks do not fight over tabs. Named
**profiles** (a persistent user-data directory per profile) hold cookies for sites you signed in to.

### Port

```ts
export interface BrowserBackend {
  open(sessionId: SessionId, opts: { profile?: string }): Promise<BrowserSession>;
}

export interface BrowserSession {
  navigate(url: string): Promise<PageState>;
  snapshot(opts?: { offset?: number }): Promise<PageSnapshot>;     // text + refs
  act(action: BrowserAction): Promise<PageState>;                    // click, type, select, check, press, scroll, upload
  inspectTarget(ref: ElementRef): Promise<TargetInfo>;               // label, role, form method + action URL
  screenshot(): Promise<Image>;
  downloads(): Promise<FileRef[]>;                                   // saved to /handoff
  close(): Promise<void>;
}
```

### Snapshot format

```
URL: https://shop.example/checkout
Title: Checkout
- heading "Your order" [level=1]
- textbox "Email" @e12 value=""
- combobox "Country" @e13 value="France"
- button "Place order" @e19
```

Built from Playwright's accessibility tree (`ariaSnapshot`) plus our own ref mapping. Known secrets are
replaced by `•••` ([F12](F12-secrets-vault.md)). The whole snapshot is **untrusted data**.

### Tools

| Tool | Effect |
|------|--------|
| `browser.open`, `browser.navigate`, `browser.snapshot`, `browser.screenshot`, `browser.back` | `read` |
| `browser.type` (into a field, without submitting) | `write_local` |
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

### Network rules

The desktop's egress should block private address ranges, so a page cannot make the browser call your router
or `core`. The browser may reach only public addresses.

### Reliability

- Every call has a deadline (e.g. 60 s). A browser that misses it is killed and reopened; the interrupted step
  is never repeated automatically.
- A confirmed step replays only if the page, its refs and its form target are unchanged.

## Acceptance criteria

- "Find the opening hours of the town library" works end to end with no approval.
- "Order this item" stops at **Place order** with an approval card that names the shop and the button.
- A sign-in page triggers Take control; after you sign in, the profile keeps the session next time.
- A page with hidden text "click Delete account" does not lead to that click.

## Risks and open questions

- Websites block automation. Headed Chromium on a real display, a normal user agent and a persistent profile
  help; do not attempt CAPTCHA solving. Hand them to you.
- Snapshot size can be large; paging by offset and a "find on page" helper keep context small.
