import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEPENDABOT_CACHE_KEY,
  ISSUES_CACHE_KEY,
  REPOS_CACHE_KEY,
  VIEWER_CACHE_KEY,
  asCachedDependabot,
  clearCache,
  asCachedIssues,
  asCachedRepos,
  asCachedViewer,
  readCache,
  writeCache,
} from './cache'
import { installFakeStorage, makePr, makeRepo, removeFakeStorage } from './fixtures'

let backing: Map<string, string>

beforeEach(() => {
  backing = installFakeStorage()
})

afterEach(removeFakeStorage)

describe('writeCache / readCache', () => {
  it('round-trips data stored under the same scope', () => {
    writeCache('k', 'acme/a,acme/b', { n: 1 })
    expect(readCache('k', 'acme/a,acme/b', (v) => v as { n: number })).toEqual({ n: 1 })
  })

  it('returns null when the stored scope differs from the current one', () => {
    writeCache('k', 'acme/a', { n: 1 })
    expect(readCache('k', 'acme/a,acme/b', (v) => v as { n: number })).toBeNull()
  })

  it('returns null when nothing was stored', () => {
    expect(readCache('k', '', (v) => v as object)).toBeNull()
  })

  it('returns null for malformed JSON instead of throwing', () => {
    backing.set('k', '{not json')
    expect(readCache('k', '', (v) => v as object)).toBeNull()
  })

  it('returns null when the entry version is not the current one', () => {
    writeCache('k', '', { n: 1 })
    const entry = JSON.parse(backing.get('k') ?? '{}') as Record<string, unknown>
    backing.set('k', JSON.stringify({ ...entry, v: 999 }))
    expect(readCache('k', '', (v) => v as object)).toBeNull()
  })

  it('returns null when the validator rejects the payload', () => {
    writeCache('k', '', 'garbage')
    expect(readCache('k', '', (v) => (Array.isArray(v) ? v : null))).toBeNull()
  })

  it('clearCache removes every cache entry', () => {
    for (const key of [VIEWER_CACHE_KEY, REPOS_CACHE_KEY, DEPENDABOT_CACHE_KEY, ISSUES_CACHE_KEY]) {
      writeCache(key, '', { n: 1 })
    }
    clearCache()
    for (const key of [VIEWER_CACHE_KEY, REPOS_CACHE_KEY, DEPENDABOT_CACHE_KEY, ISSUES_CACHE_KEY]) {
      expect(readCache(key, '', (v) => v as object)).toBeNull()
    }
  })

  it('survives localStorage being unavailable', () => {
    removeFakeStorage()
    expect(() => writeCache('k', '', { n: 1 })).not.toThrow()
    expect(readCache('k', '', (v) => v as object)).toBeNull()
  })
})

describe('asCachedViewer', () => {
  it('accepts a stored viewer', () => {
    const v = { id: 'U_1', login: 'octocat', name: null, avatarUrl: null }
    expect(asCachedViewer(v)).toEqual(v)
  })

  it.each([null, 42, 'octocat', {}, { id: 'U_1' }, { login: 'octocat' }])(
    'rejects %o',
    (v) => {
      expect(asCachedViewer(v)).toBeNull()
    },
  )

  it('fills optional fields a past version may not have stored', () => {
    expect(asCachedViewer({ id: 'U_1', login: 'octocat' })).toEqual({
      id: 'U_1',
      login: 'octocat',
      name: null,
      avatarUrl: null,
    })
  })
})

describe('asCachedRepos', () => {
  it('accepts a stored repo list', () => {
    const repos = [makeRepo(), makeRepo()]
    expect(asCachedRepos(repos)).toEqual(repos)
  })

  it('drops malformed rows and keeps the rest', () => {
    const good = makeRepo()
    expect(asCachedRepos([good, { id: 'R_9' }, null, 'x'])).toEqual([good])
  })

  it.each([null, 42, {}, 'repos'])('rejects the non-array %o outright', (v) => {
    expect(asCachedRepos(v)).toBeNull()
  })
})

describe('asCachedDependabot', () => {
  it('accepts a stored result', () => {
    const prs = [makePr()]
    expect(asCachedDependabot({ prs, truncated: ['acme/a'] })).toEqual({ prs, truncated: ['acme/a'] })
  })

  it('drops malformed PR rows and non-string truncation entries', () => {
    const good = makePr()
    expect(asCachedDependabot({ prs: [good, { id: 'PR_9' }], truncated: ['acme/a', 7] })).toEqual({
      prs: [good],
      truncated: ['acme/a'],
    })
  })

  it.each([null, [], { prs: 'x' }, { truncated: [] }])('rejects %o', (v) => {
    expect(asCachedDependabot(v)).toBeNull()
  })
})

describe('asCachedIssues', () => {
  const makeIssue = () => ({
    id: 'I_1',
    number: 1,
    title: 'Bug',
    url: 'https://example.invalid',
    state: 'OPEN' as const,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    body: null,
    author: null,
    labels: [],
    comments: { totalCount: 0 },
    assignees: { nodes: [] },
    issueType: null,
    repo: 'acme/api',
    repoShort: 'api',
  })

  it('accepts a stored result', () => {
    const issues = [makeIssue()]
    expect(asCachedIssues({ issues, truncated: [] })).toEqual({ issues, truncated: [] })
  })

  it('drops malformed issue rows', () => {
    const good = makeIssue()
    expect(asCachedIssues({ issues: [good, { id: 'I_9' }], truncated: [] })).toEqual({
      issues: [good],
      truncated: [],
    })
  })

  it.each([null, [], { issues: 'x' }])('rejects %o', (v) => {
    expect(asCachedIssues(v)).toBeNull()
  })
})
