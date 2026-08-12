import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { authenticated, toast, viewer } from './stores'
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
  const unlistenReady = (() => {
    let deliver: (e: LoginEvent) => void = () => {}
    const outcome = new Promise<LoginEvent>((resolve, reject) => {
      deliver = resolve
      // The backend is silent about a cancelled flow, so the promise is
      // settled from `cancelSignIn` instead of leaking a listener forever.
      abandonPending = () => reject(new SignInCancelled())
    })
    return { unlisten: listen<LoginEvent>('github-login', (event) => deliver(event.payload)), outcome }
  })()

  try {
    const url = await invoke<string>('start_github_login')
    onUrl?.(url)
    const result = await unlistenReady.outcome
    if (!result.ok) throw new Error(result.error ?? 'sign-in failed')

    const me = await fetchViewer()
    if (!me) throw new Error('GitHub returned no account for the new token')
    viewer.set(me)
    authenticated.set(true)
  } finally {
    abandonPending = null
    unlistenReady.unlisten.then((unlisten) => unlisten()).catch(() => {})
  }
}

/** Abandon the in-flight sign-in, if any. */
export const cancelSignIn = async (): Promise<void> => {
  abandonPending?.()
  await invoke('cancel_github_login').catch(() => {
    /* nothing in flight */
  })
}
