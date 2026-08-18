import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const { invokeMock, listeners, fetchViewerMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: [] as ((e: { payload: unknown }) => void)[],
  fetchViewerMock: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  // Registers only once the returned promise settles, mirroring the real IPC:
  // the webview->core subscription is not live until then, and `emit` on the
  // Rust side drops events with no listener. A mock that pushed synchronously
  // made the "subscribes before starting the flow" test pass against the
  // un-awaited version too, so it guarded nothing.
  listen: (_name: string, fn: (e: { payload: unknown }) => void) =>
    Promise.resolve().then(() => {
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    }),
}))
vi.mock('./graphql', () => ({ fetchViewer: fetchViewerMock }))

import { cancelSignIn, copyLoginLink, installUrl, signInWithGitHub, SignInCancelled } from './auth'
import { authenticated, viewer } from './stores'

const emitLogin = (payload: unknown) => {
  // Iterate a copy: a listener that settles the flow unsubscribes itself,
  // mutating `listeners` mid-loop.
  for (const fn of listeners.slice()) fn({ payload })
}

/**
 * Wait on the precondition `emitLogin` actually depends on, and fail loudly if
 * it never holds: firing into an empty listener array leaves the sign-in
 * promise pending, which shows up as the whole file hanging to the vitest
 * timeout instead of as one failing assertion.
 */
const armed = async () => {
  for (let i = 0; i < 50 && listeners.length === 0; i++) await Promise.resolve()
  expect(listeners).toHaveLength(1)
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  fetchViewerMock.mockReset()
  fetchViewerMock.mockResolvedValue({ id: 'U1', login: 'quinnjr', name: null, avatarUrl: null })
  listeners.length = 0
  authenticated.set(null)
  viewer.set(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signInWithGitHub', () => {
  it('signs the session in when the backend reports ok', async () => {
    const flow = signInWithGitHub()
    await armed()
    emitLogin({ ok: true })
    await flow
    expect(invokeMock).toHaveBeenCalledWith('start_github_login')
    expect(get(authenticated)).toBe(true)
    expect(get(viewer)?.login).toBe('quinnjr')
  })

  it('hands the authorize URL to the caller for copy-paste', async () => {
    invokeMock.mockResolvedValueOnce('https://github.com/login/oauth/authorize?client_id=x&state=y')
    const seen: string[] = []
    const flow = signInWithGitHub((url) => seen.push(url))
    await armed()
    emitLogin({ ok: true })
    await flow
    expect(seen).toEqual(['https://github.com/login/oauth/authorize?client_id=x&state=y'])
  })

  it('subscribes to github-login before starting the flow', async () => {
    // The backend's `emit` drops an event with no listener, so an event that
    // lands the instant the browser returns must still be caught: the
    // subscription has to exist before `start_github_login` is called at all.
    const order: string[] = []
    invokeMock.mockImplementationOnce(async () => {
      order.push(`invoke:${listeners.length}`)
      return 'https://github.com/login/oauth/authorize'
    })
    const flow = signInWithGitHub()
    await armed()
    emitLogin({ ok: true })
    await flow
    expect(order).toEqual(['invoke:1'])
  })

  it('surfaces the backend error and leaves the stores untouched', async () => {
    const flow = signInWithGitHub()
    await armed()
    emitLogin({ ok: false, error: 'timed out waiting for the browser — try signing in again' })
    await expect(flow).rejects.toThrow('timed out waiting for the browser — try signing in again')
    expect(get(authenticated)).toBeNull()
    expect(get(viewer)).toBeNull()
  })

  it('does not claim to be signed out when the token stored but no account came back', async () => {
    fetchViewerMock.mockResolvedValueOnce(null)
    const flow = signInWithGitHub()
    await armed()
    emitLogin({ ok: true })
    await expect(flow).rejects.toThrow(/^Signed in, but/)
    // The credential is in the keychain, but nothing here may pretend the
    // session is usable — the views read these two stores.
    expect(get(authenticated)).toBeNull()
    expect(get(viewer)).toBeNull()
  })

  it('stops listening once the flow settles', async () => {
    const flow = signInWithGitHub()
    await armed()
    emitLogin({ ok: true })
    await flow
    expect(listeners).toHaveLength(0)
  })
})

describe('cancelSignIn', () => {
  it('rejects the pending flow with SignInCancelled and tells the backend', async () => {
    const flow = signInWithGitHub()
    await armed()
    await cancelSignIn()
    await expect(flow).rejects.toBeInstanceOf(SignInCancelled)
    expect(invokeMock).toHaveBeenCalledWith('cancel_github_login')
  })

  it('is safe to call with nothing in flight', async () => {
    invokeMock.mockRejectedValueOnce('no flow')
    await expect(cancelSignIn()).resolves.toBeUndefined()
  })

  it('still cancels a newer flow after an older one settled', async () => {
    const first = signInWithGitHub()
    await armed()
    emitLogin({ ok: true })
    await first

    const second = signInWithGitHub()
    await armed()
    await cancelSignIn()
    await expect(second).rejects.toBeInstanceOf(SignInCancelled)
  })
})

describe('copyLoginLink', () => {
  it('selects the input so Ctrl+C works when the clipboard is denied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    const select = vi.fn()
    await copyLoginLink('https://github.com/login/oauth/authorize', { select } as unknown as HTMLInputElement)
    expect(select).toHaveBeenCalledOnce()
  })

  it('survives a denied clipboard with no input to fall back on', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    await expect(copyLoginLink('https://github.com/login/oauth/authorize', null)).resolves.toBeUndefined()
  })
})

describe('oauthConfig', () => {
  it('caches the answer but never a failure', async () => {
    // Fresh module so the memo slot starts empty; the assertion that matters is
    // the call count — a cached failure would brand the build unconfigured for
    // the whole process after one transient IPC error.
    vi.resetModules()
    invokeMock.mockReset()
    invokeMock.mockRejectedValueOnce('ipc unavailable')
    invokeMock.mockResolvedValue({ configured: true, slug: 'repo-crew' })
    const { oauthConfig } = await import('./auth')

    await expect(oauthConfig()).rejects.toBe('ipc unavailable')
    expect(await oauthConfig()).toEqual({ configured: true, slug: 'repo-crew' })
    expect(await oauthConfig()).toEqual({ configured: true, slug: 'repo-crew' })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})

describe('installUrl', () => {
  it('points at the GitHub App installation page', () => {
    expect(installUrl('repo-crew')).toBe('https://github.com/apps/repo-crew/installations/new')
  })
})
