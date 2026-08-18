/** Domain types for the slice of the GitHub GraphQL schema this app touches. */

export type Actor = { login: string; __typename?: string }

export type Label = { id: string; name: string; color: string | null }

export type Viewer = { id: string; login: string; name: string | null; avatarUrl: string | null }

export type Repo = {
  id: string
  name: string
  nameWithOwner: string
  description: string | null
  isArchived: boolean
  isPrivate: boolean
  primaryLanguage: { name: string } | null
  stargazerCount: number
  updatedAt: string
  pushedAt: string | null
  defaultBranchRef: { name: string } | null
  /** The repository-level "Allow auto-merge" setting. */
  autoMergeAllowed: boolean
}

export type MergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'BLOCKED_BY_LIFECYCLE_RULE'
  | 'CLEAN'
  | 'CLOSED'
  | 'DIRTY'
  | 'DRAFT'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE'

export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'IN_PROGRESS' | 'QUEUED' | 'ERROR' | string

export type Check = { state: CheckState; name: string }

export type StatusRollupNode =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; status: string | null }
  | { __typename: 'StatusContext'; context: string; state: string | null }

export type PullRequest = {
  id: string
  number: number
  title: string
  url: string
  createdAt: string
  updatedAt: string
  isDraft: boolean
  headRefName: string
  headRefOid?: string | null
  baseRefName: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: MergeStateStatus
  additions: number
  deletions: number
  changedFiles: number
  author: Actor | null
  reviewDecision: string | null
  statusCheckRollup?: { state: string | null; contexts: { nodes: (StatusRollupNode | null)[] } } | null
  /** Attached client-side when batch-fetching across repos. */
  repo: string
  repoShort: string
  checks: Check[]
}

export type Issue = {
  id: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED'
  createdAt: string
  updatedAt: string
  body: string | null
  author: Actor | null
  labels: Label[]
  comments: { totalCount: number }
  assignees: { nodes: Actor[] }
  issueType: { name: string } | null
  repo: string
  repoShort: string
}

/** A PR linked to an issue — same core fields, but not repo-tagged. */
export type LinkedPullRequest = Omit<PullRequest, 'repo' | 'repoShort' | 'checks'> & {
  repo?: string
}

export type SearchHit = {
  /** Requested explicitly so PR/issue discrimination is not a field-presence guess. */
  __typename?: string
  id: string
  number: number
  title: string
  url: string
  state: string
  updatedAt: string
  isDraft?: boolean
  mergeable?: string
  author: Actor | null
  repository: { nameWithOwner: string } | null
  labels: { nodes: { name: string; color: string | null }[] } | null
  comments?: { totalCount: number }
}

/** Status vocabulary shared by the merge-state and checks readouts. */
export type Signal = 'go' | 'hold' | 'stop' | 'idle'

export type MergeState =
  | 'READY'
  | 'UNSTABLE'
  | 'BEHIND'
  | 'BLOCKED'
  | 'DIRTY'
  | 'RULES'
  | 'DRAFT'
  | 'CLOSED'
  | 'UNKNOWN'

export type MergeReadout = { state: MergeState; signal: Signal; text: string }

export type ChecksState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE'

export type ChecksReadout = {
  state: ChecksState
  signal: Signal
  text: string
  passed: number
  failed: number
  pending: number
  total: number
}

export type MergeMethod = 'SQUASH' | 'MERGE' | 'REBASE'

export type Prefs = {
  defaultMerge: MergeMethod
  deleteBranch: boolean
  autoMerge: boolean
}

export type ToastKind = 'info' | 'success' | 'error' | 'spinner'

export type Toast = { id: number; message: string; kind: ToastKind; sticky: boolean }

export type ViewId = 'sweep' | 'bumps' | 'issues' | 'issue' | 'fleet' | 'search' | 'settings'

export type IssueRef = { repo: string; number: number }
