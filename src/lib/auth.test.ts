import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: [] as ((e: { payload: unknown }) => void)[],
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, fn: (e: { payload: unknown }) => void) => {
    listeners.push(fn)
    return Promise.resolve(() => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    })
  },
}))
vi.mock('./graphql', () => ({
  fetchViewer: vi.fn(async () => ({ id: 'U1', login: 'quinnjr', name: null, avatarUrl: null })),
}))

import { cancelSignIn, installUrl, signInWithGitHub, SignInCancelled } from './auth'
import { authenticated, viewer } from './stores'

const emitLogin = (payload: unknown) => {
  for (const fn of [...listeners]) fn({ payload })
}

/** Let the promise chain inside signInWithGitHub reach its await points. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  listeners.length = 0
  authenticated.set(null)
  viewer.set(null)
})

describe('signInWithGitHub', () => {
  it('signs the session in when the backend reports ok', async () => {
    const flow = signInWithGitHub()
    await settle()
    expect(invokeMock).toHaveBeenCalledWith('start_github_login')
    emitLogin({ ok: true })
    await flow
    expect(get(authenticated)).toBe(true)
    expect(get(viewer)?.login).toBe('quinnjr')
  })

  it('hands the authorize URL to the caller for copy-paste', async () => {
    invokeMock.mockResolvedValueOnce('https://github.com/login/oauth/authorize?client_id=x&state=y')
    const seen: string[] = []
    const flow = signInWithGitHub((url) => seen.push(url))
    await settle()
    expect(seen).toEqual(['https://github.com/login/oauth/authorize?client_id=x&state=y'])
    emitLogin({ ok: true })
    await flow
  })

  it('surfaces the backend error and leaves the stores untouched', async () => {
    const flow = signInWithGitHub()
    await settle()
    emitLogin({ ok: false, error: 'callback state mismatch' })
    await expect(flow).rejects.toThrow('callback state mismatch')
    expect(get(authenticated)).toBeNull()
    expect(get(viewer)).toBeNull()
  })

  it('stops listening once the flow settles', async () => {
    const flow = signInWithGitHub()
    await settle()
    emitLogin({ ok: true })
    await flow
    await settle()
    expect(listeners).toHaveLength(0)
  })
})

describe('cancelSignIn', () => {
  it('rejects the pending flow with SignInCancelled and tells the backend', async () => {
    const flow = signInWithGitHub()
    await settle()
    await cancelSignIn()
    await expect(flow).rejects.toBeInstanceOf(SignInCancelled)
    expect(invokeMock).toHaveBeenCalledWith('cancel_github_login')
  })

  it('is safe to call with nothing in flight', async () => {
    invokeMock.mockRejectedValueOnce('no flow')
    await expect(cancelSignIn()).resolves.toBeUndefined()
  })
})

describe('installUrl', () => {
  it('points at the GitHub App installation page', () => {
    expect(installUrl('repo-crew')).toBe('https://github.com/apps/repo-crew/installations/new')
  })
})
