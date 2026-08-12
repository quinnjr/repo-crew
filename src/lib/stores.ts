import { writable, derived, get } from 'svelte/store'
import type { Issue, IssueRef, MergeMethod, Prefs, PullRequest, Repo, Toast, ToastKind, ViewId, Viewer } from './types'

const REPOS_KEY = 'repo-crew.selectedRepos'
const PREFS_KEY = 'repo-crew.prefs'
const THEME_KEY = 'repo-crew.theme'
const PIVOT_KEY = 'repo-crew.pivot'

/** Every localStorage touch is guarded — a blocked storage partition must not take the app down. */
const readRaw = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

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

const writeJSON = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode, quota) — settings just don't persist */
  }
}

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

/** Repos whose result set was capped by the per-repo page limit. */
export const truncatedRepos = writable<string[]>([])

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
