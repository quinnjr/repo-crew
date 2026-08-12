# GitHub App sign-in (loopback OAuth) — design

Date: 2026-08-12
Status: implemented (same day)

## Goal

Replace the paste-a-PAT flow with a browser "Sign in with GitHub" backed by the
user's existing GitHub App, so sign-in is one click and the app is
distributable to people who should never have to mint a token. The token acts
as the signed-in user (user-to-server). **No app private key is involved or
shipped** — that key mints installation tokens and stays wherever the app
owner keeps it.

## Decisions (made with the user)

- **Flow**: loopback authorization-code flow (GitHub Desktop pattern), not
  device flow. Callback on `http://127.0.0.1:43117/callback`.
- **Credentials**: client ID + client secret embedded at **build time** via
  `option_env!` — `REPO_CREW_GH_CLIENT_ID`, `REPO_CREW_GH_CLIENT_SECRET`,
  `REPO_CREW_GH_APP_SLUG`. Never committed (repo is public). A build without
  them runs; the sign-in button reports "this build has no OAuth credentials".
- **PAT flow**: **removed** (not a fallback). `set_token`/`validate_token`
  commands and all token-paste UI are deleted.
- **Token expiry**: unknown whether the app expires user tokens — handle both.
  Refresh when a refresh token exists; plain long-lived token otherwise.
- **Auth model**: user sign-in only. No JWT/private-key/installation-token
  path.

## One-time app configuration (manual, on github.com)

- Callback URL: `http://127.0.0.1:43117/callback`
- Webhook: disabled
- Repository permissions: Contents **RW** (merge needs it), Pull requests
  **RW**, Issues **RW**, Metadata **RO**
- "Expire user authorization tokens": either setting works

## Architecture

### New: `src-tauri/src/oauth.rs`

- `start_github_login()` command:
  1. Generate random `state` (`getrandom` crate — the one new dependency).
  2. Bind one-shot `std::net::TcpListener` on `127.0.0.1:43117`; friendly
     error if busy ("another sign-in attempt is running").
  3. Open `https://github.com/login/oauth/authorize?client_id=…&state=…`
     via the opener plugin; return immediately.
  4. Background thread: accept with a **5-minute deadline**; parse
     `GET /callback?code=…&state=…`; validate `state`; answer the browser
     with a tiny "signed in — close this tab" HTML page.
  5. Exchange the code at `https://github.com/login/oauth/access_token`
     (JSON accept header) over the shared `ureq` agent with client
     ID/secret/redirect_uri.
  6. Store tokens (below), emit Tauri event `github-login` with `{ok: true}`
     or `{ok: false, error}`.
- `cancel_github_login()` command: tears down the listener (cancel button,
  Welcome unmount).
- `oauth_config()` command: returns `{configured: bool, slug: string | null}`
  so the UI can render the install link and the credentials-missing state.

Secrets never cross IPC: the webview sees only the event payload and
`oauth_config`.

### Token storage & refresh (changes in `lib.rs`)

- The existing keychain entry (`dev.quinnjr.repo-crew` / `github-token`)
  stores JSON: `{"access": "…", "refresh": "…", "expires_at": 1755…}` —
  `refresh`/`expires_at` absent for non-expiring tokens.
- **Migration**: a stored value that does not parse as JSON is a bare access
  token (existing installs keep working until they sign out).
- `resolve_token` refreshes proactively when `expires_at` is within 60 s.
- `github_graphql` does **one** refresh-and-retry on an unexpected 401 when a
  refresh token exists; otherwise current behaviour (rejected-token guard
  stays for the non-refreshable case).
- Refresh grant: POST `login/oauth/access_token` with
  `grant_type=refresh_token`. A failed refresh clears the entry → Welcome.
- `clear_token` wipes the whole JSON entry (access + refresh together).

### Frontend

- **Welcome**: one primary "Sign in with GitHub" button → waiting state with
  Cancel → listens for `github-login` → existing `fetchViewer` →
  `authenticated` path unchanged. Quiet link "Install Repo Crew on your
  account" → `github.com/apps/<slug>/installations/new`. Credentials-missing
  builds show an explanatory error instead of the button.
- **Settings**: Token section becomes part of the Account card — *Sign in
  again* and *Disconnect* (existing `clear_token`). All PAT UI deleted.
- **Empty states** (Fleet/Sweep): add the install link — "app installed
  nowhere" is indistinguishable from "no repos" and needs the way out.

## Error handling

- Port 43117 busy → command error, shown as toast.
- `state` mismatch → reject the request, keychain untouched, error event.
- Browser abandoned → 5-minute timeout → error event.
- Exchange non-200 / GitHub `error` field → pass `error_description` through.
- Refresh failure → clear entry, `authenticated=false`, Welcome.

## Behavioural gotcha (accepted)

User-to-server tokens only see repositories where the app is **installed**.
A fresh sign-in shows an empty fleet until the user installs the app on their
account/orgs — hence the install links. The owner installs it on `quinnjr`
once.

## Testing

- Rust unit tests (pure seams): callback query parsing, stored-token JSON
  round-trip incl. bare-string migration, `needs_refresh(expires_at, now)`,
  exchange-response parsing with and without refresh fields.
- Existing gates stay green: svelte-check, vitest (98), cargo test, oxlint,
  clippy `-D warnings`.
- Full browser round-trip is a manual check (needs a real GitHub session).

## Out of scope

- Device flow, deep-link scheme, installation tokens/JWT, webhook handling,
  multiple accounts.
