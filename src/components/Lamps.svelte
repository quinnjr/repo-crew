<script lang="ts">
  import { checkSignal } from '../lib/util'
  import type { Check, Signal } from '../lib/types'

  /**
   * A CI rollup drawn as fixed-width cells instead of a badge.
   *
   * Checks are sorted by job name and every row pads to the same width, so
   * rows whose repos share a job set line their columns up and a job failing
   * across the fleet reads as a vertical run. That alignment is coincidental,
   * not guaranteed: a repo with an extra job shifts every cell after it.
   */
  let { checks, width = 8 }: { checks: Check[]; width?: number } = $props()

  /**
   * Colour comes from `checkSignal` — the same classifier `checksInfo` counts
   * with — so a cell's lamp and the row's announced totals can never disagree
   * about the same check. The two used to keep separate vocabularies and did
   * exactly that on states only one of them knew.
   */
  const CELL: Record<Signal, { cls: string; word: string }> = {
    go: { cls: 'lamp lamp-go', word: 'passed' },
    stop: { cls: 'lamp lamp-stop', word: 'failed' },
    hold: { cls: 'lamp lamp-hold', word: 'running' },
    idle: { cls: 'lamp', word: 'idle' },
  }

  const cellFor = (check: Check) => {
    const cell = CELL[checkSignal(check.state)]
    return { cls: cell.cls, label: `${check.name}: ${cell.word}` }
  }

  const cells = $derived.by(() => {
    const sorted = [...checks].sort((a, b) => a.name.localeCompare(b.name)).slice(0, width)
    const filled = sorted.map(cellFor)
    while (filled.length < width) filled.push({ cls: 'lamp opacity-30', label: '' })
    return filled
  })

  /** Jobs the strip could not show, so truncation is never silent. */
  const overflow = $derived(Math.max(0, checks.length - width))

  /**
   * `role="img"` hides the per-cell titles from assistive tech, so the label
   * has to carry the actual outcome — colour alone fails a screen reader and
   * a colour-blind user alike.
   */
  const summary = $derived.by(() => {
    if (!checks.length) return 'No checks configured'
    let passed = 0
    let failed = 0
    let pending = 0
    for (const c of checks) {
      const sig = checkSignal(c.state)
      if (sig === 'stop') failed++
      else if (sig === 'go') passed++
      else pending++
    }
    return `${checks.length} checks: ${passed} passed, ${failed} failed, ${pending} running`
  })
</script>

<span class="inline-flex shrink-0 items-center gap-[2px]" role="img" aria-label={summary}>
  {#each cells as cell}
    <span class={cell.cls} title={cell.label}></span>
  {/each}
  {#if overflow > 0}
    <span class="ml-1 text-[9px] text-ink-3" title="{overflow} more checks not shown">+{overflow}</span>
  {/if}
</span>
