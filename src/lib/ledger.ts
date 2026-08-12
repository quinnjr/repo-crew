import { bumpOf, mergeInfo, millis, overallSignal, shortRepo, SIGNAL_RANK, signalLamp } from './util'
import type { PullRequest } from './types'
import type { Pivot } from './stores'

export type LedgerRow = {
  key: string
  /** Primary identifier: a repo name, or a package. */
  label: string
  /** Secondary detail shown after the label at lower contrast. */
  detail: string
  members: PullRequest[]
  ready: PullRequest[]
  oldest: string
}

export type SpreadCell = { cls: string; title: string }

/**
 * GitHub's model is repo -> pull request, which is the wrong shape for fan-out
 * work: one dependency bump open in nine repos is nine rows to click.
 * Transposing to change -> repos makes it one row to merge.
 *
 * Under the `change` pivot a PR whose title does not parse falls back to the
 * title itself as its key, so unparseable titles group by exact text rather
 * than silently merging into one bucket.
 */
export const groupRows = (prs: PullRequest[], by: Pivot): LedgerRow[] => {
  const buckets = new Map<string, PullRequest[]>()
  for (const pr of prs) {
    const key = by === 'repo' ? pr.repo : (bumpOf(pr)?.key ?? `title:${pr.title}`)
    const existing = buckets.get(key)
    if (existing) existing.push(pr)
    else buckets.set(key, [pr])
  }

  const rows: LedgerRow[] = []
  for (const [key, members] of buckets) {
    const head = members[0]
    if (!head) continue
    const bump = by === 'change' ? bumpOf(head) : null
    rows.push({
      key,
      label: by === 'repo' ? shortRepo(key) : (bump?.pkg ?? head.title),
      detail:
        by === 'repo'
          ? (key.split('/')[0] ?? '')
          : bump?.from && bump.to
            ? `${bump.from} → ${bump.to}`
            : '',
      members,
      ready: members.filter((p) => mergeInfo(p).state === 'READY'),
      oldest: members.reduce((acc, p) => (millis(p.updatedAt) < millis(acc) ? p.updatedAt : acc), head.updatedAt),
    })
  }

  return rows.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label))
}

/** Widest row in the set, so every spread reserves the same number of cells. */
export const spreadWidthOf = (rows: LedgerRow[], cap = 12): number =>
  Math.min(cap, rows.reduce((max, r) => Math.max(max, r.members.length), 1))

/** One cell per pull request in the row, worst-first so trouble reads left. */
export const spreadOf = (row: LedgerRow, width: number): SpreadCell[] => {
  const cells = row.members
    .map((pr) => ({ pr, sig: overallSignal(pr) }))
    .sort((a, b) => SIGNAL_RANK[a.sig] - SIGNAL_RANK[b.sig])
    .slice(0, width)
    .map(({ pr, sig }) => ({
      cls: signalLamp[sig],
      title: `${pr.repoShort} #${pr.number} — ${mergeInfo(pr).text}`,
    }))
  while (cells.length < width) cells.push({ cls: 'lamp opacity-25', title: '' })
  return cells
}
