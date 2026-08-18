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
  truncatedByKind,
  viewer,
} from './stores'
import { fetchDependabotPRs, fetchIssues, fetchRepos, type Truncation } from './graphql'
import { DEPENDABOT_CACHE_KEY, ISSUES_CACHE_KEY, REPOS_CACHE_KEY, writeCache } from './cache'
import type { Repo } from './types'

/** Raised when a load is attempted before the viewer is known. */
export class NotReadyError extends Error {
  constructor() {
    super('Not signed in yet')
    this.name = 'NotReadyError'
  }
}

/**
 * Shared with the two sweep loaders' flight guards below: at launch,
 * `refreshAtLaunch` and a mounting Fleet can both want the fleet at once,
 * and each sweep's `reposInScope` may want it too — one fetch serves all.
 */
let reposFlight: Promise<void> | null = null

export const loadRepos = async (force = false): Promise<void> => {
  const v = get(viewer)
  if (!v) throw new NotReadyError()
  if (get(allReposLoaded) && !force) return
  if (reposFlight) return reposFlight
  reposFlight = (async () => {
    const repos = await fetchRepos(v.login)
    allRepos.set(repos)
    // Only mark loaded once the fetch actually completed, so a failure is not
    // cached for the rest of the session.
    allReposLoaded.set(true)
    // Keyed by login so another account's fleet never hydrates after a switch.
    writeCache(REPOS_CACHE_KEY, v.login, repos)
  })()
  try {
    await reposFlight
  } finally {
    reposFlight = null
  }
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
 * Per-kind state lives in the `truncatedByKind` store (not module state
 * here) so cache hydration can seed it — a hydrated PR warning must survive
 * an issues sweep that lands first.
 */
const noteTruncation = (kind: Truncation['kind'], repos: Truncation[]): void => {
  truncatedByKind.update((t) => ({ ...t, [kind]: [...new Set(repos.map((x) => x.repo))] }))
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
    // Login-keyed like hydration expects — see hydrateFromCache in stores.ts.
    const login = get(viewer)?.login
    if (login) {
      writeCache(DEPENDABOT_CACHE_KEY, `${login}:${stamp}`, {
        prs,
        truncated: [...new Set(truncated.map((t) => t.repo))],
      })
    }
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
    const login = get(viewer)?.login
    if (login) {
      writeCache(ISSUES_CACHE_KEY, `${login}:${stamp}`, {
        issues: result.issues,
        truncated: [...new Set(result.truncated.map((t) => t.repo))],
      })
    }
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

/**
 * Record a repository's "Allow auto-merge" flip in the store AND the disk
 * cache — without the cache write, the next launch would hydrate the old
 * value and re-show an "auto-merge off" indicator that is no longer true.
 */
export const noteRepoAutoMerge = (name: string, allow: boolean): void => {
  allRepos.update((repos) => {
    const next = repos.map((r) => (r.nameWithOwner === name ? { ...r, autoMergeAllowed: allow } : r))
    const login = get(viewer)?.login
    if (login) writeCache(REPOS_CACHE_KEY, login, next)
    return next
  })
}

/**
 * The stale-while-revalidate half of the launch cache: hydration
 * (`hydrateFromCache` in stores.ts) puts the last run's board on screen with
 * `loaded` up, and this refetches everything behind it. Deliberately NOT the
 * `refresh*` pair — those drop `loaded` first, which would put a spinner
 * over a board that already has content. A failed refresh is toasted and the
 * stale board stays; each view's own load call reports its own errors when
 * there was nothing cached to show.
 */
export const refreshAtLaunch = async (): Promise<void> => {
  const report = (what: string) => (e: unknown) => {
    if (e instanceof NotReadyError) return
    toast(`Could not refresh ${what}: ${e instanceof Error ? e.message : e}`, { kind: 'error' })
  }
  // The fleet strictly first: with no explicit selection the sweeps derive
  // their scope from it, and a hydrated `allRepos` would otherwise satisfy
  // `reposInScope` with LAST session's top-25 — the whole refresh would then
  // sweep a stale scope and nothing would correct it. On failure the sweeps
  // still run, falling back to whatever repo list exists.
  await loadRepos(true).catch(report('the fleet'))
  await Promise.all([
    loadDependabot(true).catch(report('pull requests')),
    loadIssues(true).catch(report('issues')),
  ])
}
