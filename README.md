# Repo Crew

A desktop cockpit for maintaining a fleet of GitHub repositories: sweep every
open Dependabot update and issue across all of them at once, pivot the board
from *repo → PRs* to *change → repos* (one `lodash` bump open in nine repos is
one row and one merge), and act in bulk without leaving the keyboard.

Tauri 2 + Svelte 5 (runes) + TypeScript, talking to the GitHub GraphQL v4 API.

## Development

```sh
pnpm install
pnpm tauri dev
```

Sign-in credentials come from a gitignored `.env` at the repo root, which
`src-tauri/build.rs` forwards into the compile (real environment variables
take precedence, so CI/makepkg can override it):

```sh
REPO_CREW_GH_CLIENT_ID=…      # GitHub App client id
REPO_CREW_GH_CLIENT_SECRET=…  # GitHub App client secret
REPO_CREW_GH_APP_SLUG=…       # app slug, for the install-page links
```

## Sign-in (GitHub App)

Sign-in is a browser OAuth flow against a GitHub App — the loopback pattern:
the app listens on `http://127.0.0.1:43117/callback` — accepting until the
redirect arrives, the five-minute deadline passes, or you cancel — opens
github.com/login/oauth/authorize, and exchanges the redirect code for a
user-to-server token. Organisation SSO happens in the browser like any other
GitHub sign-in. The resulting credential (access token, plus refresh token
when the app has user-token expiry enabled) is stored in the OS keychain
(Secret Service on Linux — `gnome-keyring`, KWallet, or KeePassXC must be
running), never on disk. The webview never sees any secret: the Rust side
owns the code exchange, the keychain, and the GraphQL proxy, and refreshes
expiring tokens automatically.

The three `REPO_CREW_GH_*` values are compiled in via `option_env!` and are
deliberately not in this repository. A build without them runs, but the
sign-in screen reports itself unconfigured. The GitHub App needs:

- Callback URL `http://127.0.0.1:43117/callback`, webhook disabled
- Repository permissions: Contents RW, Pull requests RW, Issues RW,
  Metadata RO

The client secret is compiled into every binary we ship, including the Arch
package, so anyone holding a build can recover it. That is the normal design
for a desktop GitHub client (GitHub Desktop does the same), and PKCE is not an
alternative here: GitHub does not support it for GitHub App user-to-server
flows. So treat the secret as public — it is not a confidentiality boundary.
What bounds the risk is the loopback redirect: a stolen secret can still only
receive authorization codes delivered to `127.0.0.1:43117` on the victim's own
machine. Rotate the secret if you suspect abuse, and turn on "Expire user
authorization tokens" on the App so any intercepted user token is short-lived.

There is **no app private key** in the binary, ever — user sign-in does not
use one, and shipping it would hand out installation tokens for every install
of the app. Note that a user token only sees repositories where the app is
installed, so a fresh sign-in starts from an empty fleet until the app is
installed on your account.

## The five gates

All five must be green before a commit:

```sh
pnpm check        # svelte-check over the whole tree
pnpm test         # vitest + cargo test
pnpm build        # vite production build
pnpm lint         # oxlint over src/
pnpm lint:rust    # cargo clippy -D warnings
```

## Constraints

- **TypeScript is held at major 6** (`^6`): `svelte-check` rejects
  TypeScript 7. Do not let an upgrade sweep move it.
- **webkit2gtk 4.1**, not 4.0 — Tauri v2 switched; packaging deps reflect it.
- **Five gate commands**, all of which must pass before a commit and which CI
  runs in this order: `pnpm check`, `pnpm lint`, `pnpm lint:rust`,
  `pnpm test`, `pnpm build`.

## Branching

git-flow (AVH), initialised with the stock layout: `main` carries releases
only, `develop` (the GitHub default branch) is the integration line, and work
happens on `feature/*` / `bugfix/*` branches cut from `develop`. Releases go
through `release/*` and land on `main` with a `v`-prefixed tag (`v0.2.0`);
urgent fixes to a released version go through `hotfix/*` off `main`.

```sh
git flow feature start <name>    # branch off develop
git flow feature finish <name>   # merge back into develop
git flow release start 0.2.0     # stabilise; finish tags v0.2.0 on main
```

## Packaging

`packaging/arch/PKGBUILD` builds from committed state via `git+file://` — it
packages nothing until the work is committed. It lives under `packaging/`
because `makepkg` creates `./src` and `./pkg`, which would collide with the
app's `src/` at the repo root.

## Licence

Dual-licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Unless you explicitly state otherwise, any contribution
intentionally submitted for inclusion in the work by you, as defined in the
Apache-2.0 license, shall be dual licensed as above, without any additional
terms or conditions.
