<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { activeView, anyModalOpen, authenticated, mergeDialog, toast, viewer } from './lib/stores'
  import { fetchViewer } from './lib/graphql'
  import { refreshDependabot, refreshIssues } from './lib/api'
  import Rail from './components/Rail.svelte'
  import Toasts from './components/Toasts.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import MergeDialog from './components/MergeDialog.svelte'
  import Welcome from './views/Welcome.svelte'
  import Sweep from './views/Sweep.svelte'
  import Bumps from './views/Bumps.svelte'
  import Issues from './views/Issues.svelte'
  import IssueDetail from './views/IssueDetail.svelte'
  import Fleet from './views/Fleet.svelte'
  import Search from './views/Search.svelte'
  import Settings from './views/Settings.svelte'

  let paletteOpen = $state(false)

  const boot = async () => {
    // The backend answers whether a token exists; the secret itself never
    // enters the webview. An IPC fault is reported rather than being shown as
    // "no token", which would tell the user to paste one they already saved.
    let stored: boolean
    try {
      stored = await invoke<boolean>('has_token')
    } catch (e) {
      authenticated.set(false)
      toast(`Could not read the stored token: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
        sticky: true,
      })
      return
    }

    if (!stored) {
      authenticated.set(false)
      return
    }

    try {
      const me = await fetchViewer()
      // A null viewer with a stored token is a failure, not a signed-in state:
      // every view needs the login, and `loadRepos` would throw on it anyway.
      if (!me) throw new Error('GitHub returned no account for the stored token')
      viewer.set(me)
      authenticated.set(true)
    } catch (e) {
      authenticated.set(false)
      toast(`That token no longer works: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
        sticky: true,
      })
    }
  }

  onMount(() => {
    boot()
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      // Never stack the palette on top of an open dialog — one Escape would
      // then close both, and the merge dialog would refetch behind it.
      if ($anyModalOpen && !paletteOpen) return
      e.preventDefault()
      paletteOpen = !paletteOpen
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** Cancel is not a merge path: closing without merging changes nothing. */
  const closeMergeDialog = () => mergeDialog.set(null)

  /** A completed merge did change PR state, so the board is refetched. */
  const finishMergeDialog = () => {
    mergeDialog.set(null)
    const report = (e: unknown) =>
      toast(`Merged, but the board could not refresh: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
        sticky: true,
      })
    refreshDependabot().catch(report)
    refreshIssues().catch(report)
  }
</script>

<Toasts />

{#if $authenticated === null}
  <div class="flex h-screen items-center justify-center text-[12px] text-ink-3">Starting up…</div>
{:else if $authenticated === false}
  <Welcome />
{:else}
  <div class="flex h-screen overflow-hidden">
    <Rail />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      {#if $activeView === 'sweep'}
        <Sweep />
      {:else if $activeView === 'bumps'}
        <Bumps />
      {:else if $activeView === 'issues'}
        <Issues />
      {:else if $activeView === 'issue'}
        <IssueDetail />
      {:else if $activeView === 'fleet'}
        <Fleet />
      {:else if $activeView === 'search'}
        <Search />
      {:else if $activeView === 'settings'}
        <Settings />
      {/if}
    </main>
  </div>

  {#if paletteOpen}
    <CommandPalette onClose={() => (paletteOpen = false)} onMerge={(prs) => mergeDialog.set(prs)} />
  {/if}

  {#if $mergeDialog}
    <MergeDialog prs={$mergeDialog} onClose={closeMergeDialog} onDone={finishMergeDialog} />
  {/if}
{/if}
