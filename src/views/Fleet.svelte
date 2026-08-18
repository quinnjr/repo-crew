<script lang="ts">
  import { onMount } from 'svelte'
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { allRepos, allReposLoaded, selectedRepos, selectedRepoSet, toggleRepo, viewer, toast } from '../lib/stores'
  import { loadRepos, noteRepoAutoMerge } from '../lib/api'
  import { setRepoAutoMerge } from '../lib/graphql'
  import { INSTALLATIONS_URL, installUrl, oauthConfig, type OauthConfig } from '../lib/auth'
  import { ago, pluralise } from '../lib/util'
  import Header from '../components/Header.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'


  let query = $state('')
  let showArchived = $state(false)
  let loading = $state(false)
  // Same shape and lifecycle as Welcome and Settings, so all three views read
  // the config one way. Optimistic until the backend answers.
  let cfg = $state<OauthConfig>({ configured: true, slug: null })
  /**
   * Why the list is empty, when it is empty because the fetch failed.
   *
   * Without this a rate limit or a 5xx fell through to the "app is not
   * installed" empty state — a confident wrong diagnosis, with the only
   * accurate explanation in a toast that had already faded.
   */
  let loadError = $state<string | null>(null)

  onMount(() => {
    oauthConfig()
      .then((c) => (cfg = c))
      // A failed probe is not fatal — the install links fall back to the
      // slug-independent installations page — but it must not be silent, or the
      // degraded wording below looks like the app's considered opinion.
      .catch((e: unknown) => toast(`Could not read the sign-in config: ${e instanceof Error ? e.message : e}`, { kind: 'error' }))
  })

  let attempted = false

  const load = async (force: boolean) => {
    if (loading) return
    // A manual attempt re-arms the effect's one-shot guard, so Refresh and
    // "Try again" keep working after an automatic attempt failed.
    if (force) attempted = true
    loading = true
    try {
      await loadRepos(force)
      loadError = null
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
      // The panel below only renders when there is no list to replace, so a
      // failed refresh over an existing list still needs the toast to report.
      toast(`Could not load repositories: ${loadError}`, { kind: 'error' })
    } finally {
      loading = false
    }
  }

  // Guarded by `attempted`, not by `loading`: `load` reads and writes `loading`
  // inside the effect, which Svelte treats as self-invalidation — so a failing
  // fetch (rate limit, 5xx) re-ran the effect on every `loading` flip and
  // hammered the API at network speed, while the panel below offered a "Try
  // again" button premised on the failure being terminal.
  $effect(() => {
    if (!$viewer || $allReposLoaded || attempted) return
    attempted = true
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

  /** Repos whose auto-merge PATCH is in flight, so the buttons can't double-fire. */
  let enabling = $state<Set<string>>(new Set())

  /** One PATCH; returns the failure message, or null on success. */
  const enableOne = async (name: string): Promise<string | null> => {
    enabling = new Set(enabling).add(name)
    try {
      await setRepoAutoMerge(name, true)
      noteRepoAutoMerge(name, true)
      return null
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      // GitHub's wording for "the App lacks a permission" names neither the
      // permission nor the fix; changing repo settings needs Administration.
      return raw.includes('Resource not accessible by integration')
        ? 'the GitHub App is missing the "Administration" repository permission. Grant it in the app’s settings on GitHub, approve the updated permissions on your installation, then retry.'
        : raw
    } finally {
      enabling = new Set([...enabling].filter((n) => n !== name))
    }
  }

  const enableRepoAutoMerge = async (name: string) => {
    if (enabling.has(name)) return
    const err = await enableOne(name)
    if (err) toast(`Could not enable auto-merge on ${name}: ${err}`, { kind: 'error', sticky: true })
    else toast(`Auto-merge enabled on ${name}`, { kind: 'success' })
  }

  /**
   * Every shown, live repo still lacking auto-merge — "select all" semantics
   * like the Select-shown action, independent of the scope checkboxes. The
   * filter box still narrows it, so a targeted bulk run stays possible.
   */
  const bulkTargets = $derived(filtered.filter((r) => !r.isArchived && !r.autoMergeAllowed))

  let bulkRunning = $state(false)

  /**
   * Serial, like the merge dialog's queue: repo-settings PATCHes are
   * mutations, and GitHub's secondary rate limit punishes concurrent ones.
   * Failures don't stop the run — the summary names what failed.
   */
  const enableBulk = async () => {
    if (bulkRunning) return
    const targets = bulkTargets.map((r) => r.nameWithOwner)
    if (!targets.length) return
    bulkRunning = true
    try {
      const failures: { name: string; err: string }[] = []
      for (const name of targets) {
        const err = await enableOne(name)
        if (err) failures.push({ name, err })
      }
      if (failures.length === 0) {
        toast(`Auto-merge enabled on ${pluralise(targets.length, 'repository', 'repositories')}`, {
          kind: 'success',
        })
      } else {
        const names = failures.map((f) => f.name).join(', ')
        toast(
          `${targets.length - failures.length} of ${targets.length} enabled — failed: ${names}. ${failures[0]!.err}`,
          { kind: 'error', sticky: true },
        )
      }
    } finally {
      bulkRunning = false
    }
  }

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
    {
      label: bulkRunning ? 'Enabling…' : `Enable auto-merge (${bulkTargets.length})`,
      icon: 'fa-code-merge',
      disabled: bulkRunning || bulkTargets.length === 0,
      onclick: enableBulk,
    },
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
  {:else if loadError && $allRepos.length === 0}
    <!-- Ordered before the install-app state so a failed fetch is never
         reported as a missing installation. Guarded on an empty list so a
         failed manual refresh does not wipe the repos already on screen. -->
    <EmptyState
      icon="fa-solid fa-triangle-exclamation"
      title="Could not load repositories"
      body={loadError}
      action={{ label: 'Try again', onclick: () => load(true) }}
    />
  {:else if $allRepos.length === 0}
    <!-- The app only sees repositories where it is installed, so a fresh
         sign-in legitimately lands here — the install page is the way out. -->
    <EmptyState
      icon="fa-solid fa-layer-group"
      title="No repositories found"
      body={cfg.slug
        ? 'Repo Crew can only see repositories where the GitHub App is installed. Install it on your account or organisation, then refresh.'
        : 'Repo Crew can only see repositories where the GitHub App is installed. This build could not look up the app’s own install page, so add it from your GitHub installations list, then refresh.'}
      action={cfg.slug
        ? { label: 'Install the app on GitHub', onclick: () => cfg.slug && openUrl(installUrl(cfg.slug)) }
        : { label: 'Open GitHub installations', onclick: () => openUrl(INSTALLATIONS_URL) }}
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
            {#if !repo.autoMergeAllowed && !repo.isArchived}
              <!-- preventDefault: the row is a <label>, and a plain click on
                   anything inside it would also toggle the scope checkbox. -->
              <button
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); enableRepoAutoMerge(repo.nameWithOwner) }}
                disabled={enabling.has(repo.nameWithOwner)}
                title="This repository does not allow auto-merge, so “Merge when checks pass” fails here. Turns on the repository setting."
                class="rounded-sm border border-line-strong px-2 py-0.5 text-[10px] transition-colors hover:border-brass/60 hover:text-brass disabled:cursor-not-allowed disabled:opacity-40"
              >{enabling.has(repo.nameWithOwner) ? 'Enabling…' : 'Enable auto-merge'}</button>
            {/if}
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
