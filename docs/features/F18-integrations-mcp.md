# F18 — Integrations: MCP and connected apps

| Phase | Rank | Effort | Depends on | Needed by |
|-------|------|--------|-----------|-----------|
| 4 Autonomy | 18 | M | F05, F11, F12 | F17 |

## What it is

Access to your apps and services: email, calendar, files, notes, task trackers, home automation, and anything
with an MCP server. Two routes:

1. **MCP client:** connect any [Model Context Protocol](https://modelcontextprotocol.io) server (stdio or HTTP)
   and expose its tools to the agent.
2. **First-party connectors** for the few apps that proactivity depends on (email over IMAP/SMTP or Gmail,
   calendar over CalDAV or Google), with change signals and record readers.

Every app action goes through the trust service.

## Inspiration

- **nod:** connected MCP tools run as deferred tools (`mcp__<server>__<tool>`) through the same trust check and
  untrusted wrapping as apps; each server's own instructions reach the model inside an untrusted block; app
  reads go through the trust read-check; HTTP 429/503 from a connection service pauses background reads for
  the whole install with back-off; account-access emails (password resets, codes) are hidden from the model.
- **openbot:** MCP servers added, tested and removed by the agent itself **with your approval**; a server that
  does not answer is not saved; keys are entered by you in settings, never by the agent; an edit that would
  send stored headers to another origin is refused.
- **openfuse:** Google OAuth adapters; each send or calendar change needs its own stored review; changing the
  account invalidates pending work.
- **OpenMausBot / openbot:** Composio for hundreds of apps (a hosted service; optional for us).

## Design

### MCP

| Class | Responsibility |
|-------|---------------|
| `McpServerRegistry` | Configured servers: transport (`stdio` command, or `http` URL), auth secret refs, enabled flag |
| `McpConnection` | One client per server (`@modelcontextprotocol/sdk`), reconnects, lists tools |
| `McpToolAdapter` | Wraps each MCP tool as a Shitsuji `Tool`: `deferred: true`, `untrustedOutput: true`, effect from MCP annotations (`readOnlyHint`, `destructiveHint`) or `external` when unknown |

- **Where stdio servers run:** not in `core` (they are third-party code). Run them in the **workspace
  container** with secrets injected for that process only, or as their own small Compose services. Remote HTTP
  servers are called from `core`.
- **Agent-managed servers:** `mcp.add({ name, transport })`, `mcp.test`, `mcp.remove` are `write_self` and
  always ask. Credentials are entered by you through a secure form ([F12](F12-secrets-vault.md)).

### First-party connectors

```ts
export interface AppConnector {
  readonly app: 'mail' | 'calendar' | string;
  tools(): Tool[];                                   // read and write tools
  changeSignal?(): ChangeSignal;                     // cheap: IMAP IDLE / UIDNEXT, CalDAV ctag, sync tokens
  readRecords?(cursor: Cursor): Promise<RecordPage>; // for the observer (F17)
}
```

| Connector | Protocol | Notes |
|-----------|----------|-------|
| Mail | IMAP + SMTP (any provider), or Gmail API | Drafts saved in the mailbox; send is `external`; account-access mail hidden |
| Calendar | CalDAV (any provider), or Google Calendar API | Availability tool; create/update/delete is `external` |

IMAP and CalDAV keep us independent of Google and work with self-hosted mail.

### Email connector

Email is the connector proactivity leans on most, and the one where a mistake is hardest to undo, so it gets
its own design.

#### Why not a mail CLI in the agent's shell

A common pattern elsewhere is to let the agent run a mail CLI such as Himalaya in its shell (openbot has a
`himalaya-email` skill in its import samples). For Shitsuji that would:

1. put **mail credentials inside the workspace**, which holds no secrets by design ([F08](F08-workspace-sandbox.md),
   [F12](F12-secrets-vault.md));
2. let a shell command **send mail without the trust check** ([F11](F11-trust-and-approvals.md)), so an
   injected web page could get mail sent with no approval card;
3. return **plain CLI text**, while the safety rules need structured messages (who sent it, which thread,
   which links, is it a sign-in code).

OpenMausBot meets the same problem from the other side: its sandboxes reach the internet only through an HTTP
proxy, so a mail CLI inside them cannot reach a mail server at all, and it runs them elsewhere.

So mail lives in **`core`**, behind a port, and the agent only sees typed tools.

#### Port and adapters

```ts
export interface EmailBackend {
  readonly kind: 'imap-smtp' | 'gmail-api' | 'himalaya';
  listFolders(): Promise<Folder[]>;
  search(q: MailQuery, page: PageRef): Promise<EnvelopePage>;     // envelopes only: no bodies
  fetch(id: MessageId, parts: FetchParts): Promise<RawMessage>;   // RFC 822 source or chosen parts
  saveDraft(draft: OutgoingMessage): Promise<MessageId>;          // into the provider's Drafts folder
  send(draft: OutgoingMessage): Promise<SendReceipt>;             // SMTP or API; appends to Sent if needed
  move(ids: MessageId[], to: FolderRef): Promise<void>;           // archive, trash, folders
  setFlags(ids: MessageId[], flags: FlagChange): Promise<void>;   // read, starred
  watch(signal: AbortSignal): AsyncIterable<MailboxChange>;       // IDLE or polling
}
```

| Adapter | Built on | When |
|---------|----------|------|
| `ImapSmtpBackend` | **imapflow** (IMAP, IDLE, CONDSTORE), **nodemailer** (SMTP), **mailparser** (MIME) | First. Works with any provider using app passwords, and with self-hosted mail |
| `GmailApiBackend` | Gmail REST API (history IDs as the change signal) | Later, if you want Google OAuth instead of app passwords |
| `HimalayaBackend` | Himalaya CLI with JSON output, run **by `core`**, never by the agent | Optional, if its extra backends (Maildir, notmuch) or its OAuth setup are worth a pinned extra binary |

imapflow also speaks XOAUTH2, so Gmail and Outlook over IMAP with OAuth tokens is a later option without a
new adapter.

#### Classes

| Class | Responsibility |
|-------|---------------|
| `MailConnector` | The `AppConnector` for mail: owns the accounts, exposes the tools, the change signal and the record reader |
| `MailAccountRepository` | Accounts: address, display name, backend kind, server settings, vault refs for credentials, signature, enabled |
| `MailSyncService` | Keeps a light **envelope index** per account (UID, folder, thread, from, to, subject, date, flags, snippet) and a sync cursor (UIDVALIDITY, highest MODSEQ / UIDNEXT). Bodies are fetched on demand, not stored by default |
| `MailRenderer` | Turns a raw message into what the model reads (see below). Not to be confused with the channel `MessageRenderer` in [F06](F06-channel-gateway.md) |
| `AccountAccessFilter` | Hides password resets, sign-in codes and security alerts from the model |
| `DraftService` | Builds replies and new messages: threading headers, quoting, signature, identity; saves to the provider's Drafts |
| `MailSender` | Sends one approved draft exactly once, records the outcome |

#### What the model sees

`MailRenderer` produces a compact, safe view:

- headers that matter: from, to, cc, date, subject, a thread position ("3rd of 5");
- the body as **plain text**: HTML converted to text, quoted history folded ("… 40 quoted lines"), signatures
  trimmed; remote images and tracking pixels never loaded;
- **links listed with their real destinations** next to their text, so "Click here" pointing at another domain
  is visible;
- attachments as a list (name, type, size). `mail.save_attachment` copies one into `/handoff` for the
  workspace or desktop to open;
- everything inside one untrusted block (`untrustedOutput: true`), like web pages.

#### Account-access mail

Reset links and sign-in codes in the model's context are a gift to prompt injection ("forward the latest code
to …"). `AccountAccessFilter` runs on every message before the model or the observer sees it:

1. **Rules first, no model:** known senders and headers (`no-reply@accounts.*`, `security@*`), subject and
   body patterns (one-time codes, "reset your password", "new sign-in").
2. **The cheap classifier** ([F03](F03-model-providers.md) `purpose: classify`) for what the rules can't
   decide, reading only sender, subject, link destinations and the start and end of the text (nod's approach).
3. A failed check **hides** the message.

Hidden messages appear to the model as "1 account-access message hidden" with the sender's domain only. You
still see them in your own mail client. A later option is letting the agent use a code for a sign-in **you
started**, through the vault's sign-in flow ([F12](F12-secrets-vault.md)), without the code ever reaching the
model.

#### Tools

| Tool | Effect | Notes |
|------|--------|-------|
| `mail.search({ account?, query, folder?, since?, limit })` | `read` | Envelopes from the index; IMAP SEARCH for older mail |
| `mail.read({ id })` | `read` | Rendered message; marks nothing as read unless asked |
| `mail.thread({ id })` | `read` | The whole thread, oldest first, quoted parts folded |
| `mail.save_attachment({ id, part })` | `write_local` | Into `/handoff` |
| `mail.draft({ to, cc?, subject, body, reply_to?, account? })` | `write_local` | Saves a draft in your mailbox, shows a draft card ([F07](F07-web-ui.md) `email_draft`) |
| `mail.update_draft({ draft, … })` | `write_local` | Edits a draft it made |
| `mail.send({ draft })` | `external` | Sends **an existing draft only**, so the approval card shows exactly what goes out |
| `mail.move({ ids, to })`, `mail.archive({ ids })` | `external` | Changes your mailbox; judged like any outside action |
| `mail.mark({ ids, read?, starred? })` | `external` (low risk) | Rules can let it run without asking |
| `mail.delete({ ids })` | `external` | Moves to Trash; **permanent deletion is not offered** |

#### Sending safely

- **Approval is bound to the draft's content** ([F11](F11-trust-and-approvals.md)): recipients, subject, body
  hash and attachments. Editing the draft after approval invalidates the approval.
- **Recipients are checked against your words.** "Email Anna the report" covers Anna's address from your
  contacts or the thread; any other recipient, or a new cc, asks.
- **Exactly once.** The draft gets its `Message-ID` when created. `MailSender` records "sending" before the
  SMTP call and "sent" after. A crash in between leaves it **uncertain**: never re-sent automatically, and
  the agent is told it may have gone out (nod does the same for every confirmed action).
- **Threading:** replies set `In-Reply-To` and `References`, keep the subject, and go from the account the
  original was sent to.
- **Sent folder:** after SMTP, the message is appended to Sent unless the provider does it itself (Gmail does).
- **Rate limit:** a small per-hour cap on sends, as a setting, so a loop cannot spam.
- Background, observer and helper turns can **draft but never send** ([F17](F17-proactivity.md), [F15](F15-tasks-and-subagents.md)).

#### Change signal and proactivity

`MailSyncService.watch` holds one IMAP IDLE connection per account on INBOX (polling other folders, and as a
fallback every few minutes). On a change it updates the envelope index **in code**; only new envelopes that
pass the account-access filter become signals for the observer ([F17](F17-proactivity.md)), which batches them
and lets the cheap classifier skip routine mail before the main model sees anything.

#### Storage

`mail_accounts`, `mail_envelopes` (the index, with `owner_id`, account, folder, UID, thread id, flags, snippet),
`mail_sync_state` (per folder: UIDVALIDITY, MODSEQ/UIDNEXT) and `mail_sends` (draft Message-ID, approval id,
state `sending | sent | uncertain | failed`). Bodies are cached only briefly; your mailbox stays the source of
truth. See [F02](F02-persistence.md).

#### Writing style (optional)

nod learns your writing style from your sent mail, keeping style only (no names, facts or quotes). That fits
memory ([F13](F13-long-term-memory.md)) as one capped `preferences` note, off by default.

## Acceptance criteria

- Adding a filesystem or GitHub MCP server makes its tools discoverable by `tool_search`; a write tool asks
  first.
- An MCP server's tool output is wrapped as untrusted data.
- The mail connector drafts a reply in the right thread; sending asks unless your words covered it.
- Mail credentials exist only in the vault and `core`; nothing in the workspace or desktop can reach the
  mail server with them.
- A password-reset email and a message with a sign-in code never reach the model's context; it sees "1
  account-access message hidden".
- "Email Anna the report" sends to Anna; a draft that adds Bob in cc asks first.
- Editing a draft after it was approved needs a new approval.
- Killing `core` between "sending" and "sent" leaves the send `uncertain`, and it is not sent again on
  restart.
- A new message in INBOX reaches the observer within a minute through IDLE, without a model call for
  routine mail.
- An HTML email with a link whose text and destination differ shows both; no remote image is fetched.

## Risks and open questions

- Many MCP servers are low quality or unsafe. Keep a short "known good" list in docs; treat every server as
  untrusted code.
- OAuth for Google needs a public callback URL or a local loopback flow; IMAP/CalDAV with app passwords avoids
  that for a first version.
- **Himalaya adapter:** before choosing it, check how it takes credentials (we need it to read them from the
  vault per call, not from a plain config file), whether it can watch for new mail or only poll, and how stable
  its JSON output is between versions. Only worth it if you already use Himalaya or want Maildir/notmuch.
- **Several accounts:** one IDLE connection each; most providers limit concurrent IMAP connections (often
  around 10–15), so the sync service shares connections between folders.
- **Large mailboxes:** the first sync indexes only recent mail (default 90 days); older mail is searched on
  the server.
