import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { authenticated, keychainError, toast, viewer } from './stores'
import { fetchViewer } from './graphql'

/** What the backend is willing to tell the webview about the OAuth setup. */
export type OauthConfig = { configured: boolean; slug: string | null }

/**
 * Memoized: the values are fixed at compile time, and three views ask for
 * them on mount (Fleet on every remount) — one IPC round trip covers the
 * process lifetime. A failed call is not cached, so a transient IPC error
 * does not brand the build unconfigured forever.
 */
let configFlight: Promise<OauthConfig> | null = null
export const oauthConfig = (): Promise<OauthConfig> => {
  configFlight ??= invoke<OauthConfig>('oauth_config').catch((e: unknown) => {
    // Load-bearing, not a tidy-up: dropping the flight on failure is what
    // keeps the negative result out of the cache. Without it one dropped IPC
    // call during startup would make every later caller — including the
    // sign-in button's enablement check — believe the build ships no GitHub
    // App for the rest of the process lifetime, with no way back but a restart.
    configFlight = null
    throw e
  })
  return configFlight
}

/**
 * Copy the sign-in link, falling back to selecting it in the given input
 * when the webview denies clipboard access — a manual Ctrl+C still works.
 */
export const copyLoginLink = async (url: string, fallback: HTMLInputElement | null): Promise<void> => {
  try {
    await navigator.clipboard.writeText(url)
    toast('Sign-in link copied', { kind: 'success' })
  } catch {
    fallback?.select()
    toast('Press Ctrl+C to copy the selected link', { kind: 'info' })
  }
}

/** Where a user grants the GitHub App access to their repositories. */
export const installUrl = (slug: string): string => `https://github.com/apps/${slug}/installations/new`

/**
 * The slug-independent fallback for "install this app somewhere".
 *
 * A build without `REPO_CREW_GH_APP_SLUG` cannot form the app's own install
 * URL, and hiding the link entirely left the one correct instruction
 * unreachable from every screen. This page always works.
 */
export const INSTALLATIONS_URL = 'https://github.com/settings/installations'


type LoginEvent = { ok: boolean; error?: string }

/** Thrown when the sign-in ended because this app asked it to. */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled')
    this.name = 'SignInCancelled'
  }
}

/** Settles the in-flight sign-in promise when the flow is cancelled locally. */
let abandonPending: (() => void) | null = null

/**
 * Run the whole browser sign-in: open the browser, wait for the backend's
 * `github-login` event, then load the viewer and flip the auth stores.
 * Resolves once the app is signed in; rejects with `SignInCancelled` when
 * `cancelSignIn` was used, or an `Error` carrying the reason otherwise.
 *
 * Tokens never appear here — the Rust side owns the code exchange and the
 * keychain, and this promise only learns "ok" or an error string.
 *
 * `onUrl` receives the authorize link as soon as the flow is armed, so the
 * UI can offer it copy-pasteable — the backend treats a browser that refuses
 * to open as non-fatal for exactly this path.
 */
export const signInWithGitHub = async (onUrl?: (url: string) => void): Promise<void> => {
  let deliver: (e: LoginEvent) => void = () => {}
  let abandon: () => void = () => {}
  const outcome = new Promise<LoginEvent>((resolve, reject) => {
    deliver = resolve
    // The backend is silent about a cancelled flow, so the promise is
    // settled from `cancelSignIn` instead of leaking a listener forever.
    abandon = () => reject(new SignInCancelled())
  })
  abandonPending = abandon

  let unlisten: (() => void) | null = null
  try {
    // Awaited before the flow opens: `listen` resolves only once the
    // webview→core subscription is registered, and Rust's `emit` silently
    // drops an event nobody is listening for. Starting the login first races
    // that registration, and losing the event leaves `outcome` pending
    // forever — the UI sits on "Waiting for your browser…" past the backend's
    // own deadline, with Cancel the only way out.
    unlisten = await listen<LoginEvent>('github-login', (event) => deliver(event.payload))

    const url = await invoke<string>('start_github_login')
    onUrl?.(url)
    const result = await outcome
    if (!result.ok) throw new Error(result.error ?? 'sign-in failed')

    const me = await fetchViewer()
    // The token is already exchanged, verified and in the keychain by now, so
    // this is not a failed sign-in and must not read like one — and no
    // rollback: deleting a valid credential because one query came back empty
    // would be the worse outcome. The next launch loads the account fine.
    if (!me) throw new Error('Signed in, but your GitHub account could not be loaded — reopen the app')
    viewer.set(me)
    authenticated.set(true)
  } finally {
    // A flow started after this one owns the slot now; only its own owner
    // clears it, or cancelling the newer flow would silently do nothing.
    if (abandonPending === abandon) abandonPending = null
    unlisten?.()
  }
}

/** Abandon the in-flight sign-in, if any. */
export const cancelSignIn = async (): Promise<void> => {
  abandonPending?.()
  await invoke('cancel_github_login').catch(() => {
    /* nothing in flight */
  })
}

/**
 * Probe the stored credential and settle `authenticated`/`viewer`/`keychainError`.
 *
 * Exported rather than living inside `App.svelte` so a view can genuinely
 * re-run it: the keychain error state is recoverable (unlock the keyring, start
 * gnome-keyring) and the only honest Retry is another probe, not a page reload.
 */
export const bootstrapSession = async (): Promise<void> => {
  let stored: boolean
  try {
    stored = await invoke<boolean>('has_token')
  } catch (e) {
    // has_token only fails when the keychain itself is unusable — a locked or
    // absent Secret Service. Recorded in a store, not just a dismissible toast,
    // so Welcome can name the problem instead of inviting the user into a
    // sign-in that would fail at the store step.
    const message = e instanceof Error ? e.message : String(e)
    keychainError.set(message)
    authenticated.set(false)
    toast(`Could not read the stored credential: ${message}`, { kind: 'error', sticky: true })
    return
  }
  keychainError.set(null)

  if (!stored) {
    authenticated.set(false)
    return
  }

  try {
    const me = await fetchViewer()
    // A null viewer with a stored token is a failure, not a signed-in state:
    // every view needs the login, and `loadRepos` would throw on it anyway.
    if (!me) throw new Error('GitHub returned no account for the stored token')
    viewer.set(me)
    authenticated.set(true)
  } catch (e) {
    authenticated.set(false)
    toast(`That credential no longer works: ${e instanceof Error ? e.message : e}`, {
      kind: 'error',
      sticky: true,
    })
  }
}
