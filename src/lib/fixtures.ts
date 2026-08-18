import type { PullRequest, Repo } from './types'

/**
 * Test-only fixtures. Imported by the `*.test.ts` files and nothing else, so
 * the app bundle never picks this module up.
 */

/**
 * Vitest runs in a node environment with no localStorage; tests that touch
 * the cache install this Map-backed stub and remove it again in afterEach —
 * removal doubles as the "storage missing entirely" fixture.
 */
export const installFakeStorage = (): Map<string, string> => {
  const backing = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  return backing
}

export const removeFakeStorage = (): void => {
  delete (globalThis as Record<string, unknown>).localStorage
}

let prCount = 0

/** A fully-populated Dependabot pull request; override what the test cares about. */
export const makePr = (over: Partial<PullRequest> = {}): PullRequest => {
  const n = ++prCount
  return {
    id: `PR_${n}`,
    number: n,
    title: 'Bump lodash from 4.17.20 to 4.17.21',
    url: 'https://example.invalid',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    isDraft: false,
    headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21',
    headRefOid: 'deadbeef',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    author: { login: 'dependabot[bot]' },
    reviewDecision: null,
    repo: 'acme/api',
    repoShort: 'api',
    checks: [],
    ...over,
  }
}

let repoCount = 0

export const makeRepo = (over: Partial<Repo> = {}): Repo => {
  const n = ++repoCount
  return {
    id: `R_${n}`,
    name: `repo-${n}`,
    nameWithOwner: `acme/repo-${n}`,
    description: null,
    isArchived: false,
    isPrivate: false,
    primaryLanguage: null,
    stargazerCount: 0,
    updatedAt: '2026-08-01T00:00:00Z',
    pushedAt: '2026-08-01T00:00:00Z',
    defaultBranchRef: { name: 'main' },
    autoMergeAllowed: true,
    ...over,
  }
}
