<script lang="ts">
  import {
    anyModalOpen,
    dependabotPRs,
    dependabotLoaded,
    issues,
    issuesLoaded,
    mergeDialog,
    selectedRepos,
    truncatedRepos,
    goTo,
    togglePivot,
  } from '../lib/stores'
  import { loadDependabot, loadIssues, refreshDependabot, refreshIssues } from '../lib/api'
  import { checksInfo, mergeInfo, millis, pluralise } from '../lib/util'
  import Header from '../components/Header.svelte'
  import Ledger from '../components/Ledger.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'

  let error = $state('')
  /**
   * Issues load independently, so their failure gets its own report — and a
   * persistent one: a toast fades in seconds, leaving the issues lamp reading
   * `—` with nothing on screen to say why.
   */
  let issuesError = $state('')

  const loadIssuesReporting = () => {
    issuesError = ''
    loadIssues().catch((e: unknown) => (issuesError = e instanceof Error ? e.message : String(e)))
  }

  $effect(() => {
    loadDependabot().catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
    loadIssuesReporting()
  })

  // `T` transposes the ledger. Ignored while typing, and while any dialog is
  // open — a state change behind a modal has no visible cause.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ($anyModalOpen) return
      const el = e.target as HTMLElement | null
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 't' || e.key === 'T') togglePivot()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ready = $derived($dependabotPRs.filter((p) => mergeInfo(p).state === 'READY'))
  const failing = $derived($dependabotPRs.filter((p) => checksInfo(p).state === 'FAILURE'))
  const stale = $derived($dependabotPRs.filter((p) => Date.now() - millis(p.updatedAt) > 7 * 864e5))

  /**
   * An annunciator strip, not a row of stat cards. Every lamp here is a thing
   * that is either lit or dark right now — that is what a morning sweep asks.
   * A count that has not loaded reads as `—`, never as a confident zero.
   */
  const lamps = $derived([
    { label: 'Open bumps', n: $dependabotPRs.length, loaded: $dependabotLoaded, lamp: 'lamp', to: 'bumps' as const },
    { label: 'Merge ready', n: ready.length, loaded: $dependabotLoaded, lamp: ready.length ? 'lamp lamp-go' : 'lamp', to: 'bumps' as const },
    { label: 'Checks failing', n: failing.length, loaded: $dependabotLoaded, lamp: failing.length ? 'lamp lamp-stop' : 'lamp', to: 'bumps' as const },
    { label: 'Stale 7d+', n: stale.length, loaded: $dependabotLoaded, lamp: stale.length ? 'lamp lamp-hold' : 'lamp', to: 'bumps' as const },
    { label: 'Open issues', n: $issues.length, loaded: $issuesLoaded, lamp: 'lamp', to: 'issues' as const },
  ])

  const refreshAll = () => {
    error = ''
    issuesError = ''
    refreshDependabot().catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
    refreshIssues().catch((e: unknown) => (issuesError = e instanceof Error ? e.message : String(e)))
  }
</script>

<Header
  title="Sweep"
  meta="{pluralise($selectedRepos.length, 'repo')} in scope"
  actions={[
    { label: 'Refresh', icon: 'fa-rotate-right', onclick: refreshAll },
    {
      label: `Merge ${ready.length} ready`,
      icon: 'fa-check-double',
      kind: 'primary',
      disabled: ready.length === 0,
      // Says merge, so it merges. The dialog filters drafts and reports skips.
      onclick: () => mergeDialog.set(ready),
    },
  ]}
/>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex flex-wrap items-stretch border-b border-line bg-panel">
    {#each lamps as item}
      <button
        onclick={() => goTo(item.to)}
        class="flex min-w-[7.5rem] flex-1 items-center gap-2.5 border-r border-line px-5 py-3 text-left transition-colors last:border-r-0 hover:bg-hover"
      >
        <span class="{item.lamp} shrink-0"></span>
        <span class="min-w-0">
          <span class="block text-[15px] leading-none text-ink">{item.loaded ? item.n : '—'}</span>
          <span class="engraved mt-1.5 block truncate">{item.label}</span>
        </span>
      </button>
    {/each}
  </div>

  {#if issuesError}
    <p class="shrink-0 border-b border-line bg-panel px-5 py-1.5 text-[11px] text-stop">
      Issues did not load — the issues lamp is dark, not zero: {issuesError}
    </p>
  {/if}

  {#if $truncatedRepos.length > 0}
    <p class="shrink-0 border-b border-line bg-panel px-5 py-1.5 text-[11px] text-hold">
      {pluralise($truncatedRepos.length, 'repository', 'repositories')} have more than 100 open pull requests —
      this sweep shows part of the picture.
    </p>
  {/if}

  {#if error}
    <EmptyState
      icon="fa-solid fa-triangle-exclamation"
      title="Could not reach GitHub"
      body={error}
      action={{ label: 'Try again', onclick: refreshAll }}
    />
  {:else if !$dependabotLoaded}
    <div class="flex flex-1 items-center justify-center">
      <Spinner label="Reading the fleet…" />
    </div>
  {:else if $dependabotPRs.length === 0 && $issuesLoaded && $issues.length === 0}
    <EmptyState
      icon="fa-solid fa-mug-hot"
      title="Nothing waiting"
      body="No open dependency updates and no open issues across the {$selectedRepos.length} repos in scope. If the fleet itself looks empty, the GitHub App may not be installed on your account yet — check Fleet."
      action={{ label: 'Widen the scope', onclick: () => goTo('fleet') }}
    />
  {:else}
    <div class="flex min-h-0 flex-1 flex-col">
      <Ledger prs={$dependabotPRs} />
    </div>
  {/if}
</div>
