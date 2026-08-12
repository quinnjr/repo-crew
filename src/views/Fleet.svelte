<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { allRepos, allReposLoaded, goTo, selectedRepos, selectedRepoSet, toggleRepo, viewer, toast } from '../lib/stores'
  import { loadRepos } from '../lib/api'
  import { installUrl, oauthConfig } from '../lib/auth'
  import { ago, pluralise } from '../lib/util'
  import Header from '../components/Header.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'

  let query = $state('')
  let showArchived = $state(false)
  let loading = $state(false)
  let appSlug = $state<string | null>(null)

  $effect(() => {
    oauthConfig()
      .then((c) => (appSlug = c.slug))
      .catch(() => {})
  })

  const load = async (force: boolean) => {
    if (loading) return
    loading = true
    try {
      await loadRepos(force)
    } catch (e) {
      toast(`Could not load repositories: ${e instanceof Error ? e.message : e}`, { kind: 'error' })
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (!$viewer || $allReposLoaded) return
    load(false)
  })

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return $allRepos.filter((r) => {
      if (r.isArchived && !showArchived) return false
      if (!q) return true
      return `${r.nameWithOwner} ${r.description ?? ''}`.toLowerCase().includes(q)
    })
  })

  const allShown = $derived(filtered.length > 0 && filtered.every((r) => $selectedRepoSet.has(r.nameWithOwner)))

  const toggleAll = () => {
    const names = new Set($selectedRepos)
    for (const r of filtered) {
      if (allShown) names.delete(r.nameWithOwner)
      else names.add(r.nameWithOwner)
    }
    selectedRepos.set([...names])
  }
</script>

<Header
  title="Fleet"
  meta="Every other view acts on the repositories selected here"
  actions={[
    { label: allShown ? 'Deselect shown' : 'Select shown', icon: 'fa-check-double', onclick: toggleAll },
    { label: 'Refresh', icon: 'fa-rotate-right', onclick: () => load(true) },
  ]}
>
  {#snippet right()}
    <!-- A readout, not a control: brass would make it read as clickable next
         to the real buttons. -->
    <span class="rounded-sm border border-line-strong px-2.5 py-1 text-[11px] text-ink-2">
      {pluralise($selectedRepos.length, 'repo')} in scope
    </span>
  {/snippet}
</Header>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-5 py-2">
    <label class="relative">
      <span class="sr-only">Filter repositories</span>
      <i class="fa-solid fa-magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-ink-3"></i>
      <input
        bind:value={query}
        placeholder="name or description"
        class="w-64 rounded-sm border border-line-strong bg-field py-1 pl-7 pr-2 text-[12px] text-ink placeholder:text-ink-3 focus:border-brass focus:outline-none"
      />
    </label>
    <label class="flex cursor-pointer items-center gap-2 text-[11px] text-ink-3">
      <input type="checkbox" bind:checked={showArchived} class="h-3.5 w-3.5 cursor-pointer accent-[var(--brass)]" />
      Include archived
    </label>
    {#if $selectedRepos.length > 0}
      <button
        onclick={() => selectedRepos.set([])}
        class="ml-auto text-[11px] text-ink-3 transition-colors hover:text-stop"
      >Clear scope</button>
    {/if}
  </div>

  {#if loading && !$allReposLoaded}
    <div class="flex flex-1 items-center justify-center"><Spinner label="Listing repositories…" /></div>
  {:else if $allRepos.length === 0}
    <!-- The app only sees repositories where it is installed, so a fresh
         sign-in legitimately lands here — the install page is the way out. -->
    <EmptyState
      icon="fa-solid fa-layer-group"
      title="No repositories found"
      body="Repo Crew can only see repositories where the GitHub App is installed. Install it on your account or organisation, then refresh."
      action={appSlug
        ? { label: 'Install the app on GitHub', onclick: () => appSlug && openUrl(installUrl(appSlug)) }
        : { label: 'Open settings', onclick: () => goTo('settings') }}
    />
  {:else if filtered.length === 0}
    <EmptyState
      icon="fa-solid fa-filter"
      title="Nothing matches"
      body="No repository name or description contains “{query}”."
      action={{ label: 'Clear filter', onclick: () => (query = '') }}
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#each filtered as repo (repo.nameWithOwner)}
        {@const inScope = $selectedRepoSet.has(repo.nameWithOwner)}
        <label
          class="flex cursor-pointer items-center gap-3 border-b border-line/60 px-5 py-2 transition-colors hover:bg-hover"
        >
          <input
            type="checkbox"
            checked={inScope}
            onchange={() => toggleRepo(repo.nameWithOwner)}
            class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--brass)]"
          />
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2">
              <span class="truncate text-[13px] {inScope ? 'text-ink' : 'text-ink-2'}">{repo.nameWithOwner}</span>
              {#if repo.isPrivate}
                <i class="fa-solid fa-lock shrink-0 text-[9px] text-ink-3" title="Private"></i>
              {/if}
              {#if repo.isArchived}<span class="engraved shrink-0">archived</span>{/if}
            </span>
            {#if repo.description}
              <span class="mt-0.5 block truncate font-sans text-[11px] text-ink-3">{repo.description}</span>
            {/if}
          </span>
          <span class="hidden shrink-0 items-center gap-4 text-[11px] text-ink-3 sm:flex">
            {#if repo.primaryLanguage}<span>{repo.primaryLanguage.name}</span>{/if}
            <span class="w-10 text-right">{ago(repo.updatedAt)}</span>
          </span>
        </label>
      {/each}
      <p class="px-5 py-3 text-[11px] text-ink-3">
        {filtered.length} of {$allRepos.length} shown · scope is saved on this machine
      </p>
    </div>
  {/if}
</div>
