import type { Issue, PullRequest, Repo, Viewer } from './types'

/**
 * Persistent cache for fetched GitHub data, so a launch renders the last
 * known board instantly instead of a spinner while the refresh runs.
 *
 * Every entry is stamped with the scope it was fetched for (the selected-repo
 * list, or the viewer login for account-wide data) and is ignored when read
 * under any other scope — stale data for the *current* scope is useful; data
 * for a different scope is just wrong.
 */

/** Bump when a cached shape changes; old entries then read as absent. */
const CACHE_VERSION = 2 // 2: Repo rows gained autoMergeAllowed

type Entry = { v: number; scope: string; savedAt: number; data: unknown }

/*
 * Guarded localStorage access, shared with stores.ts (which imports from
 * here — the dependency can only point this way without a cycle). A blocked
 * storage partition degrades to "no value", never a throw.
 */

export const readRaw = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const writeJSON = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode, quota) — the value just doesn't persist */
  }
}

const removeKey = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    /* nothing to remove if storage is unreachable */
  }
}

export const writeCache = (key: string, scope: string, data: unknown): void => {
  const entry: Entry = { v: CACHE_VERSION, scope, savedAt: Date.now(), data }
  writeJSON(key, entry)
}

export const readCache = <T>(key: string, scope: string, validate: (v: unknown) => T | null): T | null => {
  const raw = readRaw(key)
  if (raw === null) return null
  let entry: Entry
  try {
    entry = JSON.parse(raw) as Entry
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  if (entry.v !== CACHE_VERSION || entry.scope !== scope) return null
  return validate(entry.data)
}

// ---------------- validators ----------------

/*
 * Same philosophy as the validators in stores.ts: anything at all may be in
 * localStorage, and a bad value must yield "no cache", never a throw or a
 * malformed row rendered as a board entry. Rows are shape-checked on the
 * fields the views key on; a bad row is dropped, the rest survive.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const str = (v: unknown): v is string => typeof v === 'string'

export const asCachedViewer = (v: unknown): Viewer | null => {
  if (!isObject(v) || !str(v.id) || !str(v.login)) return null
  return {
    id: v.id,
    login: v.login,
    name: str(v.name) ? v.name : null,
    avatarUrl: str(v.avatarUrl) ? v.avatarUrl : null,
  }
}

const isRepoRow = (v: unknown): v is Repo => isObject(v) && str(v.id) && str(v.nameWithOwner)

export const asCachedRepos = (v: unknown): Repo[] | null =>
  Array.isArray(v) ? v.filter(isRepoRow) : null

/** The fields every PR/issue row render path dereferences unconditionally. */
const isPrRow = (v: unknown): v is PullRequest =>
  isObject(v) && str(v.id) && typeof v.number === 'number' && str(v.title) && str(v.repo)

const isIssueRow = (v: unknown): v is Issue =>
  isObject(v) && str(v.id) && typeof v.number === 'number' && str(v.title) && str(v.repo)

const asStringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : [])

export type CachedDependabot = { prs: PullRequest[]; truncated: string[] }

export const asCachedDependabot = (v: unknown): CachedDependabot | null => {
  if (!isObject(v) || !Array.isArray(v.prs)) return null
  return { prs: v.prs.filter(isPrRow), truncated: asStringList(v.truncated) }
}

export type CachedIssues = { issues: Issue[]; truncated: string[] }

export const asCachedIssues = (v: unknown): CachedIssues | null => {
  if (!isObject(v) || !Array.isArray(v.issues)) return null
  return { issues: v.issues.filter(isIssueRow), truncated: asStringList(v.truncated) }
}

// ---------------- keys ----------------

export const VIEWER_CACHE_KEY = 'repo-crew.cache.viewer'
export const REPOS_CACHE_KEY = 'repo-crew.cache.repos'
export const DEPENDABOT_CACHE_KEY = 'repo-crew.cache.dependabot'
export const ISSUES_CACHE_KEY = 'repo-crew.cache.issues'

/**
 * Erase everything the cache persisted. Disconnect calls this: "sign out"
 * must not leave the account's identity, fleet, PR and issue data readable
 * on disk after the token itself is gone.
 */
export const clearCache = (): void => {
  for (const key of [VIEWER_CACHE_KEY, REPOS_CACHE_KEY, DEPENDABOT_CACHE_KEY, ISSUES_CACHE_KEY]) {
    removeKey(key)
  }
}
