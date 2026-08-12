import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
  asPrefs,
  asRepoList,
  dependabotLoaded,
  issuesLoaded,
  selectedRepos,
  toggleRepo,
} from './stores'

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
