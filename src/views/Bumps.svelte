<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener'
  // Svelte 5 does not track mutations of a plain Set, and a selection that
  // silently stops updating is worse than no selection at all.
  import { SvelteSet } from 'svelte/reactivity'
  import {
    dependabotPRs,
    dependabotLoaded,
    selectedRepos,
    truncatedRepos,
    mergeDialog,
    pivot,
    goTo,
    toast,
  } from '../lib/stores'
  import { loadDependabot, refreshDependabot } from '../lib/api'
  import { addComment } from '../lib/graphql'
  import { groupRows } from '../lib/ledger'
  import { DEPENDABOT_REBASE_COMMENT, checksInfo, mergeInfo, millis, pluralise } from '../lib/util'
  import Header from '../components/Header.svelte'
  import PrRow from '../components/PrRow.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import type { PullRequest } from '../lib/types'

  let query = $state('')
  let only = $state<'all' | 'ready' | 'failing' | 'blocked' | 'stale'>('all')
  let selected = $state(new SvelteSet<string>())

  /** PRs whose rebase poke is in flight, so the row button can't double-fire. */
  const poking = new SvelteSet<string>()

  /**
   * "@dependabot rebase" as a comment is the whole protocol — the rebase
   * itself lands asynchronously on GitHub's side, so there is nothing to
   * refetch here; Dependabot answers on the PR thread.
   */
  const poke = async (pr: PullRequest) => {
    if (poking.has(pr.id)) return
    poking.add(pr.id)
    try {
      await addComment(pr.id, DEPENDABOT_REBASE_COMMENT)
      toast(`Asked Dependabot to rebase ${pr.repoShort}#${pr.number} — it replies on the pull request`, {
        kind: 'success',
      })
    } catch (e) {
      toast(`Could not poke ${pr.repoShort}#${pr.number}: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
      })
    } finally {
      poking.delete(pr.id)
    }
  }
  let error = $state('')
  let errorTitle = $state('')

  /**
   * Loads throw now, so every failure lands here. `NotReadyError` is not a
   * network fault — titling it "Could not reach GitHub" would send people
   * hunting for an outage that is really a missing token.
   */
  const failed = (e: unknown) => {
    const notReady = e instanceof Error && e.name === 'NotReadyError'
    errorTitle = notReady ? 'Not signed in yet' : 'Could not reach GitHub'
    error = notReady
      ? 'Add a GitHub token in Settings to read the fleet.'
      : e instanceof Error
        ? e.message
        : String(e)
  }

  $effect(() => {
    loadDependabot().catch(failed)
  })

  /**
   * The readouts and the search haystack depend only on the pull requests, so
   * they are computed once per fetch rather than once per keystroke. `filtered`
   * then does nothing but compare already-derived values.
   */
  const index = $derived.by(() => {
    const now = Date.now()
    return $dependabotPRs.map((pr) => ({
      pr,
      mergeState: mergeInfo(pr).state,
      checksState: checksInfo(pr).state,
      stale: now - millis(pr.updatedAt) > 7 * 864e5,
      haystack: `${pr.title} ${pr.repo} ${pr.headRefName} #${pr.number}`.toLowerCase(),
    }))
  })

  const BLOCKED_STATES = ['BLOCKED', 'RULES', 'DIRTY']

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const out: PullRequest[] = []
    for (const entry of index) {
      if (only === 'ready' && entry.mergeState !== 'READY') continue
      if (only === 'failing' && entry.checksState !== 'FAILURE') continue
      if (only === 'blocked' && !BLOCKED_STATES.includes(entry.mergeState)) continue
      if (only === 'stale' && !entry.stale) continue
      if (q && !entry.haystack.includes(q)) continue
      out.push(entry.pr)
    }
    return out
  })

  /**
   * Groups come from the ledger's own `groupRows`, not a local re-derivation:
   * the pivot's promise is that this drill-down and the Sweep ledger agree on
   * what counts as one change, and two copies of the keying logic is exactly
   * how they would drift apart.
   */
  const groups = $derived(groupRows(filtered, $pivot))

  /**
   * Every row reserves as many cells as the busiest pipeline in view, capped at
   * 12; shorter rows pad with dark cells so the columns line up.
   */
  // ponytail: 12 lamp cells; widen the cap (or switch to a count badge) if pipelines routinely run longer.
  const lampWidth = $derived(Math.min(12, filtered.reduce((m, pr) => Math.max(m, pr.checks.length), 1)))

  const chosen = $derived($dependabotPRs.filter((pr) => selected.has(pr.id)))
  const allShown = $derived(filtered.length > 0 && filtered.every((pr) => selected.has(pr.id)))

  const toggle = (id: string, on: boolean) => {
    if (on) selected.add(id)
    else selected.delete(id)
  }

  const toggleAll = () => {
    if (allShown) for (const pr of filtered) selected.delete(pr.id)
    else for (const pr of filtered) selected.add(pr.id)
  }

  const mergeThese = (prs: PullRequest[]) => {
    const ready = prs.filter((p) => mergeInfo(p).state === 'READY')
    if (!ready.length) {
      toast('Nothing in that set is ready to merge yet', { kind: 'info' })
      return
    }
    mergeDialog.set(ready)
  }

  const filters = [
    ['all', 'All'],
    ['ready', 'Ready'],
    ['failing', 'Failing'],
    ['blocked', 'Blocked'],
    ['stale', 'Stale 7d+'],
  ] as const
</script>

<Header
  title="Bumps"
  meta="{pluralise($dependabotPRs.length, 'open update')} across {pluralise($selectedRepos.length, 'repo')}"
  actions={[
    {
      label: 'Refresh',
      icon: 'fa-rotate-right',
      onclick: () => {
        selected.clear()
        error = ''
        errorTitle = ''
        refreshDependabot().catch(failed)
      },
    },
    {
      label: `Merge ${chosen.length}`,
      icon: 'fa-check-double',
      kind: 'primary',
      disabled: chosen.length === 0,
      onclick: () => mergeThese(chosen),
    },
  ]}
/>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-5 py-2">
    <label class="relative">
      <span class="sr-only">Filter updates</span>
      <i class="fa-solid fa-magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-ink-3"></i>
      <input
        bind:value={query}
        placeholder="package, repo, or branch"
        class="w-56 rounded-sm border border-line-strong bg-field py-1 pl-7 pr-2 text-[12px] text-ink placeholder:text-ink-3 focus:border-brass focus:outline-none"
      />
    </label>

    <div class="flex overflow-hidden rounded-sm border border-line-strong" role="group" aria-label="Filter by state">
      {#each filters as [id, label]}
        <button
          onclick={() => (only = id)}
          aria-pressed={only === id}
          class="border-r border-line-strong px-2.5 py-1 text-[11px] transition-colors last:border-r-0
                 {only === id ? 'bg-raised text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2'}"
        >{label}</button>
      {/each}
    </div>

    <div class="flex overflow-hidden rounded-sm border border-line-strong" role="group" aria-label="Group rows by">
      {#each [['repo', 'By repo'], ['change', 'By change']] as const as [id, label]}
        <button
          onclick={() => pivot.set(id)}
          aria-pressed={$pivot === id}
          class="border-r border-line-strong px-2.5 py-1 text-[11px] transition-colors last:border-r-0
                 {$pivot === id ? 'bg-brass/20 text-brass' : 'text-ink-3 hover:bg-hover hover:text-ink-2'}"
        >{label}</button>
      {/each}
    </div>

    <button
      onclick={toggleAll}
      class="ml-auto flex items-center gap-2 text-[11px] text-ink-3 transition-colors hover:text-ink"
    >
      <input type="checkbox" checked={allShown} tabindex="-1" class="pointer-events-none h-3.5 w-3.5 accent-[var(--brass)]" />
      {selected.size > 0 ? `${selected.size} selected` : `Select ${filtered.length} shown`}
    </button>
  </div>

  {#if $truncatedRepos.length > 0}
    <!-- Quiet, not a toast: the list stays partial for as long as the scope is this wide. -->
    <p class="border-b border-line bg-panel px-5 py-1.5 text-[11px] text-hold">
      {$truncatedRepos.length === 1 ? '1 repository has' : `${$truncatedRepos.length} repositories have`}
      more than 100 open pull requests — this list is partial.
    </p>
  {/if}

  {#if error}
    <EmptyState icon="fa-solid fa-triangle-exclamation" title={errorTitle} body={error} />
  {:else if !$dependabotLoaded}
    <div class="flex flex-1 items-center justify-center"><Spinner label="Reading the fleet…" /></div>
  {:else if $dependabotPRs.length === 0}
    <EmptyState
      icon="fa-solid fa-mug-hot"
      title="No open updates"
      body="Nothing to merge across the {$selectedRepos.length} repos in scope."
      action={{ label: 'Widen the scope', onclick: () => goTo('fleet') }}
    />
  {:else if filtered.length === 0}
    <EmptyState
      icon="fa-solid fa-filter"
      title="No updates match"
      body="Clear the filter or search for a different package."
      action={{ label: 'Clear filters', onclick: () => { query = ''; only = 'all' } }}
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#each groups as row (row.key)}
        <section class="border-b border-line">
          <div class="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-ground px-4 py-1.5">
            <h2 class="truncate text-[12px] text-ink">{row.label}</h2>
            <span class="engraved shrink-0">{pluralise(row.members.length, 'update')}</span>
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <span class="text-[11px] {row.ready.length ? 'text-go' : 'text-ink-3'}">{row.ready.length} ready</span>
              <button
                onclick={() => mergeThese(row.members)}
                disabled={row.ready.length === 0}
                class="rounded-sm border border-line-strong px-2 py-0.5 text-[11px] text-ink-2 transition-colors
                       hover:border-brass/60 hover:bg-brass/15 hover:text-brass
                       disabled:cursor-not-allowed disabled:border-line disabled:text-ink-3 disabled:hover:bg-transparent"
              >Merge {row.ready.length}</button>
              {#if $pivot === 'repo'}
                {@const repo = row.members[0]?.repo}
                <button
                  onclick={() => repo && openUrl(`https://github.com/${repo}/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot`)}
                  aria-label="Open {row.label} pull requests on GitHub"
                  class="text-[11px] text-ink-3 transition-colors hover:text-ink"
                ><i class="fa-solid fa-up-right-from-square"></i></button>
              {/if}
            </div>
          </div>
          {#each row.members as pr (pr.id)}
            <PrRow
              {pr}
              selected={selected.has(pr.id)}
              onToggle={(on) => toggle(pr.id, on)}
              onOpen={() => openUrl(pr.url)}
              showRepo={$pivot === 'change'}
              {lampWidth}
              onPoke={() => poke(pr)}
              poking={poking.has(pr.id)}
            />
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>
