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

- `start_github_login()` command — returns `Result<String, String>`, the
  authorize URL, as soon as the flow is armed:
  1. Generate random `state` (`getrandom` crate — the one new dependency).
  2. Bind a `std::net::TcpListener` on `127.0.0.1:43117` through
     `bind_with_retry`. The listener is **not** one-shot: it keeps accepting
     until the callback arrives, the deadline passes, or the flow is
     cancelled. A busy port surfaces an `AddrInUse`-specific message telling
     the user another sign-in is already in flight (the generic bind error
     names the address and the OS error, which reads as a bug).
  3. Open `https://github.com/login/oauth/authorize?client_id=…&state=…`
     via the opener plugin. **A failed browser open is non-fatal**: the
     command still returns the URL, and the UI offers it as a
     copy-pasteable link.
  4. Background thread: accept in a loop with a **5-minute deadline**; parse
     `GET /callback?code=…&state=…`; validate `state`; answer the browser
     with a tiny "signed in — close this tab" HTML page.
  5. Exchange the code at `https://github.com/login/oauth/access_token`
     (JSON accept header) over the shared `ureq` agent with client
     ID/secret/redirect_uri.
  5b. **Verify before storing**: `verify_access` sends
     `query { viewer { login } }` with the new access token and requires an
     account back. A token that cannot be confirmed must never replace a
     working credential — otherwise a transient failure right after the
     write leaves the UI naming the old account while every request runs as
     the new one.
  6. Store tokens (below), emit Tauri event `github-login` with `{ok: true}`
     or `{ok: false, error}`.
- `cancel_github_login()` command (cancel button, Welcome unmount): sets a
  shared `AtomicBool`. It does **not** tear the listener down itself — the
  listener thread notices the flag within one 100 ms poll and drops its
  socket then. That gap is exactly why `bind_with_retry` exists: a new
  sign-in started immediately after a cancel would otherwise lose the race
  for port 43117. Do not "simplify" the retry loop away.
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
- `resolve_token` is a **pure read** (cache → keychain → legacy migration).
  It deliberately never refreshes: `has_token` calls it for the startup
  "am I signed in?" probe, and refreshing there would put a network round
  trip on launch and burn the single-use refresh token before anything
  needed it. The `needs_refresh(expires_at, now)` check — 60 s of slack —
  lives in `github_graphql`/`execute_graphql`, at the point of use.
- `github_graphql` does **one** refresh-and-retry on an unexpected 401 when a
  refresh token exists; otherwise current behaviour (rejected-token guard
  stays for the non-refreshable case).
- Refresh grant: POST `login/oauth/access_token` with
  `grant_type=refresh_token`. Failure is **split by cause**, and the split is
  load-bearing:
  - **Rejected** — GitHub answered `200` with an `error` field. That body is
    the *only* definitive verdict on the grant, so the entry is cleared →
    `authenticated=false` → Welcome. Keeping it would loop the app through
    401s forever.
  - **Unreachable** — transport failure, unreadable body, **or any non-2xx
    status**. A status is never a verdict: a 429 is a secondary rate limit, a
    403 is abuse detection, and both are commonly an intercepting proxy.
    The credential is **kept** and a transient error reported; an offline user
    must never be signed out by a network blip. A failed attempt also arms a
    15 s backoff so an offline sweep does not re-attempt once per query.
  - **Unusable** — this build has no compiled-in credentials, so no refresh can
    ever succeed. Terminal, but the credential is **kept**: it may still be
    perfectly valid, and rebuilding with a `.env` must not have cost the user
    their token. Reported as `not_authenticated` so Welcome explains itself.
  - A **superseded** credential is not a rejection: if the keychain has moved
    on while a refresh was in flight, the newer pair is returned and the
    request retries with it.
- `clear_token` wipes the whole JSON entry (access + refresh together).

### Frontend

- **Welcome**: one primary "Sign in with GitHub" button → waiting state with
  Cancel → listens for `github-login` → existing `fetchViewer` →
  `authenticated` path unchanged. Quiet link "Install Repo Crew on your
  account" → `github.com/apps/<slug>/installations/new`. Credentials-missing
  builds show an explanatory error instead of the button.
- **Settings**: Token section becomes part of the Account card — *Sign in
  again* and *Disconnect* (existing `clear_token`). All PAT UI deleted.
- **Empty states**: Fleet gets the install link — "app installed nowhere" is
  indistinguishable from "no repos" and needs the way out. Sweep does not
  duplicate it: its empty state points the user at Fleet instead, so the
  `oauth_config` fetch and the slug-less fallback live in one place.

## Error handling

- Port 43117 busy → command error, shown as toast.
- `state` mismatch → HTTP 400 to *that request*, logged, keychain untouched,
  and the **listener keeps waiting**. It must not abort: any local process can
  connect to port 43117 (a port scanner, a hostile page firing a cross-origin
  GET), and ending the flow on one bad request would hand it a one-packet DoS
  against a sign-in in flight. Only the 5-minute deadline or an explicit
  cancel ends the wait. A callback with no `code` is treated the same way.
- Browser abandoned → 5-minute timeout → error event.
- Exchange non-200 / GitHub `error` field → pass `error_description` through.
- Refresh rejected by GitHub → clear entry, `authenticated=false`, Welcome.
- Refresh unreachable → keep the entry, report a transient error.

## Behavioural gotcha (accepted)

User-to-server tokens only see repositories where the app is **installed**.
A fresh sign-in shows an empty fleet until the user installs the app on their
account/orgs — hence the install links. The owner installs it on `quinnjr`
once.

## Testing

- Rust unit tests (pure seams): callback query parsing, stored-token JSON
  round-trip incl. bare-string migration, `needs_refresh(expires_at, now)`,
  exchange-response parsing with and without refresh fields.
- Existing gates stay green: svelte-check, vitest, cargo test, oxlint,
  clippy `-D warnings`.
- Full browser round-trip is a manual check (needs a real GitHub session).

## Out of scope

- Device flow, deep-link scheme, installation tokens/JWT, webhook handling,
  multiple accounts.
