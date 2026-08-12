<script lang="ts">
  import Lamps from './Lamps.svelte'
  import Signal from './Signal.svelte'
  import { bumpOf, checksInfo, mergeInfo } from '../lib/util'
  import type { PullRequest } from '../lib/types'

  let {
    pr,
    selected,
    onToggle,
    onOpen,
    showRepo = true,
    lampWidth,
  }: {
    pr: PullRequest
    selected: boolean
    onToggle: (checked: boolean) => void
    onOpen: () => void
    showRepo?: boolean
    /** Set by the list so every row reserves the same number of cells. */
    lampWidth: number
  } = $props()

  const bump = $derived(bumpOf(pr))
  const merge = $derived(mergeInfo(pr))
  const checks = $derived(checksInfo(pr))

  // Weight and contrast only: a semver step is a property of a version string,
  // not a machine status, so the signal lamps stay out of it.
  const stepTone: Record<string, string> = {
    major: 'text-ink',
    minor: 'text-ink-2',
    patch: 'text-ink-3',
  }
</script>

<div class="group grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-line/60 px-4 py-2 last:border-b-0 hover:bg-hover">
  <input
    type="checkbox"
    checked={selected}
    onchange={(e) => onToggle(e.currentTarget.checked)}
    aria-label="Select {pr.repoShort} #{pr.number}"
    class="h-3.5 w-3.5 cursor-pointer accent-[var(--brass)]"
  />

  <button onclick={onOpen} class="min-w-0 text-left">
    <span class="flex items-baseline gap-2">
      {#if bump}
        <span class="truncate text-[13px] text-ink">{bump.pkg}</span>
        {#if bump.from && bump.to}
          <span class="shrink-0 text-[11px] text-ink-3">
            {bump.from}<span class="mx-1 text-ink-3">→</span><span class="text-ink-2">{bump.to}</span>
          </span>
        {/if}
        {#if bump.step}
          <span class="engraved shrink-0 {stepTone[bump.step]}">{bump.step}</span>
        {/if}
      {:else}
        <span class="truncate text-[13px] text-ink">{pr.title}</span>
      {/if}
    </span>
    <span class="mt-0.5 flex items-center gap-2 text-[11px] text-ink-3">
      {#if showRepo}<span class="text-ink-2">{pr.repoShort}</span>{/if}
      <span>#{pr.number}</span>
      <span class="truncate">{pr.headRefName}</span>
    </span>
  </button>

  <div class="flex shrink-0 items-center gap-4">
    <Lamps checks={pr.checks} width={lampWidth} />
    <span class="hidden w-16 text-right text-[11px] text-ink-3 sm:block">{checks.text}</span>
    <span class="w-20"><Signal signal={merge.signal} text={merge.text} /></span>
  </div>
</div>
