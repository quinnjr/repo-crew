import { invoke } from '@tauri-apps/api/core'
import { flattenChecks } from './util'
import { authenticated, keychainError } from './stores'
import type { Issue, Label, LinkedPullRequest, MergeMethod, PullRequest, Repo, Viewer } from './types'

export class AuthError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'AuthError'
  }
}

export class GraphQLError extends Error {
  graphqlErrors: { message: string }[]
  /** Partial data GitHub returned alongside the errors, when there was any. */
  partial: unknown
  constructor(errors: { message: string }[], partial: unknown = null) {
    super(errors.map((e) => e.message).join('; ') || 'GraphQL error')
    this.name = 'GraphQLError'
    this.graphqlErrors = errors
    this.partial = partial
  }
}

type Vars = Record<string, unknown>

/** What the Rust `github_graphql` command hands back. */
type Envelope = {
  ok: boolean
  status: number
  error?: string
  detail?: string
  data?: { data?: unknown; errors?: { message: string }[] }
}

export type Result<T> = { data: T | null; errors: { message: string }[] }

/**
 * Run a query and unwrap it.
 *
 * GitHub reports GraphQL-level failures inside a 200 body, so those are raised
 * here rather than silently yielding null data. It also routinely returns
 * PARTIAL data alongside errors — one inaccessible repo in a batch nulls that
 * alias and leaves the other nine intact — so `noThrow` preserves both, and
 * the thrown error carries the partial payload for callers that can salvage it.
 */
export const gql = async <T = Record<string, unknown>>(
  query: string,
  variables: Vars = {},
  { noThrow = false }: { noThrow?: boolean } = {},
): Promise<Result<T>> => {
  let res: Envelope
  try {
    res = await invoke<Envelope>('github_graphql', { query, variables })
  } catch (e) {
    // The Rust command returned `Err` (e.g. the request task itself died).
    // That channel rejects the promise and would bypass `noThrow`, so fold it
    // back into the same error shape as an envelope failure.
    const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)
    if (noThrow) return { data: null, errors: [{ message }] }
    throw new Error(message)
  }
  if (!res.ok) {
    if (res.error === 'keychain_unavailable') {
      // The other half of the condition `bootstrapSession` records at boot. A
      // keyring that re-locks mid-session reported here as a raw
      // `keychain_unavailable: …` toast while `authenticated` stayed true, so
      // Welcome's keyring panel — and its Retry — were unreachable.
      keychainError.set((res.detail ?? '').trim() || 'the system keychain is unavailable')
      authenticated.set(false)
      throw new AuthError()
    }
    if (res.error === 'not_authenticated') {
      // No partial data exists to salvage from an auth failure, so it escapes
      // even `noThrow` callers. Flipping the store here is what routes a
      // mid-session 401 back to sign-in instead of a dead "network error".
      authenticated.set(false)
      throw new AuthError()
    }
    const detail = (res.detail ?? '').trim()
    const message = detail ? `${res.error ?? 'request failed'}: ${detail.slice(0, 300)}` : (res.error ?? 'request failed')
    if (noThrow) return { data: null, errors: [{ message }] }
    throw new Error(message)
  }
  const body = res.data ?? {}
  const data = (body.data as T) ?? null
  if (body.errors?.length) {
    if (noThrow) return { data, errors: body.errors }
    throw new GraphQLError(body.errors, data)
  }
  return { data, errors: [] }
}

/**
 * Alias the same selection across many repos so N repos cost one round trip.
 * This is the whole reason a fleet-wide sweep is fast enough to be a habit.
 *
 * Entries that are not exactly `owner/name` are skipped rather than sent: a
 * missing name would arrive unset against a `String!` declaration and GitHub
 * would reject the ENTIRE batch, silently losing the other repos in the group.
 * The returned `aliases` map keeps caller-side correlation honest.
 */
export const batchQueries = (
  repos: string[],
  selection: string,
): { query: string; variables: Vars; aliases: string[]; skipped: string[] } => {
  const variables: Vars = {}
  const parts: string[] = []
  const aliases: string[] = []
  const skipped: string[] = []

  for (const nameWithOwner of repos) {
    const segments = nameWithOwner.split('/')
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      skipped.push(nameWithOwner)
      continue
    }
    const i = aliases.length
    variables[`r${i}_o`] = segments[0]
    variables[`r${i}_n`] = segments[1]
    parts.push(`r${i}: repository(owner: $r${i}_o, name: $r${i}_n) { nameWithOwner ${selection} }`)
    aliases.push(nameWithOwner)
  }

  const decls = Object.keys(variables)
    .map((k) => `$${k}: String!`)
    .join(', ')
  return {
    query: parts.length ? `query Batch(${decls}) {\n${parts.join('\n')}\n}` : '',
    variables,
    aliases,
    skipped,
  }
}

// ------------------------------------------------ selections ------------------------------------------------

const STATUS_ROLLUP_SELECTION = `
  statusCheckRollup {
    state
    contexts(first: 50) {
      nodes {
        __typename
        ... on CheckRun { name conclusion status }
        ... on StatusContext { context state }
      }
    }
  }
`

/**
 * `headRefOid` matters: passing it as `expectedHeadOid` makes a merge fail
 * rather than land the wrong commit if the branch moved between the sweep and
 * the click. Both `mergePullRequest` and `enableAutoMerge` send it.
 */
const PR_CORE = `
  id number title url createdAt updatedAt isDraft
  headRefName headRefOid baseRefName mergeable mergeStateStatus
  additions deletions changedFiles
  author { login __typename }
  reviewDecision
`

const DEPENDABOT_SELECTION = `
  pullRequests(first: 100, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes {
      ${PR_CORE}
      ${STATUS_ROLLUP_SELECTION}
    }
    pageInfo { hasNextPage }
  }
`

type RawPR = Omit<PullRequest, 'repo' | 'repoShort' | 'checks'>

/**
 * GitHub's GraphQL API returns `dependabot[bot]` as the Bot actor login, and
 * for some Dependabot pull requests returns `author: null` outright
 * (dependabot/dependabot-core#9656). The branch prefix is therefore a genuine
 * second path, not a fallback that never runs.
 *
 * ponytail: branch-name heuristic. A repo that overrides Dependabot's
 * `pull-request-branch-name.separator`/prefix will be missed; upgrade to
 * matching on the PR's `app` association if that ever bites.
 */
const isDependabotPR = (pr: RawPR): boolean => {
  const login = pr.author?.login
  if (login === 'dependabot[bot]' || login === 'app/dependabot' || login === 'dependabot') return true
  if (pr.author?.__typename === 'Bot' && login?.startsWith('dependabot')) return true
  return (pr.headRefName || '').startsWith('dependabot/')
}

// ------------------------------------------------ queries ------------------------------------------------

export const fetchViewer = async (): Promise<Viewer | null> => {
  const { data } = await gql<{ viewer: Viewer }>(`query { viewer { login name avatarUrl id } }`)
  return data?.viewer ?? null
}

type RepoPage = { nodes: Repo[]; pageInfo: { endCursor: string; hasNextPage: boolean } }
type RepoQuery = { repositoryOwner: { repositories: RepoPage } | null }

/**
 * Every repository the owner can act on, newest push first.
 *
 * Throws rather than returning a short list: a 401, a rate limit, or an
 * unknown login would otherwise be indistinguishable from an account with no
 * repositories, and the caller would cache that emptiness for the session.
 */
export const fetchRepos = async (owner: string): Promise<Repo[]> => {
  const repos: Repo[] = []
  let cursor: string | null = null
  for (;;) {
    // Annotated rather than inferred: `cursor` is fed back into the next
    // request, and inference would chase its own tail through the loop.
    const { data, errors }: Result<RepoQuery> = await gql<RepoQuery>(
      `query($owner: String!, $cursor: String) {
        repositoryOwner(login: $owner) {
          ... on RepositoryOwner {
            repositories(
              first: 100,
              ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
              isFork: false,
              orderBy: { field: PUSHED_AT, direction: DESC },
              after: $cursor
            ) {
              nodes {
                id name nameWithOwner description isArchived isPrivate
                primaryLanguage { name } stargazerCount updatedAt pushedAt
                defaultBranchRef { name } autoMergeAllowed
              }
              pageInfo { endCursor hasNextPage }
            }
          }
        }
      }`,
      { owner, cursor },
      { noThrow: true },
    )

    if (errors.length) throw new GraphQLError(errors, data)
    const page: RepoPage | undefined = data?.repositoryOwner?.repositories
    if (!page) throw new Error(`No repository owner named "${owner}"`)

    repos.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) break
    cursor = page.pageInfo.endCursor
  }
  return repos
}

type BatchNode<K extends string, V> = { nameWithOwner: string } & Record<K, V>

/** Repos whose result set hit the per-repo page cap and is therefore partial. */
export type Truncation = { repo: string; kind: 'pullRequests' | 'issues' }

export type DependabotResult = {
  prs: PullRequest[]
  truncated: Truncation[]
  skipped: string[]
  /** Repos whose alias came back null — inaccessible, renamed, or errored. */
  failed: string[]
  /** Deduplicated error messages GitHub attached to the partial responses. */
  errors: string[]
}

/**
 * Batch-fetch open Dependabot pull requests across the scope.
 *
 * ponytail: takes the first 100 open PRs per repo and filters for Dependabot
 * client-side, so a repo with more than 100 open pull requests reports a
 * partial result — surfaced via `truncated` rather than hidden. Upgrade path
 * is the `search` connection with `author:app/dependabot`, which filters
 * server-side but costs one query per page instead of one per ten repos.
 *
 * ponytail: batches run sequentially to stay well inside GitHub's secondary
 * rate limits. Raise to a small bounded pool if sweeps get slow.
 */
export const fetchDependabotPRs = async (repos: string[], step = 10): Promise<DependabotResult> => {
  const prs: PullRequest[] = []
  const truncated: Truncation[] = []
  const allSkipped: string[] = []
  const failed: string[] = []
  const messages = new Set<string>()

  for (let i = 0; i < repos.length; i += step) {
    const group = repos.slice(i, i + step)
    const { query, variables, aliases, skipped } = batchQueries(group, DEPENDABOT_SELECTION)
    allSkipped.push(...skipped)
    if (!query) continue

    // `noThrow`: one inaccessible repo nulls its alias and attaches an error,
    // but the other repos in the batch still answer. Throwing here used to
    // discard all of them.
    const { data, errors } = await gql<
      Record<string, BatchNode<'pullRequests', { nodes: RawPR[]; pageInfo: { hasNextPage: boolean } }> | null>
    >(query, variables, { noThrow: true })
    for (const e of errors) messages.add(e.message)

    aliases.forEach((name, j) => {
      const node = data?.[`r${j}`]
      if (!node) {
        failed.push(name)
        return
      }
      if (node.pullRequests?.pageInfo?.hasNextPage) {
        truncated.push({ repo: node.nameWithOwner, kind: 'pullRequests' })
      }
      for (const pr of (node.pullRequests?.nodes ?? []).filter(isDependabotPR)) {
        prs.push({
          ...pr,
          repo: node.nameWithOwner,
          repoShort: node.nameWithOwner.split('/')[1] ?? node.nameWithOwner,
          checks: flattenChecks(pr),
        })
      }
    })
  }

  prs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return { prs, truncated, skipped: allSkipped, failed, errors: [...messages] }
}

const issueSelection = (withIssueType: boolean): string => `
  id number title url state createdAt updatedAt
  body author { login }
  labels(first: 20) { nodes { id name color } }
  comments { totalCount }
  assignees(first: 10) { nodes { login } }
  ${withIssueType ? 'issueType { name }' : ''}
`

/**
 * `issueType` is not in every GitHub deployment's schema (GHES lags dotcom by
 * quarters), and an unknown field is a validation error that nulls the WHOLE
 * batch — so on the first such rejection the sweep retries without it and
 * stops asking for the rest of the session.
 */
let issueTypeSupported = true

type RawIssue = Omit<Issue, 'repo' | 'repoShort' | 'labels' | 'issueType'> & {
  labels: { nodes: Label[] } | null
  issueType?: { name: string } | null
}

export type IssuesResult = {
  issues: Issue[]
  truncated: Truncation[]
  skipped: string[]
  /** Repos whose alias came back null — inaccessible, renamed, or errored. */
  failed: string[]
  /** Deduplicated error messages GitHub attached to the partial responses. */
  errors: string[]
}

/**
 * Batch-fetch issues across the scope (issues only, never pull requests).
 * `states` defaults to open; pass others to widen it.
 *
 * ponytail: same first-100-per-repo cap as the pull request sweep, reported
 * through `truncated` rather than silently dropped.
 */
export const fetchIssues = async (
  repos: string[],
  states: ('OPEN' | 'CLOSED')[] = ['OPEN'],
  step = 10,
): Promise<IssuesResult> => {
  const issues: Issue[] = []
  const truncated: Truncation[] = []
  const allSkipped: string[] = []
  const failed: string[] = []
  const messages = new Set<string>()

  type IssuesData = Record<string, BatchNode<'issues', { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean } }> | null>

  // `states` is a GraphQL variable, not string interpolation.
  const runGroup = async (group: string[], withIssueType: boolean) => {
    const selection = `
      issues(first: 100, states: $states, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ${issueSelection(withIssueType)} }
        pageInfo { hasNextPage }
      }
    `
    const { query, variables, aliases, skipped } = batchQueries(group, selection)
    if (!query) return { aliases, skipped, data: null as IssuesData | null, errors: [] as { message: string }[] }
    const withStates = query.replace('query Batch(', 'query Batch($states: [IssueState!], ')
    const { data, errors } = await gql<IssuesData>(withStates, { ...variables, states }, { noThrow: true })
    return { aliases, skipped, data, errors }
  }

  for (let i = 0; i < repos.length; i += step) {
    const group = repos.slice(i, i + step)
    let result = await runGroup(group, issueTypeSupported)
    if (
      issueTypeSupported &&
      !result.data &&
      result.errors.some((e) => /issueType/i.test(e.message))
    ) {
      issueTypeSupported = false
      result = await runGroup(group, false)
    }
    const { aliases, skipped, data, errors } = result
    allSkipped.push(...skipped)
    for (const e of errors) messages.add(e.message)
    if (!aliases.length) continue

    aliases.forEach((name, j) => {
      const node = data?.[`r${j}`]
      if (!node) {
        failed.push(name)
        return
      }
      if (node.issues?.pageInfo?.hasNextPage) {
        truncated.push({ repo: node.nameWithOwner, kind: 'issues' })
      }
      for (const iss of node.issues?.nodes ?? []) {
        issues.push({
          ...iss,
          repo: node.nameWithOwner,
          repoShort: node.nameWithOwner.split('/')[1] ?? node.nameWithOwner,
          labels: iss.labels?.nodes ?? [],
          issueType: iss.issueType ?? null,
        })
      }
    })
  }

  issues.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return { issues, truncated, skipped: allSkipped, failed, errors: [...messages] }
}

export type IssueDetail = Omit<Issue, 'repo' | 'repoShort' | 'labels' | 'issueType'> & {
  labels: { nodes: Label[] } | null
  closedByPullRequestsReferences: { totalCount: number; nodes: LinkedPullRequest[] } | null
}

/** One issue plus the pull requests that close it. */
export const fetchIssueDetail = async (repo: string, number: number): Promise<IssueDetail | null> => {
  const [o, n] = repo.split('/')
  const { data } = await gql<{ repository: { issue: IssueDetail | null } | null }>(
    `query($o: String!, $n: String!, $number: Int!) {
      repository(owner: $o, name: $n) {
        issue(number: $number) {
          id number title url state createdAt updatedAt body
          author { login }
          labels(first: 20) { nodes { id name color } }
          comments { totalCount }
          assignees(first: 10) { nodes { login } }
          closedByPullRequestsReferences(first: 5) {
            totalCount
            nodes {
              ${PR_CORE}
              ${STATUS_ROLLUP_SELECTION}
            }
          }
        }
      }
    }`,
    { o, n, number },
  )
  return data?.repository?.issue ?? null
}

export const fetchLabels = async (repo: string): Promise<Label[]> => {
  const [o, n] = repo.split('/')
  const { data } = await gql<{ repository: { labels: { nodes: Label[] } | null } | null }>(
    `query($o: String!, $n: String!) {
      repository(owner: $o, name: $n) {
        labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { id name color } }
      }
    }`,
    { o, n },
  )
  return data?.repository?.labels?.nodes ?? []
}

/**
 * Current head commit for each pull request, by node id.
 *
 * The merge dialog re-reads these before a retry: a merge that failed because
 * the branch moved would otherwise be retried with the same stale
 * `expectedHeadOid` and fail identically forever.
 */
export const fetchHeadOids = async (ids: string[]): Promise<Map<string, string>> => {
  if (!ids.length) return new Map()
  const { data } = await gql<{ nodes: ({ id: string; headRefOid: string | null } | null)[] }>(
    `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id headRefOid } } }`,
    { ids },
  )
  const oids = new Map<string, string>()
  for (const node of data?.nodes ?? []) {
    if (node?.id && node.headRefOid) oids.set(node.id, node.headRefOid)
  }
  return oids
}

// ------------------------------------------------ mutations ------------------------------------------------

export const mergePullRequest = async (
  pullRequestId: string,
  { method = 'SQUASH', expectedHeadOid = null }: { method?: MergeMethod; expectedHeadOid?: string | null } = {},
) => {
  const input: Vars = { pullRequestId, mergeMethod: method }
  if (expectedHeadOid) input.expectedHeadOid = expectedHeadOid
  const { data } = await gql<{ mergePullRequest: unknown }>(
    `mutation($input: MergePullRequestInput!) {
      mergePullRequest(input: $input) { pullRequest { id state mergeStateStatus mergedAt } }
    }`,
    { input },
  )
  return data?.mergePullRequest ?? null
}

/**
 * Queue a merge for when required checks finish. `expectedHeadOid` matters
 * more here than on a direct merge, not less: auto-merge has the widest window
 * between the sweep and the commit that actually lands.
 */
export const enableAutoMerge = async (
  pullRequestId: string,
  { method = 'SQUASH', expectedHeadOid = null }: { method?: MergeMethod; expectedHeadOid?: string | null } = {},
) => {
  // No deleteBranch here: EnablePullRequestAutoMergeInput has no such field,
  // and an unknown field fails the WHOLE mutation — auto-merge silently never
  // got enabled. Branch deletion for queued merges is GitHub's repo-level
  // auto-delete setting; for direct merges it is deleteHeadRef below.
  const input: Vars = { pullRequestId, mergeMethod: method }
  if (expectedHeadOid) input.expectedHeadOid = expectedHeadOid
  const { data } = await gql<{ enablePullRequestAutoMerge: unknown }>(
    `mutation($input: EnablePullRequestAutoMergeInput!) {
      enablePullRequestAutoMerge(input: $input) { pullRequest { id mergeStateStatus } }
    }`,
    { input },
  )
  return data?.enablePullRequestAutoMerge ?? null
}

/**
 * Delete a merged pull request's head branch. Two steps because `deleteRef`
 * wants the ref's node id, which the sweep doesn't carry.
 *
 * Returns false when the ref is already gone — the repo's own auto-delete
 * setting often wins the race, and that is success from the user's point of
 * view, not an error.
 */
export const deleteHeadRef = async (pullRequestId: string): Promise<boolean> => {
  const { data } = await gql<{ node: { headRef: { id: string } | null } | null }>(
    `query($id: ID!) { node(id: $id) { ... on PullRequest { headRef { id } } } }`,
    { id: pullRequestId },
  )
  const refId = data?.node?.headRef?.id
  if (!refId) return false
  await gql(`mutation($input: DeleteRefInput!) { deleteRef(input: $input) { clientMutationId } }`, {
    input: { refId },
  })
  return true
}

/**
 * Flip a repository's "Allow auto-merge" setting.
 *
 * REST via a scoped Tauri command, not GraphQL: `UpdateRepositoryInput`
 * carries no auto-merge field (verified by schema introspection), so the
 * backend PATCHes `/repos/{owner}/{repo}` — the only API that can do this.
 */
export const setRepoAutoMerge = async (nameWithOwner: string, allow: boolean): Promise<void> => {
  const [owner, repo, ...rest] = nameWithOwner.split('/')
  if (!owner || !repo || rest.length > 0) throw new Error(`Not a full repo name: "${nameWithOwner}"`)
  await invoke('set_repo_auto_merge', { owner, repo, allow })
}

export const setIssueState = async (issueId: string, closed: boolean) => {
  const mutation = closed ? 'closeIssue' : 'reopenIssue'
  const inputType = closed ? 'CloseIssueInput' : 'ReopenIssueInput'
  const { data } = await gql<Record<string, unknown>>(
    `mutation($input: ${inputType}!) { ${mutation}(input: $input) { issue { id state } } }`,
    { input: { issueId } },
  )
  return data?.[mutation] ?? null
}

export const addLabels = async (labelableId: string, labelIds: string[]) => {
  if (!labelIds.length) return null
  const { data } = await gql<{ addLabelsToLabelable: unknown }>(
    `mutation($input: AddLabelsToLabelableInput!) {
      addLabelsToLabelable(input: $input) { labelable { ... on Issue { id } ... on PullRequest { id } } }
    }`,
    { input: { labelableId, labelIds } },
  )
  return data?.addLabelsToLabelable ?? null
}

export const addComment = async (subjectId: string, body: string) => {
  const { data } = await gql<{ addComment: unknown }>(
    `mutation($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }`,
    { input: { subjectId, body } },
  )
  return data?.addComment ?? null
}

export const addAssignees = async (assignableId: string, userIds: string[]) => {
  if (!userIds.length) return null
  const { data } = await gql<{ addAssigneesToAssignable: unknown }>(
    `mutation($input: AddAssigneesToAssignableInput!) {
      addAssigneesToAssignable(input: $input) { assignable { ... on Issue { id } ... on PullRequest { id } } }
    }`,
    { input: { assignableId, userIds } },
  )
  return data?.addAssigneesToAssignable ?? null
}
