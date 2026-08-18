import { writable, derived, get } from 'svelte/store'
import type { Issue, IssueRef, MergeMethod, Prefs, PullRequest, Repo, Toast, ToastKind, ViewId, Viewer } from './types'
import {
  DEPENDABOT_CACHE_KEY,
  ISSUES_CACHE_KEY,
  REPOS_CACHE_KEY,
  VIEWER_CACHE_KEY,
  asCachedDependabot,
  asCachedIssues,
  asCachedRepos,
  asCachedViewer,
  clearCache,
  readCache,
  readRaw,
  writeCache,
  writeJSON,
} from './cache'

const REPOS_KEY = 'repo-crew.selectedRepos'
const PREFS_KEY = 'repo-crew.prefs'
const THEME_KEY = 'repo-crew.theme'
const PIVOT_KEY = 'repo-crew.pivot'

/* Guarded storage access (readRaw/writeJSON) lives in cache.ts — a blocked
   storage partition must not take the app down. */

/**
 * Parse stored JSON, then hand it to a validator.
 *
 * `JSON.parse` only fails on malformed text, so a stored `null`, `{}` or
 * `"foo"` parses cleanly and a bare `as T` would let it through. Since these
 * stores are read at module scope, one bad value used to be enough to throw
 * during import and render a blank app with no in-app way to clear it.
 */
const readValidated = <T,>(key: string, validate: (v: unknown) => T): T => {
  const raw = readRaw(key)
  if (raw === null) return validate(undefined)
  try {
    return validate(JSON.parse(raw))
  } catch {
    return validate(undefined)
  }
}

/** Exported for tests; not part of the store surface. */
export const asRepoList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

/**
 * Persist on change, skipping the synchronous first emission Svelte delivers
 * at subscribe time — which would otherwise re-write the value just read.
 */
const persist = (store: { subscribe: (fn: (v: unknown) => void) => unknown }, key: string): void => {
  let first = true
  store.subscribe((value) => {
    if (first) {
      first = false
      return
    }
    writeJSON(key, value)
  })
}

// ---------------- scope ----------------

/** Selected repo `nameWithOwner` list — every view acts on exactly these. */
export const selectedRepos = writable<string[]>(readValidated(REPOS_KEY, asRepoList))
persist(selectedRepos, REPOS_KEY)

export const selectedRepoSet = derived(selectedRepos, (r) => new Set(r))

export const toggleRepo = (name: string): void => {
  const cur = get(selectedRepos)
  selectedRepos.set(cur.includes(name) ? cur.filter((r) => r !== name) : [...cur, name])
}

export const allRepos = writable<Repo[]>([])
export const allReposLoaded = writable(false)

// ---------------- toasts ----------------

export const toasts = writable<Toast[]>([])
let toastId = 0

export const dismiss = (id: number): void => {
  toasts.update((t) => t.filter((x) => x.id !== id))
}

export const toast = (message: string, opts: { kind?: ToastKind; sticky?: boolean } = {}): number => {
  const { kind = 'info', sticky = false } = opts
  const id = ++toastId
  toasts.update((t) => [...t, { id, message, kind, sticky }])
  if (!sticky) setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3200)
  return id
}

// ---------------- routing ----------------

export type ViewDef = { id: ViewId; label: string; icon: string; hint: string }

/** Rail order is the order of the working day: sweep, then act, then widen. */
export const views: ViewDef[] = [
  { id: 'sweep', label: 'Sweep', icon: 'fa-solid fa-table-columns', hint: 'What changed overnight' },
  { id: 'bumps', label: 'Bumps', icon: 'fa-solid fa-arrow-up-right-dots', hint: 'Dependency updates across the fleet' },
  { id: 'issues', label: 'Issues', icon: 'fa-regular fa-circle-dot', hint: 'Cross-repo issue triage' },
  { id: 'fleet', label: 'Fleet', icon: 'fa-solid fa-layer-group', hint: 'Which repos are in scope' },
  { id: 'search', label: 'Search', icon: 'fa-solid fa-magnifying-glass', hint: 'All of GitHub' },
]

export const activeView = writable<ViewId>('sweep')
export const activeIssue = writable<IssueRef | null>(null)

export const goTo = (view: ViewId, issue: IssueRef | null = null): void => {
  activeIssue.set(issue)
  activeView.set(view)
}

/**
 * How the ledger is read. `repo` groups by where the work lives; `change`
 * transposes so one dependency bump open in nine repos is a single row.
 */
export type Pivot = 'repo' | 'change'
export const pivot = writable<Pivot>(
  // Narrowed rather than cast: an out-of-vocabulary value would leave both
  // toggle buttons reading unpressed while grouping silently behaved as
  // `change`.
  readValidated(PIVOT_KEY, (v) => (v === 'change' ? 'change' : 'repo')),
)
persist(pivot, PIVOT_KEY)

export const togglePivot = (): void => {
  pivot.update((p) => (p === 'repo' ? 'change' : 'repo'))
}

// ---------------- modal stack ----------------

/**
 * Which dialogs are open, innermost last.
 *
 * Every dialog binds its own Escape handler to `window`, so without a stack a
 * single Escape closes the palette AND the merge dialog underneath it. Global
 * shortcuts consult `topModal` before acting.
 */
const modalStack = writable<symbol[]>([])
export const topModal = derived(modalStack, (s) => s.at(-1) ?? null)
export const anyModalOpen = derived(modalStack, (s) => s.length > 0)

export const pushModal = (token: symbol): void => modalStack.update((s) => [...s, token])
export const popModal = (token: symbol): void => modalStack.update((s) => s.filter((t) => t !== token))
export const isTopModal = (token: symbol): boolean => get(modalStack).at(-1) === token

// ---------------- prefs ----------------

const DEFAULT_PREFS: Prefs = { defaultMerge: 'SQUASH', deleteBranch: true, autoMerge: true }

const MERGE_METHODS: MergeMethod[] = ['SQUASH', 'MERGE', 'REBASE']

/**
 * A stored `defaultMerge` outside the enum would be spread over the default
 * and sent straight to GitHub as `mergeMethod`, failing every pull request in
 * a bulk merge with an opaque error and leaving all three strategy buttons
 * reading unpressed.
 */
/** Exported for tests; not part of the store surface. */
export const asPrefs = (v: unknown): Prefs => {
  const raw = (typeof v === 'object' && v !== null ? v : {}) as Partial<Prefs>
  return {
    defaultMerge: MERGE_METHODS.includes(raw.defaultMerge as MergeMethod)
      ? (raw.defaultMerge as MergeMethod)
      : DEFAULT_PREFS.defaultMerge,
    deleteBranch: typeof raw.deleteBranch === 'boolean' ? raw.deleteBranch : DEFAULT_PREFS.deleteBranch,
    autoMerge: typeof raw.autoMerge === 'boolean' ? raw.autoMerge : DEFAULT_PREFS.autoMerge,
  }
}

export const prefs = writable<Prefs>(readValidated(PREFS_KEY, asPrefs))
persist(prefs, PREFS_KEY)

// ---------------- auth ----------------

/** null = still checking, false = no usable token. */
export const authenticated = writable<boolean | null>(null)
export const viewer = writable<Viewer | null>(null)

// Cached so the next launch can hydrate account-keyed data (the fleet)
// before the token probe answers. A null (signed out) is not written — the
// probe deciding "no token" should not erase who was signed in last.
viewer.subscribe((v) => {
  if (v) writeCache(VIEWER_CACHE_KEY, '', v)
})

/**
 * Set when the keychain itself could not be reached, as opposed to there being
 * no credential stored — the two are indistinguishable once flattened into
 * `authenticated = false`, and the difference decides what we tell the user: a
 * locked keyring needs starting, not another sign-in.
 */
export const keychainError = writable<string | null>(null)

// ---------------- theme ----------------

export type Theme = 'dark' | 'light'

const loadTheme = (): Theme => {
  const stored = readRaw(THEME_KEY)
  if (stored === 'dark' || stored === 'light') return stored
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

export const theme = writable<Theme>(loadTheme())

theme.subscribe((t) => {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    /* see writeJSON */
  }
})

export const toggleTheme = (): void => {
  theme.update((t) => (t === 'dark' ? 'light' : 'dark'))
}

// ---------------- fetched data ----------------

export const dependabotPRs = writable<PullRequest[]>([])
export const dependabotLoaded = writable(false)
export const issues = writable<Issue[]>([])
export const issuesLoaded = writable(false)

/**
 * Repos whose result set was capped by the per-repo page limit, tracked per
 * result kind so an issues sweep does not erase the pull-request sweep's
 * warnings — including warnings hydrated from the cache before either sweep
 * of this session has run.
 */
export const truncatedByKind = writable<{ pullRequests: string[]; issues: string[] }>({
  pullRequests: [],
  issues: [],
})

/** The union the views render. */
export const truncatedRepos = derived(truncatedByKind, (t) => [
  ...new Set([...t.pullRequests, ...t.issues]),
])

/** PRs staged for the merge dialog, or null when it is closed. */
export const mergeDialog = writable<PullRequest[] | null>(null)

/**
 * Changing the scope invalidates everything fetched for the old scope.
 *
 * Fleet promises that "every other view acts on the repositories selected
 * here"; without this the ledger keeps rendering the previous scope's data
 * next to the new repo count, with nothing to say it is stale.
 */
let knownScope = get(selectedRepos).join(',')
selectedRepos.subscribe((repos) => {
  const next = repos.join(',')
  if (next === knownScope) return
  knownScope = next
  dependabotLoaded.set(false)
  issuesLoaded.set(false)
})

// ---------------- cache hydration ----------------

/**
 * Fill the fetched-data stores from the last run's cache so launch renders
 * the last known board instead of a spinner. Hydrated data is marked
 * `loaded` — the stale-while-revalidate refresh (`refreshAtLaunch` in
 * api.ts) runs with `force`, precisely so it never flips `loaded` back down
 * and puts a spinner over a board that already has content.
 *
 * Entries are scope-checked by `readCache`: PR/issue caches against the
 * current repo selection, the repo cache against the cached viewer's login —
 * another account's fleet must not flash on screen after switching users.
 */
export const hydrateFromCache = (): void => {
  // No cached viewer means no account to key any of the data by: hydrate
  // nothing rather than guess whose board this was.
  const me = readCache(VIEWER_CACHE_KEY, '', asCachedViewer)
  if (!me) return

  // Does not touch `authenticated` — only the token probe decides that.
  viewer.set(me)
  const repos = readCache(REPOS_CACHE_KEY, me.login, asCachedRepos)
  if (repos) {
    allRepos.set(repos)
    allReposLoaded.set(true)
  }

  // Login-keyed on top of the repo selection: a token that expired lets a
  // different account sign in without ever passing through Disconnect, and
  // the previous account's board must not hydrate for it.
  const scope = `${me.login}:${get(selectedRepos).join(',')}`
  const dep = readCache(DEPENDABOT_CACHE_KEY, scope, asCachedDependabot)
  if (dep) {
    dependabotPRs.set(dep.prs)
    dependabotLoaded.set(true)
  }
  const iss = readCache(ISSUES_CACHE_KEY, scope, asCachedIssues)
  if (iss) {
    issues.set(iss.issues)
    issuesLoaded.set(true)
  }
  if (dep || iss) {
    truncatedByKind.set({ pullRequests: dep?.truncated ?? [], issues: iss?.truncated ?? [] })
  }
}

/**
 * Forget everything fetched from GitHub — stores and disk cache both.
 * Disconnect runs this so a shared machine keeps no readable trace of the
 * account, and so a later sign-in (same session or next launch) starts from
 * "not loaded" instead of silently showing the previous account's board.
 */
export const resetFetchedData = (): void => {
  allRepos.set([])
  allReposLoaded.set(false)
  dependabotPRs.set([])
  dependabotLoaded.set(false)
  issues.set([])
  issuesLoaded.set(false)
  truncatedByKind.set({ pullRequests: [], issues: [] })
  clearCache()
}

hydrateFromCache()
