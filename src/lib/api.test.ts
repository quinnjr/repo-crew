import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { loadDependabot, loadIssues, loadRepos, refreshAtLaunch, scopeFallback } from './api'
import {
  allRepos,
  allReposLoaded,
  dependabotLoaded,
  dependabotPRs,
  issues,
  issuesLoaded,
  selectedRepos,
  truncatedByKind,
  truncatedRepos,
  viewer,
} from './stores'
import {
  DEPENDABOT_CACHE_KEY,
  ISSUES_CACHE_KEY,
  REPOS_CACHE_KEY,
  asCachedDependabot,
  asCachedIssues,
  asCachedRepos,
  readCache,
} from './cache'
import { installFakeStorage, makePr, makeRepo, removeFakeStorage } from './fixtures'
import { fetchDependabotPRs, fetchIssues, fetchRepos } from './graphql'

vi.mock('./graphql', () => ({
  fetchDependabotPRs: vi.fn(),
  fetchIssues: vi.fn(),
  fetchRepos: vi.fn(),
}))

describe('scopeFallback', () => {
  it('takes the 25 most recently pushed by list order', () => {
    const repos = Array.from({ length: 40 }, () => makeRepo())
    const scope = scopeFallback(repos)
    expect(scope).toHaveLength(25)
    expect(scope[0]).toBe(repos[0]?.nameWithOwner)
  })

  it('excludes archived repos before counting, not after', () => {
    const repos = [
      ...Array.from({ length: 10 }, () => makeRepo({ isArchived: true })),
      ...Array.from({ length: 30 }, () => makeRepo()),
    ]
    const scope = scopeFallback(repos)
    expect(scope).toHaveLength(25)
    expect(scope.every((name) => repos.find((r) => r.nameWithOwner === name && !r.isArchived))).toBe(true)
  })

  it('returns what exists when there are fewer than 25', () => {
    expect(scopeFallback([makeRepo(), makeRepo()])).toHaveLength(2)
    expect(scopeFallback([])).toEqual([])
  })
})

/**
 * The cache write path: a successful load persists what landed in the
 * stores, stamped with the scope it was fetched for, so the next launch can
 * hydrate it back. A failed load must leave the cache untouched.
 */
describe('cache writes', () => {
  const me = { id: 'U_1', login: 'octocat', name: null, avatarUrl: null }

  const cleanResult = { truncated: [], skipped: [], failed: [], errors: [] }

  beforeEach(() => {
    installFakeStorage()
    viewer.set(me)
    selectedRepos.set(['acme/a'])
  })

  afterEach(() => {
    removeFakeStorage()
    vi.clearAllMocks()
    viewer.set(null)
    selectedRepos.set([])
    allRepos.set([])
    allReposLoaded.set(false)
    dependabotPRs.set([])
    dependabotLoaded.set(false)
    issues.set([])
    issuesLoaded.set(false)
    truncatedByKind.set({ pullRequests: [], issues: [] })
  })

  it('loadRepos caches the fleet under the viewer login', async () => {
    const repo = makeRepo()
    vi.mocked(fetchRepos).mockResolvedValue([repo])
    await loadRepos(true)
    expect(readCache(REPOS_CACHE_KEY, 'octocat', asCachedRepos)).toEqual([repo])
  })

  it('loadDependabot caches PRs and truncation stamped with the fetch scope', async () => {
    const pr = makePr()
    vi.mocked(fetchDependabotPRs).mockResolvedValue({
      prs: [pr],
      ...cleanResult,
      truncated: [{ kind: 'pullRequests', repo: 'acme/a' }],
    })
    await loadDependabot(true)
    expect(readCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a', asCachedDependabot)).toEqual({
      prs: [pr],
      truncated: ['acme/a'],
    })
  })

  it('loadIssues caches issues stamped with the fetch scope', async () => {
    vi.mocked(fetchIssues).mockResolvedValue({ issues: [], ...cleanResult })
    await loadIssues(true)
    expect(readCache(ISSUES_CACHE_KEY, 'octocat:acme/a', asCachedIssues)).toEqual({
      issues: [],
      truncated: [],
    })
  })

  it('a failed load leaves the cache untouched', async () => {
    vi.mocked(fetchDependabotPRs).mockRejectedValue(new Error('offline'))
    await expect(loadDependabot(true)).rejects.toThrow('offline')
    expect(readCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a', asCachedDependabot)).toBeNull()
  })

  it('concurrent loadRepos calls share one fetch', async () => {
    vi.mocked(fetchRepos).mockResolvedValue([makeRepo()])
    await Promise.all([loadRepos(true), loadRepos(true), loadRepos()])
    expect(fetchRepos).toHaveBeenCalledTimes(1)
  })

  it('a refresh of one kind preserves hydrated truncation warnings of the other', async () => {
    // Launch hydrated a dependabot truncation warning; only the issues
    // refresh lands. The PR warning must survive — the stale truncated PR
    // board is still what is on screen.
    truncatedByKind.set({ pullRequests: ['acme/a'], issues: [] })
    vi.mocked(fetchIssues).mockResolvedValue({ issues: [], ...cleanResult })
    await loadIssues(true)
    expect(get(truncatedRepos)).toEqual(['acme/a'])
  })

  it('refreshAtLaunch computes the fallback sweep scope from the fresh fleet, not the hydrated one', async () => {
    // No explicit selection, and last session's fleet hydrated from cache.
    selectedRepos.set([])
    const staleRepo = makeRepo()
    const freshRepo = makeRepo()
    allRepos.set([staleRepo])
    allReposLoaded.set(true)
    dependabotLoaded.set(true)
    issuesLoaded.set(true)
    vi.mocked(fetchRepos).mockResolvedValue([freshRepo])
    vi.mocked(fetchDependabotPRs).mockResolvedValue({ prs: [], ...cleanResult })
    vi.mocked(fetchIssues).mockResolvedValue({ issues: [], ...cleanResult })
    await refreshAtLaunch()
    expect(fetchDependabotPRs).toHaveBeenCalledWith([freshRepo.nameWithOwner])
    expect(fetchIssues).toHaveBeenCalledWith([freshRepo.nameWithOwner])
  })

  it('refreshAtLaunch refetches over hydrated data without dropping loaded', async () => {
    // Simulate a cache-hydrated launch: data on screen, loaded=true.
    dependabotPRs.set([makePr()])
    dependabotLoaded.set(true)
    issuesLoaded.set(true)
    allReposLoaded.set(true)
    const fresh = makePr()
    vi.mocked(fetchRepos).mockResolvedValue([makeRepo()])
    vi.mocked(fetchDependabotPRs).mockResolvedValue({ prs: [fresh], ...cleanResult })
    vi.mocked(fetchIssues).mockResolvedValue({ issues: [], ...cleanResult })
    await refreshAtLaunch()
    // The non-force short-circuit would have skipped all three fetches.
    expect(fetchDependabotPRs).toHaveBeenCalledTimes(1)
    expect(fetchIssues).toHaveBeenCalledTimes(1)
    expect(fetchRepos).toHaveBeenCalledTimes(1)
    expect(get(dependabotPRs)).toEqual([fresh])
    expect(get(dependabotLoaded)).toBe(true)
  })

  it('refreshAtLaunch reports a failure without wiping the stale board', async () => {
    const stale = makePr()
    dependabotPRs.set([stale])
    dependabotLoaded.set(true)
    issuesLoaded.set(true)
    allReposLoaded.set(true)
    vi.mocked(fetchRepos).mockResolvedValue([])
    vi.mocked(fetchDependabotPRs).mockRejectedValue(new Error('offline'))
    vi.mocked(fetchIssues).mockResolvedValue({ issues: [], ...cleanResult })
    await expect(refreshAtLaunch()).resolves.toBeUndefined()
    expect(get(dependabotPRs)).toEqual([stale])
    expect(get(dependabotLoaded)).toBe(true)
  })
})
