import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
  allRepos,
  allReposLoaded,
  asPrefs,
  asRepoList,
  dependabotLoaded,
  dependabotPRs,
  hydrateFromCache,
  issues,
  issuesLoaded,
  resetFetchedData,
  selectedRepos,
  toggleRepo,
  truncatedByKind,
  truncatedRepos,
  viewer,
} from './stores'
import {
  DEPENDABOT_CACHE_KEY,
  REPOS_CACHE_KEY,
  VIEWER_CACHE_KEY,
  asCachedViewer,
  readCache,
  writeCache,
} from './cache'
import { installFakeStorage, makePr, makeRepo, removeFakeStorage } from './fixtures'

/**
 * The validators exist because these values come back from localStorage,
 * where any past version of the app — or the user's editor — may have left
 * any shape at all. A bad value must yield defaults, never a throw: the
 * stores initialise at module scope, so a throw is a blank app.
 */
describe('asRepoList', () => {
  it('accepts a clean list', () => {
    expect(asRepoList(['acme/a', 'acme/b'])).toEqual(['acme/a', 'acme/b'])
  })

  it.each([null, undefined, 'acme/a', 42, { 0: 'acme/a' }])('coerces %o to an empty list', (v) => {
    expect(asRepoList(v)).toEqual([])
  })

  it('drops non-string and empty members instead of keeping them', () => {
    expect(asRepoList(['acme/a', 7, '', null, 'acme/b'])).toEqual(['acme/a', 'acme/b'])
  })
})

describe('asPrefs', () => {
  it('keeps a valid stored value', () => {
    expect(asPrefs({ defaultMerge: 'REBASE', deleteBranch: false, autoMerge: false })).toEqual({
      defaultMerge: 'REBASE',
      deleteBranch: false,
      autoMerge: false,
    })
  })

  // A defaultMerge outside the enum would be sent to GitHub as mergeMethod
  // and fail every pull request in a bulk merge with an opaque error.
  it('replaces an out-of-vocabulary defaultMerge with the default', () => {
    expect(asPrefs({ defaultMerge: 'FAST_FORWARD' }).defaultMerge).toBe('SQUASH')
    expect(asPrefs({ defaultMerge: 42 }).defaultMerge).toBe('SQUASH')
  })

  it.each([null, undefined, 'squash', []])('yields full defaults for %o', (v) => {
    expect(asPrefs(v)).toEqual({ defaultMerge: 'SQUASH', deleteBranch: true, autoMerge: true })
  })

  it('type-checks the booleans individually', () => {
    expect(asPrefs({ deleteBranch: 'yes' }).deleteBranch).toBe(true)
    expect(asPrefs({ autoMerge: false }).autoMerge).toBe(false)
  })
})

describe('hydrateFromCache', () => {
  afterEach(() => {
    removeFakeStorage()
    selectedRepos.set([])
    dependabotPRs.set([])
    dependabotLoaded.set(false)
    issues.set([])
    issuesLoaded.set(false)
    allRepos.set([])
    allReposLoaded.set(false)
    truncatedByKind.set({ pullRequests: [], issues: [] })
    viewer.set(null)
  })

  const me = { id: 'U_1', login: 'octocat', name: null, avatarUrl: null }

  it('hydrates fetched data and marks it loaded when the cached scope matches', () => {
    installFakeStorage()
    selectedRepos.set(['acme/a'])
    const pr = makePr()
    writeCache(VIEWER_CACHE_KEY, '', me)
    writeCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a', { prs: [pr], truncated: ['acme/a'] })
    hydrateFromCache()
    expect(get(dependabotPRs)).toEqual([pr])
    expect(get(dependabotLoaded)).toBe(true)
    expect(get(truncatedRepos)).toEqual(['acme/a'])
  })

  it('ignores a cache entry stored for a different scope', () => {
    installFakeStorage()
    selectedRepos.set(['acme/a'])
    writeCache(VIEWER_CACHE_KEY, '', me)
    writeCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a,acme/b', { prs: [makePr()], truncated: [] })
    hydrateFromCache()
    expect(get(dependabotPRs)).toEqual([])
    expect(get(dependabotLoaded)).toBe(false)
  })

  it('ignores PR/issue data cached for a different account', () => {
    installFakeStorage()
    selectedRepos.set(['acme/a'])
    writeCache(VIEWER_CACHE_KEY, '', me)
    writeCache(DEPENDABOT_CACHE_KEY, 'someone-else:acme/a', { prs: [makePr()], truncated: [] })
    hydrateFromCache()
    expect(get(dependabotPRs)).toEqual([])
    expect(get(dependabotLoaded)).toBe(false)
  })

  it('hydrates no PR/issue data when no viewer is cached to key it by', () => {
    installFakeStorage()
    selectedRepos.set(['acme/a'])
    writeCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a', { prs: [makePr()], truncated: [] })
    hydrateFromCache()
    expect(get(dependabotPRs)).toEqual([])
    expect(get(dependabotLoaded)).toBe(false)
  })

  it('hydrates the viewer, and repos stored for that viewer', () => {
    installFakeStorage()
    const me = { id: 'U_1', login: 'octocat', name: null, avatarUrl: null }
    const repo = makeRepo()
    writeCache(VIEWER_CACHE_KEY, '', me)
    writeCache(REPOS_CACHE_KEY, 'octocat', [repo])
    hydrateFromCache()
    expect(get(viewer)).toEqual(me)
    expect(get(allRepos)).toEqual([repo])
    expect(get(allReposLoaded)).toBe(true)
  })

  it('ignores repos cached for a different account', () => {
    installFakeStorage()
    writeCache(VIEWER_CACHE_KEY, '', { id: 'U_1', login: 'octocat', name: null, avatarUrl: null })
    writeCache(REPOS_CACHE_KEY, 'someone-else', [makeRepo()])
    hydrateFromCache()
    expect(get(allRepos)).toEqual([])
    expect(get(allReposLoaded)).toBe(false)
  })

  it('writes the viewer back to the cache when it is set', () => {
    installFakeStorage()
    const me = { id: 'U_1', login: 'octocat', name: null, avatarUrl: null }
    viewer.set(me)
    expect(readCache(VIEWER_CACHE_KEY, '', asCachedViewer)).toEqual(me)
  })

  it('leaves everything untouched when nothing is cached', () => {
    installFakeStorage()
    hydrateFromCache()
    expect(get(viewer)).toBeNull()
    expect(get(dependabotLoaded)).toBe(false)
    expect(get(issuesLoaded)).toBe(false)
  })
})

/**
 * Disconnect must erase what the cache persisted: identity, fleet, PR and
 * issue data — on disk and in the stores — or "Disconnect" leaves the
 * account's data readable on a shared machine and re-sign-in as another
 * account shows the previous account's board.
 */
describe('resetFetchedData', () => {
  afterEach(() => {
    removeFakeStorage()
    selectedRepos.set([])
  })

  it('clears the fetched stores, loaded flags, truncation, and the disk cache', () => {
    installFakeStorage()
    selectedRepos.set(['acme/a'])
    const me = { id: 'U_1', login: 'octocat', name: null, avatarUrl: null }
    viewer.set(me) // writes the viewer cache entry
    allRepos.set([makeRepo()])
    allReposLoaded.set(true)
    dependabotPRs.set([makePr()])
    dependabotLoaded.set(true)
    issues.set([])
    issuesLoaded.set(true)
    truncatedByKind.set({ pullRequests: ['acme/a'], issues: [] })
    writeCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a', { prs: [makePr()], truncated: [] })

    resetFetchedData()

    expect(get(allRepos)).toEqual([])
    expect(get(allReposLoaded)).toBe(false)
    expect(get(dependabotPRs)).toEqual([])
    expect(get(dependabotLoaded)).toBe(false)
    expect(get(issuesLoaded)).toBe(false)
    expect(get(truncatedRepos)).toEqual([])
    expect(readCache(VIEWER_CACHE_KEY, '', asCachedViewer)).toBeNull()
    expect(readCache(DEPENDABOT_CACHE_KEY, 'octocat:acme/a', (v) => v as object)).toBeNull()
  })
})

describe('scope invalidation', () => {
  it('marks fetched data stale when the selection changes', () => {
    dependabotLoaded.set(true)
    issuesLoaded.set(true)
    toggleRepo('acme/new-repo')
    expect(get(dependabotLoaded)).toBe(false)
    expect(get(issuesLoaded)).toBe(false)
    toggleRepo('acme/new-repo') // restore
  })

  it('does not invalidate when the selection is re-set unchanged', () => {
    dependabotLoaded.set(true)
    selectedRepos.set([...get(selectedRepos)])
    expect(get(dependabotLoaded)).toBe(true)
  })
})
