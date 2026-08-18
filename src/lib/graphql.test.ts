import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { AuthError, GraphQLError, deleteHeadRef, enableAutoMerge, fetchDependabotPRs, gql } from './graphql'
import { authenticated } from './stores'
import { makePr } from './fixtures'

beforeEach(() => {
  invokeMock.mockReset()
  authenticated.set(true)
})

describe('gql', () => {
  it('unwraps the data out of a clean envelope', async () => {
    invokeMock.mockResolvedValue({ ok: true, status: 200, data: { data: { x: 1 } } })
    expect(await gql('query { x }')).toEqual({ data: { x: 1 }, errors: [] })
  })

  it('throws a GraphQLError that carries the partial data', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { good: 1 }, errors: [{ message: 'bad alias' }] },
    })
    const err = await gql('q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).partial).toEqual({ good: 1 })
  })

  it('preserves both the partial data and the errors under noThrow', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { good: 1 }, errors: [{ message: 'bad alias' }] },
    })
    expect(await gql('q', {}, { noThrow: true })).toEqual({
      data: { good: 1 },
      errors: [{ message: 'bad alias' }],
    })
  })

  it('surfaces the detail body alongside a transport error', async () => {
    invokeMock.mockResolvedValue({ ok: false, status: 502, error: 'HTTP 502', detail: 'bad gateway' })
    const { data, errors } = await gql('q', {}, { noThrow: true })
    expect(data).toBeNull()
    expect(errors[0]?.message).toBe('HTTP 502: bad gateway')
  })

  // The Rust command's Err channel rejects the invoke promise, which used to
  // sail straight past noThrow and take down a whole sweep.
  it('folds an invoke rejection back into the noThrow shape', async () => {
    invokeMock.mockRejectedValue('request task failed: boom')
    expect(await gql('q', {}, { noThrow: true })).toEqual({
      data: null,
      errors: [{ message: 'request task failed: boom' }],
    })
    invokeMock.mockRejectedValue('request task failed: boom')
    await expect(gql('q')).rejects.toThrow('request task failed: boom')
  })

  // Root cause of "mid-session 401 shows a network error": AuthError must
  // escape even noThrow callers AND flip the auth store, or the app keeps
  // sweeping with a dead token instead of returning to sign-in.
  it('throws AuthError and signs the session out, even under noThrow', async () => {
    invokeMock.mockResolvedValue({ ok: false, status: 401, error: 'not_authenticated' })
    await expect(gql('q', {}, { noThrow: true })).rejects.toBeInstanceOf(AuthError)
    expect(get(authenticated)).toBe(false)
  })
})

describe('fetchDependabotPRs — partial recovery', () => {
  it('keeps the repos that answered when one alias fails', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: {
          r0: null,
          r1: {
            nameWithOwner: 'acme/b',
            pullRequests: { nodes: [makePr()], pageInfo: { hasNextPage: false } },
          },
        },
        errors: [{ message: "Could not resolve to a Repository with the name 'acme/a'." }],
      },
    })

    const res = await fetchDependabotPRs(['acme/a', 'acme/b'])
    expect(res.prs).toHaveLength(1)
    expect(res.prs[0]?.repo).toBe('acme/b')
    expect(res.failed).toEqual(['acme/a'])
    expect(res.errors[0]).toMatch(/Could not resolve/)
  })

  it('reports a repo that hit the page cap as truncated', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: {
          r0: {
            nameWithOwner: 'acme/busy',
            pullRequests: { nodes: [makePr()], pageInfo: { hasNextPage: true } },
          },
        },
      },
    })
    const res = await fetchDependabotPRs(['acme/busy'])
    expect(res.truncated).toEqual([{ repo: 'acme/busy', kind: 'pullRequests' }])
  })
})

describe('enableAutoMerge', () => {
  // GitHub's EnablePullRequestAutoMergeInput has no deleteBranch field —
  // sending one fails the whole mutation, so auto-merge never gets enabled.
  it('sends only fields the input type defines', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_1' } } } },
    })
    await enableAutoMerge('PR_1', { method: 'SQUASH', expectedHeadOid: 'abc' })
    const args = invokeMock.mock.calls[0]?.[1] as { variables: { input: Record<string, unknown> } }
    expect(args.variables.input).toEqual({
      pullRequestId: 'PR_1',
      mergeMethod: 'SQUASH',
      expectedHeadOid: 'abc',
    })
  })
})

describe('deleteHeadRef', () => {
  it('looks up the head ref id and deletes it', async () => {
    invokeMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: { node: { headRef: { id: 'REF_1' } } } },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: { deleteRef: { clientMutationId: null } } },
      })
    expect(await deleteHeadRef('PR_1')).toBe(true)
    const second = invokeMock.mock.calls[1]?.[1] as { variables: { input: Record<string, unknown> } }
    expect(second.variables.input).toEqual({ refId: 'REF_1' })
  })

  it('reports the ref already gone without attempting a delete', async () => {
    // The repo's own auto-delete setting often wins the race; that is
    // success from the user's point of view, not an error.
    invokeMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { node: { headRef: null } } },
    })
    expect(await deleteHeadRef('PR_1')).toBe(false)
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
