import { describe, expect, it } from 'vitest'
import { scopeFallback } from './api'
import { makeRepo } from './fixtures'

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
