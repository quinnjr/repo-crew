import { get } from 'svelte/store'
import {
  allRepos,
  allReposLoaded,
  dependabotLoaded,
  dependabotPRs,
  issues,
  issuesLoaded,
  selectedRepos,
  toast,
  truncatedRepos,
  viewer,
} from './stores'
import { fetchDependabotPRs, fetchIssues, fetchRepos, type Truncation } from './graphql'
import type { Repo } from './types'

/** Raised when a load is attempted before the viewer is known. */
export class NotReadyError extends Error {
  constructor() {
    super('Not signed in yet')
    this.name = 'NotReadyError'
  }
}

export const loadRepos = async (force = false): Promise<void> => {
  const v = get(viewer)
  if (!v) throw new NotReadyError()
  if (get(allReposLoaded) && !force) return
  allRepos.set(await fetchRepos(v.login))
  // Only mark loaded once the fetch actually completed, so a failure is not
  // cached for the rest of the session.
  allReposLoaded.set(true)
}

/**
 * The scope used when nothing is picked yet: the 25 most recently pushed,
 * archived repos excluded — so a first run shows real work instead of an
 * empty board.
 *
 * ponytail: 25 is a flat guess at "enough to be useful, few enough to be
 * fast". Make it a preference if anyone's default sweep is the wrong size.
 */
export const scopeFallback = (repos: Repo[]): string[] =>
  repos
    .filter((r) => !r.isArchived)
    .slice(0, 25)
    .map((r) => r.nameWithOwner)

/**
 * The repos every view acts on. Throws rather than returning `[]` when the
 * fallback cannot be built — an empty scope and a failed lookup must not look
 * the same.
 */
const reposInScope = async (): Promise<string[]> => {
  const chosen = get(selectedRepos)
  if (chosen.length) return chosen
  await loadRepos()
  return scopeFallback(get(allRepos))
}

/**
 * Truncation is tracked per result kind so an issues sweep does not erase the
 * pull-request sweep's warnings (both loaders feed one `truncatedRepos` list).
 */
const truncatedByKind: Record<Truncation['kind'], string[]> = { pullRequests: [], issues: [] }

const noteTruncation = (kind: Truncation['kind'], repos: Truncation[]): void => {
  truncatedByKind[kind] = [...new Set(repos.map((t) => t.repo))]
  truncatedRepos.set([...new Set([...truncatedByKind.pullRequests, ...truncatedByKind.issues])])
}

/** Repos a sweep could not read: malformed names plus aliases GitHub nulled. */
const surfaceMisses = (skipped: string[], failed: string[], errors: string[]): void => {
  const bad = [...skipped, ...failed]
  if (!bad.length) return
  const list = bad.slice(0, 3).join(', ') + (bad.length > 3 ? ` and ${bad.length - 3} more` : '')
  const why = errors[0] ? ` — ${errors[0]}` : ''
  toast(`Could not read ${list}${why}`, { kind: 'error' })
}

/**
 * Re-entrancy: two views mounting at once (Sweep and Bumps both need PRs)
 * must share one fetch, and a result that arrives after the user has changed
 * the scope describes repos no longer on screen — it is dropped, and the
 * scope-change subscriber in `stores.ts` triggers a fresh load.
 */
let dependabotFlight: Promise<void> | null = null
let issuesFlight: Promise<void> | null = null

export const loadDependabot = async (force = false): Promise<void> => {
  if (get(dependabotLoaded) && !force) return
  if (dependabotFlight) return dependabotFlight
  dependabotFlight = (async () => {
    const stamp = get(selectedRepos).join(',')
    const { prs, truncated, skipped, failed, errors } = await fetchDependabotPRs(await reposInScope())
    if (get(selectedRepos).join(',') !== stamp) return
    dependabotPRs.set(prs)
    noteTruncation('pullRequests', truncated)
    surfaceMisses(skipped, failed, errors)
    dependabotLoaded.set(true)
  })()
  try {
    await dependabotFlight
  } finally {
    dependabotFlight = null
  }
}

export const loadIssues = async (force = false): Promise<void> => {
  if (get(issuesLoaded) && !force) return
  if (issuesFlight) return issuesFlight
  issuesFlight = (async () => {
    const stamp = get(selectedRepos).join(',')
    const result = await fetchIssues(await reposInScope())
    if (get(selectedRepos).join(',') !== stamp) return
    issues.set(result.issues)
    noteTruncation('issues', result.truncated)
    surfaceMisses(result.skipped, result.failed, result.errors)
    issuesLoaded.set(true)
  })()
  try {
    await issuesFlight
  } finally {
    issuesFlight = null
  }
}

/**
 * A failed refresh restores `loaded` before rethrowing: the views render a
 * spinner whenever `loaded` is false, so leaving it down would strand them on
 * "Reading the fleet…" forever. A stale board plus the caller's error report
 * beats an infinite spinner.
 */
export const refreshDependabot = async (): Promise<void> => {
  dependabotLoaded.set(false)
  try {
    await loadDependabot(true)
  } catch (e) {
    dependabotLoaded.set(true)
    throw e
  }
}

export const refreshIssues = async (): Promise<void> => {
  issuesLoaded.set(false)
  try {
    await loadIssues(true)
  } catch (e) {
    issuesLoaded.set(true)
    throw e
  }
}
