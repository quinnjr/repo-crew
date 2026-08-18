import type {
  Check,
  ChecksReadout,
  MergeReadout,
  PullRequest,
  LinkedPullRequest,
  Signal,
  StatusRollupNode,
} from './types'

/** Any PR-shaped thing the readouts can describe. */
type PrLike = PullRequest | LinkedPullRequest

export const ago = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const secs = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  const units: [number, string][] = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ]
  for (const [size, suffix] of units) {
    if (secs >= size) return `${Math.floor(secs / size)}${suffix}`
  }
  return `${secs}s`
}

export const shortRepo = (nameWithOwner: string | null | undefined): string => {
  if (!nameWithOwner) return ''
  return nameWithOwner.split('/')[1] ?? nameWithOwner
}

/**
 * Epoch millis for an ISO timestamp.
 *
 * A missing or unparseable date collapses to `0` (the epoch) rather than NaN,
 * so callers can sort without special-casing.
 *
 * Two callers do make a decision on this — the "stale 7d+" tests in
 * `Sweep.svelte` and `Bumps.svelte` — and for them a bad timestamp therefore
 * reads as maximally stale. That is the intended failure direction: a pull
 * request with an unreadable date should surface for attention, not hide.
 */
export const millis = (iso: string | null | undefined): number => {
  const t = iso ? new Date(iso).getTime() : Number.NaN
  return Number.isNaN(t) ? 0 : t
}

export const pluralise = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`

// ------------------------------------------------ the pivot ------------------------------------------------

export type Bump = {
  /** Stable identity of the change, e.g. `lodash@4.17.21` or `group:npm_and_yarn`. */
  key: string
  pkg: string
  from: string | null
  to: string | null
  /** Semver step where both versions parse, else null. */
  step: 'major' | 'minor' | 'patch' | null
  /** True when this is a Dependabot grouped update rather than a single package. */
  grouped: boolean
}

// "Bump lodash from 4.17.20 to 4.17.21", "chore(deps): bump vite from 8.1.0 to 8.2.0"
const SINGLE_RE = /bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i
// "Bump the npm_and_yarn group with 3 updates", "... group across 2 directories with 5 updates"
const GROUP_RE = /bump\s+the\s+([\w.@/-]+)\s+group\b/i
// "Bump lodash and axios from 1.0.0 to 2.0.0" — multi-package, no single version pair
const MULTI_RE = /bump\s+([\w@./-]+(?:\s*,\s*[\w@./-]+)*)\s+and\s+([\w@./-]+)/i
// Last resort: "Bump lodash" / "Bump lodash to 4.17.21". Anchored to the end of
// the title on purpose — an unanchored match turns prose like "Bump minimum
// Node version to 22" into the key `minimum`, so two unrelated chores collapse
// into one ledger row and become a single bulk-merge target.
const NAKED_RE = /^(?:.*?:\s*)?bump\s+([\w@./-]+)(?:\s+to\s+(\S+))?\s*$/i

/**
 * Words `NAKED_RE` can capture that are never a package name. Without this,
 * "Bump the npm_and_yarn group with 3 updates" keys on `the`, and every
 * grouped PR in the fleet collapses into one ledger row.
 */
const STOP_WORDS = new Set(['the', 'a', 'an', 'all', 'my', 'our', 'to', 'up', 'and'])

/** Strip a leading `v` so a Go repo and an npm repo agree on `1.2.3`. */
const normaliseVersion = (v: string): string => v.replace(/^v(?=\d)/, '')

/**
 * Read the change out of a Dependabot PR title.
 *
 * This is what makes the ledger pivot: one `lodash@4.17.21` open across nine
 * repos is a single thing to act on, so it needs a single identity that is
 * stable across those nine pull requests.
 *
 * ponytail: title parsing, not the Dependabot metadata API. Titles are the
 * only signal available from the PR list query; if a repo customises
 * `commit-message.prefix` beyond recognition, upgrade to reading the
 * `dependabot/` branch path or the PR body's dependency table.
 */
export const bumpOf = (pr: Pick<PrLike, 'title'>): Bump | null => {
  const title = pr.title ?? ''

  // Grouped updates carry no single version, and must NOT fall through to the
  // naked branch — see STOP_WORDS.
  const grouped = GROUP_RE.exec(title)
  if (grouped?.[1]) {
    const name = grouped[1]
    return { key: `group:${name}`, pkg: `${name} group`, from: null, to: null, step: null, grouped: true }
  }

  // Two `from … to …` pairs means two packages in one title. SINGLE_RE would
  // match the first and silently drop the second, claiming a single-package
  // identity for a change that touches two.
  const pairs = (title.match(/\sfrom\s/gi) ?? []).length
  const single = pairs === 1 ? SINGLE_RE.exec(title) : null
  if (single) {
    const [, pkg = '', rawFrom = '', rawTo = ''] = single
    const from = normaliseVersion(rawFrom)
    const to = normaliseVersion(rawTo)
    return { key: `${pkg}@${to}`, pkg, from, to, step: semverStep(from, to), grouped: false }
  }

  const multi = MULTI_RE.exec(title)
  if (multi?.[1] && multi[2]) {
    const names = [...multi[1].split(/\s*,\s*/), multi[2]].map((n) => n.trim()).filter(Boolean)
    // Sorted, so the same pair of packages keys identically however the title
    // happens to order them — otherwise the change pivot splits them in two.
    const key = [...names].sort().join(', ')
    return { key: `multi:${key}`, pkg: names.join(', '), from: null, to: null, step: null, grouped: true }
  }

  const naked = NAKED_RE.exec(title)
  const candidate = naked?.[1]
  if (candidate && !STOP_WORDS.has(candidate.toLowerCase())) {
    const to = naked?.[2] ? normaliseVersion(naked[2]) : null
    return {
      key: to ? `${candidate}@${to}` : candidate,
      pkg: candidate,
      from: null,
      to,
      step: null,
      grouped: false,
    }
  }
  return null
}

/**
 * Compare two version strings. Missing components are padded with zero so the
 * GitHub Actions form ("from 4 to 5") and two-part Maven versions still
 * classify instead of silently reading as unknown risk.
 */
export const semverStep = (from: string, to: string): Bump['step'] => {
  // Anchored, and only an optional `v` may precede the digits. An open `\D*`
  // prefix would happily read the SHA-pinned Action form ("from 8f4b7f8 to
  // a5ac7e5") as 8.0.0 -> 5.0.0 and render a confident `major` badge.
  const parse = (v: string): [number, number, number] | null => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?=$|[-+.\s])/.exec(v)
    if (!m) return null
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
  }
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return null
  if (a[0] !== b[0]) return 'major'
  if (a[1] !== b[1]) return 'minor'
  if (a[2] !== b[2]) return 'patch'
  // Equal numeric cores with different strings is a prerelease or build move
  // (2.0.0-rc.1 -> 2.0.0). Reporting null there would be indistinguishable
  // from "could not parse", which is what null means everywhere else.
  return from === to ? null : 'patch'
}

// ------------------------------------------------ check states ------------------------------------------------

/**
 * The full GitHub vocabulary for terminal outcomes, spanning
 * `CheckConclusionState`, `CheckStatusState`, and `StatusState`.
 *
 * Only failure and success are enumerated. Pending is the residual, so a
 * value GitHub adds later counts as "still running" rather than vanishing
 * from all three counters — the one classification that cannot mislead.
 */
const FAILED_STATES = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
  'STALE',
])
/** NEUTRAL and SKIPPED do not block a merge, so they count as passing. */
const PASSED_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/**
 * The single place a raw check state becomes a signal.
 *
 * `Lamps` renders per-cell colour and `checksInfo` counts totals; when they
 * each kept their own copy of this vocabulary they disagreed on unrecognised
 * values — one drew an unlit cell while the other announced "1 running".
 */
export const checkSignal = (state: string): Signal => {
  if (FAILED_STATES.has(state)) return 'stop'
  if (PASSED_STATES.has(state)) return 'go'
  // Pending is the residual, so an unknown value is "still running" rather
  // than silently absent from every counter.
  return 'hold'
}

/** Flatten a status rollup into a plain list of check outcomes. */
export const flattenChecks = (pr: { statusCheckRollup?: { contexts: { nodes: (StatusRollupNode | null)[] } } | null }): Check[] => {
  const nodes = pr.statusCheckRollup?.contexts?.nodes ?? []
  return nodes.flatMap((n) => {
    if (!n) return []
    if (n.__typename === 'CheckRun') return [{ state: n.conclusion || n.status || 'PENDING', name: n.name }]
    return [{ state: n.state || 'PENDING', name: n.context || 'status' }]
  })
}

// ------------------------------------------------ readouts ------------------------------------------------

/**
 * Merge state as a signal lamp. `signal` drives colour; `state` drives logic.
 *
 * Only CLEAN and HAS_HOOKS are reported as READY. Everything else — including
 * any enum member GitHub adds later — fails closed to UNKNOWN, because READY
 * is what the bulk-merge queues select on.
 */
export const mergeInfo = (pr: PrLike): MergeReadout => {
  if (pr.isDraft) return { state: 'DRAFT', signal: 'idle', text: 'draft' }
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { state: 'READY', signal: 'go', text: 'ready' }
    case 'UNSTABLE':
      // Mergeable, but a non-required check is failing or still running.
      return { state: 'UNSTABLE', signal: 'hold', text: 'unstable' }
    case 'BEHIND':
      return { state: 'BEHIND', signal: 'hold', text: 'behind' }
    case 'DIRTY':
      return { state: 'DIRTY', signal: 'stop', text: 'conflicts' }
    case 'BLOCKED':
      return { state: 'BLOCKED', signal: 'stop', text: 'blocked' }
    case 'BLOCKED_BY_LIFECYCLE_RULE':
      return { state: 'RULES', signal: 'stop', text: 'ruleset' }
    case 'CLOSED':
      return { state: 'CLOSED', signal: 'stop', text: 'closed' }
    case 'DRAFT':
      return { state: 'DRAFT', signal: 'idle', text: 'draft' }
    default:
      return { state: 'UNKNOWN', signal: 'idle', text: 'unknown' }
  }
}

/** The comment body Dependabot listens for — commented verbatim on the PR. */
export const DEPENDABOT_REBASE_COMMENT = '@dependabot rebase'

/**
 * Whether poking Dependabot for a rebase can actually change anything:
 * BEHIND and DIRTY are the two states a rebase repairs. Anything else —
 * ready, blocked by checks or reviews, draft, closed — would make the poke
 * a no-op comment on the PR.
 */
export const canPokeRebase = (pr: PrLike): boolean => {
  const { state } = mergeInfo(pr)
  return state === 'BEHIND' || state === 'DIRTY'
}

/**
 * GitHub refuses to enable auto-merge on a PR whose checks already pass —
 * "Pull request is in clean status" (often with a doubled "Pull request"
 * prefix, GitHub's own quirk). For "merge when checks pass" that refusal
 * means: merge it directly instead.
 */
export const isCleanStatusError = (msg: string): boolean => /is in clean status/i.test(msg)

/** Roll a PR's checks up into counts and one signal, in a single pass. */
export const checksInfo = (pr: PrLike): ChecksReadout => {
  const checks = 'checks' in pr && pr.checks ? pr.checks : flattenChecks(pr)
  const total = checks.length
  if (!total) {
    return { state: 'NONE', signal: 'idle', text: 'no checks', passed: 0, failed: 0, pending: 0, total: 0 }
  }

  let passed = 0
  let failed = 0
  let pending = 0
  for (const check of checks) {
    const signal = checkSignal(check.state)
    if (signal === 'stop') failed++
    else if (signal === 'go') passed++
    else pending++
  }

  if (failed > 0) return { state: 'FAILURE', signal: 'stop', text: `${failed} failed`, passed, failed, pending, total }
  if (pending > 0) return { state: 'PENDING', signal: 'hold', text: `${pending} running`, passed, failed, pending, total }
  return { state: 'SUCCESS', signal: 'go', text: `${passed} passed`, passed, failed, pending, total }
}

/** Worst-first ranking, so a single call site can order by severity. */
export const SIGNAL_RANK: Record<Signal, number> = { stop: 0, hold: 1, idle: 2, go: 3 }

/** The single lamp that summarises a PR: worst of merge-state and checks. */
export const overallSignal = (pr: PrLike): Signal => {
  const a = mergeInfo(pr).signal
  const b = checksInfo(pr).signal
  return SIGNAL_RANK[a] <= SIGNAL_RANK[b] ? a : b
}

export const signalText: Record<Signal, string> = {
  go: 'text-go',
  hold: 'text-hold',
  stop: 'text-stop',
  idle: 'text-ink-3',
}

export const signalLamp: Record<Signal, string> = {
  go: 'lamp lamp-go',
  hold: 'lamp lamp-hold',
  stop: 'lamp lamp-stop',
  idle: 'lamp',
}
