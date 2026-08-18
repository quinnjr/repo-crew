import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ago, bumpOf, checksInfo, flattenChecks, mergeInfo, millis, overallSignal, semverStep, shortRepo, DEPENDABOT_REBASE_COMMENT, canPokeRebase, isCleanStatusError } from './util'
import { makePr as pr } from './fixtures'
import type { Check, MergeStateStatus } from './types'

describe('bumpOf', () => {
  it('parses the plain Dependabot title', () => {
    const b = bumpOf({ title: 'Bump lodash from 4.17.20 to 4.17.21' })
    expect(b).toMatchObject({ key: 'lodash@4.17.21', pkg: 'lodash', from: '4.17.20', to: '4.17.21', step: 'patch' })
  })

  it('parses a conventional-commit prefixed title', () => {
    expect(bumpOf({ title: 'chore(deps): bump vite from 8.1.0 to 8.2.0' })?.key).toBe('vite@8.2.0')
  })

  it('handles scoped and path-like package names', () => {
    expect(bumpOf({ title: 'Bump @babel/core from 7.0.0 to 7.1.0' })?.pkg).toBe('@babel/core')
    expect(bumpOf({ title: 'Bump github.com/foo/bar from 1.0.0 to 1.0.1' })?.pkg).toBe('github.com/foo/bar')
  })

  // The regression that collapsed every grouped PR in the fleet onto one row.
  // `toEqual`, not field picks: every property of the identity matters here.
  it('keys a grouped update by its group, never by the word "the"', () => {
    expect(bumpOf({ title: 'Bump the npm_and_yarn group with 3 updates' })).toEqual({
      key: 'group:npm_and_yarn',
      pkg: 'npm_and_yarn group',
      from: null,
      to: null,
      step: null,
      grouped: true,
    })
  })

  it('keeps distinct groups in distinct buckets', () => {
    const a = bumpOf({ title: 'Bump the npm_and_yarn group with 3 updates' })
    const b = bumpOf({ title: 'Bump the actions group across 1 directory with 2 updates' })
    expect(a?.key).not.toBe(b?.key)
  })

  it('does not key a multi-package bump as a single package', () => {
    const b = bumpOf({ title: 'Bump lodash and axios from 1.0.0 to 2.0.0' })
    expect(b?.grouped).toBe(true)
    expect(b?.key).not.toBe('lodash')
  })

  it('normalises a leading v so ecosystems agree', () => {
    expect(bumpOf({ title: 'Bump actions/checkout from v4.1.0 to v4.2.0' })?.key).toBe('actions/checkout@4.2.0')
  })

  it('returns null rather than a stop word', () => {
    expect(bumpOf({ title: 'Bump the' })).toBeNull()
    expect(bumpOf({ title: 'Refactor the parser' })).toBeNull()
  })

  // NAKED_RE is end-anchored for exactly this: unanchored, this title keyed
  // as the package `minimum` and collapsed with any other such chore.
  it('does not read prose starting with Bump as a package', () => {
    expect(bumpOf({ title: 'Bump minimum Node version to 22' })).toBeNull()
    expect(bumpOf({ title: 'Bump timeout for the slow suite' })).toBeNull()
  })
})

describe('semverStep', () => {
  it.each([
    ['1.0.0', '2.0.0', 'major'],
    ['1.1.0', '1.2.0', 'minor'],
    ['1.1.1', '1.1.2', 'patch'],
    ['4', '5', 'major'],
    ['1.2', '1.3', 'minor'],
  ])('%s -> %s is %s', (from, to, expected) => {
    expect(semverStep(from, to)).toBe(expected)
  })

  it('is null when a version does not parse', () => {
    expect(semverStep('latest', 'nightly')).toBeNull()
  })
})

describe('mergeInfo', () => {
  it.each([
    ['CLEAN', 'READY'],
    ['HAS_HOOKS', 'READY'],
    ['UNSTABLE', 'UNSTABLE'],
    ['BEHIND', 'BEHIND'],
    ['DIRTY', 'DIRTY'],
    ['BLOCKED', 'BLOCKED'],
    ['BLOCKED_BY_LIFECYCLE_RULE', 'RULES'],
    ['CLOSED', 'CLOSED'],
  ] as [MergeStateStatus, string][])('%s maps to %s', (status, expected) => {
    expect(mergeInfo(pr({ mergeStateStatus: status })).state).toBe(expected)
  })

  it('reports a draft as draft whichever way GitHub says so', () => {
    expect(mergeInfo(pr({ isDraft: true })).state).toBe('DRAFT')
    expect(mergeInfo(pr({ mergeStateStatus: 'DRAFT' })).state).toBe('DRAFT')
  })

  // UNSTABLE used to fall through to READY and get swept into bulk merges.
  it('never reports UNSTABLE as ready', () => {
    expect(mergeInfo(pr({ mergeStateStatus: 'UNSTABLE' })).signal).toBe('hold')
  })

  it('fails closed on an unknown status', () => {
    const unknown = 'SOMETHING_GITHUB_ADDED_LATER' as MergeStateStatus
    expect(mergeInfo(pr({ mergeStateStatus: unknown })).state).toBe('UNKNOWN')
  })
})

describe('checksInfo', () => {
  const checks = (...states: string[]): Check[] => states.map((state, i) => ({ state, name: `job${i}` }))

  it('reports no checks distinctly from passing', () => {
    expect(checksInfo(pr({ checks: [] })).state).toBe('NONE')
  })

  it('counts NEUTRAL and SKIPPED as passing', () => {
    const info = checksInfo(pr({ checks: checks('SUCCESS', 'NEUTRAL', 'SKIPPED') }))
    expect(info.state).toBe('SUCCESS')
    expect(info.passed).toBe(3)
  })

  it.each(['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR'])(
    'treats %s as a failure',
    (state) => {
      const info = checksInfo(pr({ checks: checks('SUCCESS', state) }))
      expect(info.state).toBe('FAILURE')
      expect(info.failed).toBe(1)
    },
  )

  it.each(['WAITING', 'REQUESTED', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'])('treats %s as pending', (state) => {
    expect(checksInfo(pr({ checks: checks('SUCCESS', state) })).state).toBe('PENDING')
  })

  it('never loses a check from the counters', () => {
    const info = checksInfo(pr({ checks: checks('SUCCESS', 'WEIRD_NEW_STATE', 'FAILURE') }))
    expect(info.passed + info.failed + info.pending).toBe(info.total)
  })
})

describe('overallSignal', () => {
  it('takes the worse of merge state and checks', () => {
    const failing = pr({ mergeStateStatus: 'CLEAN', checks: [{ state: 'FAILURE', name: 'test' }] })
    expect(overallSignal(failing)).toBe('stop')
    const clean = pr({ mergeStateStatus: 'CLEAN', checks: [{ state: 'SUCCESS', name: 'test' }] })
    expect(overallSignal(clean)).toBe('go')
  })

  // The reverse direction: a bad merge state must win over green checks too.
  it('lets a bad merge state override passing checks', () => {
    const dirty = pr({ mergeStateStatus: 'DIRTY', checks: [{ state: 'SUCCESS', name: 'test' }] })
    expect(overallSignal(dirty)).toBe('stop')
    const behind = pr({ mergeStateStatus: 'BEHIND', checks: [{ state: 'SUCCESS', name: 'test' }] })
    expect(overallSignal(behind)).toBe('hold')
  })
})

describe('flattenChecks', () => {
  it('reads a CheckRun conclusion, falling back to status, then PENDING', () => {
    const checks = flattenChecks(pr({
      statusCheckRollup: {
        state: null,
        contexts: {
          nodes: [
            { __typename: 'CheckRun', name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED' },
            { __typename: 'CheckRun', name: 'test', conclusion: null, status: 'IN_PROGRESS' },
            { __typename: 'CheckRun', name: 'lint', conclusion: null, status: null },
          ],
        },
      },
    }))
    expect(checks).toEqual([
      { state: 'SUCCESS', name: 'build' },
      { state: 'IN_PROGRESS', name: 'test' },
      { state: 'PENDING', name: 'lint' },
    ])
  })

  it('reads a StatusContext state, naming unnamed contexts "status"', () => {
    const checks = flattenChecks(pr({
      statusCheckRollup: {
        state: null,
        contexts: {
          nodes: [
            { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' },
            { __typename: 'StatusContext', context: '', state: null },
          ],
        },
      },
    }))
    expect(checks).toEqual([
      { state: 'FAILURE', name: 'ci/legacy' },
      { state: 'PENDING', name: 'status' },
    ])
  })

  it('drops null nodes and tolerates a missing rollup', () => {
    expect(flattenChecks(pr({ statusCheckRollup: { state: null, contexts: { nodes: [null] } } }))).toEqual([])
    expect(flattenChecks(pr({ statusCheckRollup: null }))).toEqual([])
  })
})

describe('ago', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['2026-08-11T11:59:30Z', '30s'],
    ['2026-08-11T11:30:00Z', '30m'],
    ['2026-08-11T09:00:00Z', '3h'],
    ['2026-08-04T12:00:00Z', '7d'],
    ['2026-07-01T12:00:00Z', '1mo'],
    ['2025-08-01T12:00:00Z', '1y'],
  ])('%s reads as %s', (iso, expected) => {
    expect(ago(iso)).toBe(expected)
  })

  it('is empty for a missing date and floors a future date at one second', () => {
    expect(ago(null)).toBe('')
    expect(ago('2026-08-11T12:05:00Z')).toBe('1s')
  })
})

describe('millis / shortRepo', () => {
  it('collapses an unparseable date to the epoch rather than NaN', () => {
    expect(millis('not a date')).toBe(0)
    expect(millis(null)).toBe(0)
  })

  it('takes the name half of nameWithOwner', () => {
    expect(shortRepo('acme/api-gateway')).toBe('api-gateway')
    expect(shortRepo('')).toBe('')
  })
})

describe('canPokeRebase', () => {
  it('offers a poke only where a rebase can help', () => {
    expect(canPokeRebase(pr({ mergeStateStatus: 'BEHIND' }))).toBe(true)
    expect(canPokeRebase(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))).toBe(true)
    expect(canPokeRebase(pr({ mergeStateStatus: 'CLEAN' }))).toBe(false)
    expect(canPokeRebase(pr({ mergeStateStatus: 'BLOCKED' }))).toBe(false)
    expect(canPokeRebase(pr({ isDraft: true, mergeStateStatus: 'BEHIND' }))).toBe(false)
  })
})

describe('DEPENDABOT_REBASE_COMMENT', () => {
  it('is the literal command Dependabot listens for', () => {
    expect(DEPENDABOT_REBASE_COMMENT).toBe('@dependabot rebase')
  })
})

describe('isCleanStatusError', () => {
  it('matches GitHub’s clean-status rejection, doubled prefix and all', () => {
    expect(isCleanStatusError('Pull request Pull request is in clean status')).toBe(true)
    expect(isCleanStatusError('["Pull request is in clean status"]')).toBe(true)
    expect(isCleanStatusError('Pull request is not mergeable')).toBe(false)
    expect(isCleanStatusError('auto-merge is not allowed')).toBe(false)
  })
})
