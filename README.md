# gmail-mcp

The full Gmail API surface as an MCP server (~55 tools). Install this when the default Gmail MCP your client ships with stops at search/read/send and you need threaded reply drafts, attachments on drafts, filters, signatures, vacation, forwarding, delegates, S/MIME, history, or watch.

## Architecture

```
lib/
  auth.js   OAuth 2.0 desktop flow + token cache + error mappers
  mime.js   multipart MIME builder (attachments + threaded reply headers)
  gmail.js  thin wrappers over googleapis (~50 fns) wrapped in an
            error-mapping safe() wrapper so 403/401 surface with fix-it lines
bin/
  gmail-cli.js   shell interface (testable standalone, scriptable);
                 hosts `auth` (OAuth flow) and `auth-status` (diagnostic)
  gmail-mcp.js   MCP server (registered via your client's MCP config)
```

CLI and MCP share `lib/`. CLI is the test surface; MCP is the agent surface.

## One-time setup

See [SETUP.md](SETUP.md). Summary: create a Desktop OAuth client in Google Cloud Console (~5 min, browser-driven, can't be automated), drop `client_secret_*.json` at `~/.gmail-mcp/credentials.json`, run `node bin/gmail-cli.js auth` for the consent flow.

```bash
node bin/gmail-cli.js auth-status        # diagnose
node bin/gmail-cli.js whoami             # confirm
```

Register with your MCP client (Claude Code example):

```bash
claude mcp add gmail-max -- node /absolute/path/to/gmail-mcp/bin/gmail-mcp.js
```

After registration, tools surface as `mcp__gmail-max__*` (or your chosen name's prefix).

## Tool catalog

All tools accept JSON arguments matching their declared input schema. Names below are the MCP tool names. The CLI exposes the same surface with kebab-case subcommands; `node bin/gmail-cli.js --help` prints the full mapping.

### Profile

- **`whoami`** — `{}` → Gmail profile (email, message totals, history id).

### Messages

- **`list_messages`** — `{ q?, labelIds?, maxResults?, pageToken?, includeSpamTrash? }` → `{ messages: [{id, threadId}], resultSizeEstimate, nextPageToken? }`. `q` uses Gmail search syntax: `from:`, `to:`, `subject:`, `has:attachment`, `newer_than:7d`, `is:unread`, label names, etc.
- **`get_message`** — `{ id, format?: "full"|"metadata"|"minimal"|"raw", metadataHeaders? }` → full message including parsed payload tree.
- **`batch_get_messages`** — `{ ids: [...], format?, metadataHeaders?, concurrency?: 10 }` → `{ messages: [...], errors: [{id, error}] }`. Use this instead of looping `get_message` — one tool call instead of N round-trips for the agent. `Promise.allSettled` so one failure doesn't kill the batch.
- **`send_message`** — `{ to, cc?, bcc?, from?, replyTo?, subject?, text?, html?, attachments?, inReplyTo?, references?, threadId?, headers? }` → sent message id. See "Address shape" and "Attachment shape" below.
- **`modify_message`** — `{ id, addLabelIds?: [...], removeLabelIds?: [...] }`.
- **`batch_modify_messages`** — `{ ids, addLabelIds?, removeLabelIds? }` → `{ ok, count }`.
- **`batch_delete_messages`** — `{ ids }` → `{ ok, count }`. PERMANENT, skips Trash, irreversible.
- **`trash_message`** / **`untrash_message`** / **`delete_message`** — `{ id }`.
- **`get_attachment`** — `{ messageId, attachmentId, savePath? }`. With `savePath`: writes to disk, returns `{ savedTo, size, attachmentId }`. Without: returns base64 in `.data`.

### Drafts

- **`list_drafts`** — `{ q?, maxResults?, pageToken? }`.
- **`get_draft`** — `{ id, format? }`.
- **`create_draft`** — `{ ...same as send_message, useSignature?: true }`. With `useSignature: true` (default) the user's default Gmail signature from send-as is auto-appended (text mode: `\n\n-- \n<sig>`; html mode: `<div class="gmail_signature">...</div>` matching Gmail web UI bytes).
- **`create_reply_draft`** — `{ toMessageId, replyAll?: false, body?, html?, attachments?, extraTo?, extraCc?, extraBcc?, fromAlias?, includeQuotedParent?: true, useSignature?: true }`. **The one the typical default Gmail MCP cannot do.** Pulls In-Reply-To, References, threadId, and `Re:` subject from the parent so the draft docks into the original Gmail thread. AUTO-INCLUDES the parent body as a Gmail-style quote (`gmail_quote` / `gmail_attr` / `blockquote` markup, byte-matched to Gmail web UI) AND auto-appends the user's send-as signature, so the rendered draft looks like a normal Gmail reply.
- **`update_draft`** — `{ id, ...same as create_draft }`. Replaces.
- **`send_draft`** — `{ id }`.
- **`delete_draft`** — `{ id }`.

### Threads

- **`list_threads`** — `{ q?, labelIds?, maxResults?, pageToken?, includeSpamTrash? }`.
- **`get_thread`** — `{ id, format?, metadataHeaders? }` → all messages in the thread.
- **`batch_get_threads`** — `{ ids, format?, metadataHeaders?, concurrency?: 10 }` → `{ threads, errors }`. Useful for analysis flows that need full conversation context across many threads at once.
- **`modify_thread`** — `{ id, addLabelIds?, removeLabelIds? }`. Applies to all messages in the thread.
- **`trash_thread`** / **`untrash_thread`** / **`delete_thread`** — `{ id }`.

### Labels

- **`list_labels`** — `{}` → system + user labels.
- **`get_label`** — `{ id }`.
- **`create_label`** — `{ name, labelListVisibility?, messageListVisibility?, color? }`. `color: { backgroundColor, textColor }` hex; must be from Gmail's palette.
- **`update_label`** — `{ id, name?, labelListVisibility?, messageListVisibility?, color? }`.
- **`delete_label`** — `{ id }`.

### Filters

- **`list_filters`** — `{}`.
- **`get_filter`** — `{ id }`.
- **`create_filter`** — `{ criteria: { from?, to?, subject?, query?, hasAttachment?, ... }, action: { addLabelIds?, removeLabelIds?, forward? } }`.
- **`delete_filter`** — `{ id }`.

### Settings

- **`get_vacation`** / **`update_vacation`** — `{ enableAutoReply?, responseSubject?, responseBodyPlainText?, responseBodyHtml?, restrictToContacts?, restrictToDomain?, startTime?, endTime? }` (epoch ms).
- **`get_imap`** / **`update_imap`** — `{ enabled?, autoExpunge?, expungeBehavior?, maxFolderSize? }`.
- **`get_pop`** / **`update_pop`** — `{ accessWindow?, disposition? }`.
- **`get_language`** / **`update_language`** — `{ displayLanguage? }`.
- **`get_auto_forwarding`** / **`update_auto_forwarding`** — `{ enabled?, emailAddress?, disposition? }`.

### Send-as aliases (signatures live here)

- **`list_send_as`** — `{}` → all send-as entries including their signatures (HTML).
- **`get_send_as`** — `{ sendAsEmail }`.
- **`create_send_as`** — `{ sendAsEmail, displayName?, replyToAddress?, signature?, isDefault?, treatAsAlias? }`. **Workspace-only:** fails with 403 "domain-wide authority" on personal Gmail accounts.
- **`update_send_as`** — `{ sendAsEmail, displayName?, replyToAddress?, signature?, isDefault?, treatAsAlias? }`. **Works on personal Gmail** (different endpoint, looser auth) — this is how you change a signature.
- **`delete_send_as`** — `{ sendAsEmail }`. **Workspace-only.**
- **`verify_send_as`** — `{ sendAsEmail }`. Sends the verification email.

### Forwarding addresses

- **`list_forwarding_addresses`** — `{}`.
- **`get_forwarding_address`** — `{ forwardingEmail }`.
- **`create_forwarding_address`** — `{ forwardingEmail }`. Sends a verification email to the address.
- **`delete_forwarding_address`** — `{ forwardingEmail }`.

### Delegates

- **`list_delegates`** — `{}`.
- **`get_delegate`** — `{ delegateEmail }`.
- **`create_delegate`** — `{ delegateEmail }`. **Workspace-only** (requires service account with domain-wide delegation).
- **`delete_delegate`** — `{ delegateEmail }`. **Workspace-only.**

### S/MIME

- **`list_smime`** — `{ sendAsEmail }`.
- **`get_smime`** — `{ sendAsEmail, id }`.
- **`insert_smime`** — `{ sendAsEmail, pkcs12, encryptedKeyPassword? }` (PKCS#12 cert as base64).
- **`set_default_smime`** — `{ sendAsEmail, id }`.
- **`delete_smime`** — `{ sendAsEmail, id }`.

### History / Watch

- **`list_history`** — `{ startHistoryId, labelId?, historyTypes?: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"], maxResults?, pageToken? }`. Incremental sync of mailbox changes since `startHistoryId`.
- **`watch`** — `{ topicName, labelIds?, labelFilterAction?: "include"|"exclude" }`. Subscribe to push notifications via a Cloud Pub/Sub topic. Requires Pub/Sub setup; rarely needed for personal use.
- **`stop_watch`** — `{}`.

## Address shape

`to`, `cc`, `bcc`, `from`, `replyTo` accept any of:

- string: `"recipient@example.com"` or `"Recipient Name <recipient@example.com>"`
- object: `{ name: "Recipient Name", email: "recipient@example.com" }`
- array of either: `["a@example.com", { name: "B", email: "b@example.com" }]` (for to/cc/bcc only — from/replyTo are single-address)

Non-ASCII display names are auto-encoded as RFC 2047 encoded-words.

## Attachment shape

```
{ path: "/absolute/path/to/file.pdf" }                  // read at send time
{ filename: "x.pdf", contentBase64: "...", mimeType: "application/pdf" }  // inline
```

MIME type is guessed from extension if `path` is provided and `mimeType` is omitted.

## Conventions for agent callers

These are not enforced by the server — they are the conventions an agent should follow when composing emails through these tools, because Gmail's rendering and threading semantics demand them.

### Reply drafts: use `create_reply_draft`, not `create_draft`

A draft created via `create_draft` with `inReplyTo` and `threadId` set will be linked to the thread, but it will not include the parent body as quoted text — Gmail's API does not auto-quote. The recipient sees a stripped reply with no context. `create_reply_draft` is the correct tool for any threaded reply: it pulls the parent, builds the quoted body in Gmail's exact byte format (so it renders identically to a Gmail web UI reply), and handles signature placement (signature appears between user body and quoted parent, matching Gmail web UI order).

### Email body paragraphs: one line per paragraph

Every paragraph in `text` or `html` body fields must be a single continuous line. Use `\n\n` between paragraphs only — never `\n` mid-sentence. Hard breaks inside a sentence render as visible line breaks on mobile clients, making the email look broken.

If your tool's output is wrapped to ~70 cols by default (a common LLM behavior), strip the wraps before passing to `text`. Same for `html` — if you have `<p>` tags, the text inside each `<p>` should be one continuous line.

### Signatures are auto-applied

`create_draft`, `create_reply_draft`, and `send_message` (when going through `applySignature` — currently `create_draft` only) auto-append the user's default Gmail signature from send-as. Pass `useSignature: false` if your body is already signature-complete (e.g. you're constructing a system-generated email, or the body contains a signature inline). Do not manually append `\n\n-- \n<sig>` — you'll double-sign.

### Workspace vs personal Gmail

Tools tagged "Workspace-only" above (`create_send_as`, `delete_send_as`, `create_delegate`, `delete_delegate`) require a Google Workspace service account with domain-wide delegation. They will return HTTP 403 "Access restricted to service accounts that have been delegated domain-wide authority" on personal Gmail accounts, regardless of the OAuth scopes granted. The remaining ~51 tools work for both account types. `update_send_as` is the exception that works on personal accounts because it uses a different (looser-auth) endpoint.

### Errors carry fix-it lines

API failures from any tool are rewritten by `lib/auth.js` `mapApiError` to include a `Fix:` hint after the original message. Common ones: `403 SERVICE_DISABLED` → enable Gmail API in Cloud Console; `403 insufficient scope` → delete `~/.gmail-mcp/token.json` and re-auth; `401 / invalid_grant` → token revoked or expired, re-auth.

## Security and threat model

Read this before installing.

### What this gives an agent

The OAuth scope is `https://mail.google.com/` plus `gmail.settings.basic` and `gmail.settings.sharing`. These together grant **send-as-you on your Gmail, full mailbox read/modify/delete, plus settings writes (vacation, filters, signatures, forwarding, delegates).** An MCP client connected to this server can:

- Read any message in your account (including past sensitive content)
- Send mail from your address
- Move or permanently delete mail
- Set up auto-forwarding to an external address
- Modify filters
- Modify your signature

The blast radius if the OAuth refresh token is exfiltrated or the agent is prompt-injected into a hostile action: an attacker has full agentic mail access until you delete the token file (`~/.gmail-mcp/token.json`) or revoke the OAuth grant in your Google Account settings.

### Why the spicy auth path

Gmail's full-access scope (`https://mail.google.com/`) is classified by Google as a **restricted scope** — separate, stricter tier from "sensitive." Restricted scopes require the OAuth app to be verified specifically for that scope (a CASA security review, weeks-to-months process).

`gcloud`'s pre-built OAuth client (the easy "Application Default Credentials" path) cannot grant Gmail's restricted scopes — Google's policy hard-blocks it. The standard pattern for personal-use desktop apps: **you create your own OAuth client**, list yourself as a test user on the consent screen, the app stays in "Testing" mode forever, and Google allows full Gmail access for test users without verification.

This means: the OAuth client you create belongs to you, sits in a Cloud Console project you own, and the consent flow shows "Google hasn't verified this app" — that's expected and is the price of skipping the verification process. See SETUP.md.

### Local data layout

All stored at `~/.gmail-mcp/`, mode 700 directory:

- `credentials.json` (mode 600) — your OAuth client (`client_id`, `client_secret`). Not a secret per se — it's the public identity of your OAuth app, but treat as sensitive to avoid impersonation.
- `token.json` (mode 600) — refresh token. **This is the secret.** Anyone with this file plus your `client_id`/`client_secret` has full mail access until the token is revoked.
- `profile.json` (mode 600) — `{ email, historyId, cachedAt }`, 7-day TTL. `whoami --fresh` forces a refetch.

None of these are committed; the project's `.gitignore` covers `credentials.json`, `token.json`, `profile.json`, and `client_secret*.json` at any path.

### If you want to narrow the blast radius

The repo intentionally does not ship a config-driven policy / allowlist layer — agents that drive this server are the trust boundary, and a JSON allowlist a misbehaving agent could read or rewrite is not a meaningful defense. If you want to fork and add policy enforcement, the right place is `bin/gmail-mcp.js`'s `CallToolRequestSchema` handler (around the `tool.handler(args || {})` call) — wrap it in your own check that reads e.g. an `~/.gmail-mcp/policy.json` and decides whether to allow the call based on tool name + args. Examples of useful policies: deny-all `*delete*` tools; deny `send_message` if `to` doesn't match an allowlist; require human-in-the-loop confirmation for `create_filter` and any settings update.

The ~55 tools split fairly cleanly into read-only (list_*, get_*, batch_get_*, whoami) and mutating (send_*, create_*, update_*, modify_*, delete_*, trash_*, untrash_*, watch, stop_watch). A scope-narrowing fork could simply omit the mutating tools from the `TOOLS` map.

### What this server does not do

- Does not log message contents anywhere. Errors include API response bodies, which may contain message metadata; if you wire stderr to a persistent log, treat that log as sensitive.
- Does not transmit data to any host other than `googleapis.com` (and `accounts.google.com` during initial OAuth).
- Does not phone home, check for updates, or send telemetry.

## Local data

- `~/.gmail-mcp/credentials.json` — your OAuth client (mode 600, never committed)
- `~/.gmail-mcp/token.json` — refresh token cache (mode 600)
- `~/.gmail-mcp/profile.json` — `{email, historyId, cachedAt}` (mode 600, 7-day TTL); `whoami --fresh` forces a refetch.

## License

MIT. See [LICENSE](LICENSE).
