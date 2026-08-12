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

The GitHub token is stored in the OS keychain (Secret Service on Linux —
`gnome-keyring`, KWallet, or KeePassXC must be running), never on disk. The
webview never sees it: the Rust side holds the credential and proxies the
GraphQL calls.

## The five gates

All five must be green before a commit:

```sh
pnpm check        # svelte-check over the whole tree
pnpm test         # vitest + cargo test
pnpm build        # vite production build
pnpm lint         # oxlint over src/
pnpm lint:rust    # cargo clippy -D warnings
```

## Version pins worth knowing

- **TypeScript is pinned to major 6** (`^6`): svelte-check does not accept
  TypeScript 7. Do not let an upgrade sweep move it.
- **webkit2gtk 4.1**, not 4.0 — Tauri v2 switched; packaging deps reflect it.

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
