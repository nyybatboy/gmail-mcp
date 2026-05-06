# Setup

## Why a Cloud Console step

Gmail's full-access scope (`https://mail.google.com/`) is classified by Google as a **restricted scope** — separate, stricter tier from "sensitive." Restricted scopes require the OAuth app itself to be verified specifically for that scope (a CASA security review, weeks-to-months process).

`gcloud`'s pre-built OAuth client cannot grant Gmail's restricted scopes — Google's policy hard-blocks it (you'll see "This app is blocked" if you try).

The standard workaround for personal use: **you create your own OAuth client**, list yourself as a test user, the app stays in "Testing" mode forever, and Google allows full Gmail access for test users without verification. ~5 minutes one-time.

## 1. Create a Google Cloud OAuth desktop client

1. Go to <https://console.cloud.google.com/projectcreate> — create a project (any name, e.g. `gmail-mcp`).
2. With that project selected, enable the Gmail API: <https://console.cloud.google.com/apis/library/gmail.googleapis.com> → **Enable**.
3. Configure the OAuth consent screen at <https://console.cloud.google.com/apis/credentials/consent>.
   - User type: **External**
   - App name: anything (e.g. `gmail-mcp`)
   - User support email + developer email: your email
   - **Save.**
   - Under **Test users**, add your own Gmail address. The app stays in "Testing" status indefinitely; refresh tokens won't expire as long as you're a listed test user.
4. Create credentials at <https://console.cloud.google.com/apis/credentials>.
   - **Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `gmail-mcp`
   - **Create**, then **Download JSON**.

## 2. Drop the credentials and authorize

```bash
mkdir -p ~/.gmail-mcp && chmod 700 ~/.gmail-mcp
mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/credentials.json
chmod 600 ~/.gmail-mcp/credentials.json

cd /path/to/gmail-mcp
npm install
node bin/gmail-cli.js auth
```

A browser tab opens. Sign in to your Gmail account, accept the consent. You'll see "Google hasn't verified this app" — that's expected for a personal-use Desktop client; click **Advanced → Go to gmail-mcp**. The CLI captures the redirect, writes the refresh token to `~/.gmail-mcp/token.json`, and exits.

## 3. Verify

```bash
node bin/gmail-cli.js auth-status        # all green
node bin/gmail-cli.js whoami             # email + historyId
node bin/gmail-cli.js list-messages --q "is:unread" --max 5
```

`auth-status` walks four gates and prints the fix command for any failure:

1. OAuth client credentials present
2. Token cached with refresh_token
3. Gmail scope granted
4. Live API call works (caches email at `~/.gmail-mcp/profile.json`)

## 4. Register the MCP

```bash
claude mcp add gmail-max -- node /absolute/path/to/gmail-mcp/bin/gmail-mcp.js
```

Restart Claude Code (or end this session and start a new one). Tools surface as `mcp__gmail-max__*`.

## Adding new scopes later

Update `SCOPES` in `lib/auth.js`, then:

```bash
rm ~/.gmail-mcp/token.json
node bin/gmail-cli.js auth   # re-runs consent with the new scope list
```

## Advanced: Push notifications (`watch`)

Gmail's push-notification feature requires a Cloud Pub/Sub topic and an IAM grant for `gmail-api-push@system.gserviceaccount.com`. Out of scope for this setup. Use `gcloud pubsub topics create` and follow the [Gmail push docs](https://developers.google.com/workspace/gmail/api/guides/push) when you actually need it.

## Troubleshooting

- **invalid_grant on refresh:** test user removed from consent screen, or token revoked. Delete `~/.gmail-mcp/token.json` and re-run `auth`.
- **403 PERMISSION_DENIED on first call:** Gmail API isn't enabled on the project that owns your OAuth client. Open the project in Cloud Console and enable Gmail API.
- **"This app is blocked":** you tried to use gcloud's ADC for Gmail. That doesn't work — see "Why a Cloud Console step" above. Use the Desktop OAuth client you create here instead.
- **Quota:** 1B units/day, 250 units/user/sec. Effectively unbounded for personal use.
