import { describe, expect, it } from 'vitest'
import { groupRows, spreadOf, spreadWidthOf } from './ledger'
import { batchQueries } from './graphql'
import { makePr } from './fixtures'
import type { MergeStateStatus, PullRequest } from './types'

const pr = (repo: string, title: string, over: Partial<PullRequest> = {}): PullRequest =>
  makePr({ repo, repoShort: repo.split('/')[1] ?? repo, title, ...over })

const lodash = (repo: string, over: Partial<PullRequest> = {}) =>
  pr(repo, 'Bump lodash from 4.17.20 to 4.17.21', over)

describe('groupRows — the pivot', () => {
  it('collapses one bump across nine repos into a single row', () => {
    const prs = Array.from({ length: 9 }, (_, i) => lodash(`acme/repo-${i}`))
    const rows = groupRows(prs, 'change')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.members).toHaveLength(9)
    expect(rows[0]!.label).toBe('lodash')
    expect(rows[0]!.detail).toBe('4.17.20 → 4.17.21')
  })

  it('keeps those nine as nine rows under the repo pivot', () => {
    const prs = Array.from({ length: 9 }, (_, i) => lodash(`acme/repo-${i}`))
    expect(groupRows(prs, 'repo')).toHaveLength(9)
  })

  it('does not merge unrelated grouped PRs into one bucket', () => {
    const rows = groupRows(
      [
        pr('acme/a', 'Bump the npm_and_yarn group with 3 updates'),
        pr('acme/b', 'Bump the actions group with 2 updates'),
      ],
      'change',
    )
    expect(rows).toHaveLength(2)
  })

  it('groups unparseable titles by exact text, not into one bucket', () => {
    const rows = groupRows([pr('acme/a', 'Fix the thing'), pr('acme/b', 'Other work')], 'change')
    expect(rows).toHaveLength(2)
  })

  it('excludes non-ready members from ready', () => {
    const rows = groupRows(
      [
        lodash('acme/a'),
        lodash('acme/b', { mergeStateStatus: 'DIRTY' as MergeStateStatus }),
        lodash('acme/c', { mergeStateStatus: 'UNSTABLE' as MergeStateStatus }),
      ],
      'change',
    )
    expect(rows[0]!.members).toHaveLength(3)
    expect(rows[0]!.ready).toHaveLength(1)
  })

  it('picks the true minimum for oldest, not the first member', () => {
    const rows = groupRows(
      [
        lodash('acme/a', { updatedAt: '2026-08-05T00:00:00Z' }),
        lodash('acme/b', { updatedAt: '2026-07-01T00:00:00Z' }),
        lodash('acme/c', { updatedAt: '2026-08-06T00:00:00Z' }),
      ],
      'change',
    )
    expect(rows[0]!.oldest).toBe('2026-07-01T00:00:00Z')
  })

  it('sorts widest fan-out first', () => {
    const rows = groupRows(
      [
        pr('acme/a', 'Bump zod from 1.0.0 to 1.0.1'),
        lodash('acme/a'),
        lodash('acme/b'),
        lodash('acme/c'),
      ],
      'change',
    )
    expect(rows[0]!.label).toBe('lodash')
  })
})

describe('spreadWidthOf', () => {
  // ponytail in Bumps.svelte mirrors this: past 12 cells the strip stops
  // being readable, so wider fan-outs cap and the overflow shows elsewhere.
  it('caps the reserved width at 12 cells', () => {
    const prs = Array.from({ length: 15 }, (_, i) => lodash(`acme/r${i}`))
    expect(spreadWidthOf(groupRows(prs, 'change'))).toBe(12)
  })

  it('respects a caller-supplied cap', () => {
    const prs = Array.from({ length: 15 }, (_, i) => lodash(`acme/r${i}`))
    expect(spreadWidthOf(groupRows(prs, 'change'), 6)).toBe(6)
  })
})

describe('spreadOf', () => {
  it('pads every row to the same width so columns line up', () => {
    const rows = groupRows([lodash('acme/a'), lodash('acme/b'), pr('acme/c', 'Bump zod from 1 to 2')], 'change')
    const width = spreadWidthOf(rows)
    expect(width).toBe(2)
    for (const row of rows) expect(spreadOf(row, width)).toHaveLength(2)
  })

  it('orders trouble to the left', () => {
    const passing = [{ state: 'SUCCESS', name: 'test' }]
    const rows = groupRows(
      [
        lodash('acme/a', { checks: passing }),
        lodash('acme/b', { checks: passing, mergeStateStatus: 'DIRTY' as MergeStateStatus }),
      ],
      'change',
    )
    const cells = spreadOf(rows[0]!, 2)
    expect(cells[0]!.cls).toContain('lamp-stop')
    expect(cells[1]!.cls).toContain('lamp-go')
  })

  // A PR with no checks is not the same as a PR that passed its checks.
  it('reports a PR with no checks as idle, not green', () => {
    const rows = groupRows([lodash('acme/a')], 'change')
    expect(spreadOf(rows[0]!, 1)[0]!.cls).toBe('lamp')
  })
})

describe('batchQueries', () => {
  it('aliases each repo so callers can correlate results', () => {
    const { query, variables, aliases } = batchQueries(['acme/a', 'acme/b'], '{ id }')
    expect(aliases).toEqual(['acme/a', 'acme/b'])
    expect(query).toContain('r0: repository(owner: $r0_o, name: $r0_n)')
    expect(query).toContain('r1: repository(owner: $r1_o, name: $r1_n)')
    expect(variables).toMatchObject({ r0_o: 'acme', r0_n: 'a', r1_o: 'acme', r1_n: 'b' })
  })

  // A malformed entry used to send `undefined` against String!, which made
  // GitHub reject the whole batch and silently lose the other nine repos.
  it('skips malformed entries instead of poisoning the batch', () => {
    const { variables, aliases, skipped } = batchQueries(['acme/a', 'bare', 'a/b/c', ''], '{ id }')
    expect(aliases).toEqual(['acme/a'])
    expect(skipped).toEqual(['bare', 'a/b/c', ''])
    expect(Object.values(variables).every((v) => typeof v === 'string' && v.length)).toBe(true)
  })

  it('renumbers aliases contiguously after a skip', () => {
    const { query, aliases } = batchQueries(['bare', 'acme/b'], '{ id }')
    expect(aliases).toEqual(['acme/b'])
    expect(query).toContain('r0: repository')
    expect(query).not.toContain('r1: repository')
  })

  it('produces no query when nothing is valid', () => {
    expect(batchQueries(['bare'], '{ id }').query).toBe('')
  })

  // Every variable the parts reference must be declared in the header as
  // String! — an undeclared or optional variable arriving unset is how GitHub
  // rejects an entire batch.
  it('declares every variable in the query header', () => {
    const { query, variables } = batchQueries(['acme/a', 'acme/b', 'acme/c'], '{ id }')
    for (const key of Object.keys(variables)) {
      expect(query).toContain(`$${key}: String!`)
    }
    expect(Object.keys(variables)).toHaveLength(6)
  })
})
