<script lang="ts">
  import { pivot, mergeDialog, goTo } from '../lib/stores'
  import { groupRows, spreadOf, spreadWidthOf } from '../lib/ledger'
  import { ago, pluralise } from '../lib/util'
  import type { PullRequest } from '../lib/types'

  let { prs }: { prs: PullRequest[] } = $props()

  const rows = $derived(groupRows(prs, $pivot))
  const spreadWidth = $derived(spreadWidthOf(rows))

  /**
   * Precomputed rather than called from the template: `spreadOf` walks every
   * member and computes two readouts each, so calling it inside `{#each}`
   * redoes that work on every render of the table.
   */
  const spreads = $derived(new Map(rows.map((r) => [r.key, spreadOf(r, spreadWidth)])))

  /** One `Date.now()` per render, not one per row. */
  const ages = $derived(new Map(rows.map((r) => [r.key, ago(r.oldest)])))

  /** The owner only earns space when the scope actually spans more than one. */
  const manyOwners = $derived(new Set(prs.map((p) => p.repo.split('/')[0])).size > 1)

  const columnHead = $derived($pivot === 'repo' ? 'Repository' : 'Change')
  const countHead = $derived($pivot === 'repo' ? 'Bumps' : 'Repos')
</script>

<div class="flex shrink-0 items-center gap-3 border-b border-line px-5 py-2">
  <span class="engraved">Read by</span>
  <!-- The pivot is the one control that changes what the board means, so it
       is the one control that gets the brass. -->
  <div class="flex overflow-hidden rounded-sm border border-line-strong" role="group" aria-label="Pivot the ledger">
    {#each [['repo', 'Repository'], ['change', 'Change']] as const as [id, label]}
      <button
        onclick={() => pivot.set(id)}
        aria-pressed={$pivot === id}
        class="px-3 py-1 text-[11px] transition-colors {$pivot === id
          ? 'bg-brass/20 text-brass'
          : 'text-ink-3 hover:bg-hover hover:text-ink-2'}"
      >{label}</button>
    {/each}
  </div>
  <span class="text-[11px] text-ink-3">
    <kbd class="rounded-sm border border-line-strong px-1 py-0.5 text-[10px]">T</kbd> to transpose
  </span>
  <p class="ml-auto hidden text-[11px] text-ink-3 md:block">
    {$pivot === 'repo'
      ? 'Grouped by where the work lives.'
      : 'One row per dependency — merge a fan-out in a single action.'}
  </p>
</div>

{#if rows.length === 0}
  <p class="px-5 py-10 text-center font-sans text-[13px] text-ink-3">
    No open dependency updates in scope.
  </p>
{:else}
  <div class="min-h-0 flex-1 overflow-y-auto">
    <table class="w-full border-collapse text-left">
      <thead class="sticky top-0 z-10 bg-ground">
        <tr class="border-b border-line">
          <th class="engraved py-2 pl-5 pr-3 font-normal">{columnHead}</th>
          <th class="engraved w-16 px-3 py-2 text-right font-normal">{countHead}</th>
          <th class="engraved px-3 py-2 font-normal">Spread</th>
          <th class="engraved w-20 px-3 py-2 text-right font-normal">Oldest</th>
          <th class="engraved w-24 px-3 py-2 text-right font-normal">Ready</th>
          <th class="w-28 py-2 pl-3 pr-5"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row, i (row.key)}
          <tr
            class="settle group border-b border-line/60 transition-colors hover:bg-hover"
            style="animation-delay: {Math.min(i, 14) * 14}ms"
          >
            <td class="max-w-0 py-2 pl-5 pr-3">
              <div class="flex items-baseline gap-2">
                <span class="truncate text-[13px] text-ink">{row.label}</span>
                {#if row.detail && ($pivot === 'change' || manyOwners)}
                  <span class="shrink-0 text-[11px] text-ink-3">{row.detail}</span>
                {/if}
              </div>
            </td>
            <td class="px-3 py-2 text-right text-[12px] text-ink-2">{row.members.length}</td>
            <td class="px-3 py-2">
              <span class="inline-flex items-center gap-[2px]">
                {#each spreads.get(row.key) ?? [] as cell}
                  <span class={cell.cls} title={cell.title}></span>
                {/each}
              </span>
            </td>
            <td class="px-3 py-2 text-right text-[11px] text-ink-3">{ages.get(row.key)}</td>
            <td class="px-3 py-2 text-right text-[12px] {row.ready.length ? 'text-go' : 'text-ink-3'}">
              {row.ready.length}/{row.members.length}
            </td>
            <td class="py-2 pl-3 pr-5 text-right">
              <button
                onclick={() => mergeDialog.set(row.ready)}
                disabled={row.ready.length === 0}
                class="rounded-sm border border-line px-2 py-1 text-[11px] text-ink-3 transition-colors
                       group-hover:border-line-strong group-hover:text-ink-2
                       hover:!border-brass/60 hover:!bg-brass/15 hover:!text-brass
                       disabled:cursor-not-allowed disabled:!border-line disabled:!text-ink-3
                       disabled:opacity-50 disabled:hover:!bg-transparent"
                title={row.ready.length
                  ? `Merge ${pluralise(row.ready.length, 'ready pull request')}`
                  : 'Nothing ready in this row'}
              >
                Merge {row.ready.length}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Pinned to the foot of the pane: the ledger is the summary, and this is
       the way down into the individual pull requests. -->
  <button
    onclick={() => goTo('bumps')}
    class="shrink-0 border-t border-line py-2.5 text-[11px] text-ink-3 transition-colors hover:bg-hover hover:text-ink-2"
  >
    Open every pull request individually
  </button>
{/if}
