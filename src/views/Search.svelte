<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { gql } from '../lib/graphql'
  import { ago } from '../lib/util'
  import { toast } from '../lib/stores'
  import Header from '../components/Header.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import type { SearchHit } from '../lib/types'

  let query = $state('')
  let kind = $state<'all' | 'pr' | 'issue'>('all')
  let results = $state<SearchHit[]>([])
  let loading = $state(false)
  let searched = $state(false)
  let searchError = $state('')
  let issueCount = $state(0)

  /**
   * Monotonic request id. The debounce narrows the window but cannot close
   * it: two in-flight searches can resolve out of order, and without this
   * guard the older result set would land on top of the newer one.
   */
  let seq = 0

  const run = async (terms: string, type: typeof kind) => {
    const mine = ++seq
    loading = true
    try {
      const scoped = `${terms} is:open${type === 'pr' ? ' is:pr' : type === 'issue' ? ' -is:pr' : ''}`
      const { data } = await gql<{ search: { issueCount: number; nodes: SearchHit[] } }>(
        `query($q: String!) {
          search(first: 100, type: ISSUE, query: $q) {
            issueCount
            nodes {
              __typename
              ... on PullRequest {
                id number title url state updatedAt isDraft mergeable
                author { login } repository { nameWithOwner }
                labels(first: 5) { nodes { name color } }
              }
              ... on Issue {
                id number title url state updatedAt
                author { login } repository { nameWithOwner }
                labels(first: 5) { nodes { name color } }
                comments { totalCount }
              }
            }
          }
        }`,
        { q: scoped },
      )
      if (mine !== seq) return
      results = data?.search?.nodes ?? []
      issueCount = data?.search?.issueCount ?? 0
      searchError = ''
      searched = true
    } catch (e) {
      if (mine !== seq) return
      // Leaving the previous query's hits on screen under the new query text
      // would read as a result set, so the failure clears them outright.
      results = []
      issueCount = 0
      searchError = e instanceof Error ? e.message : String(e)
      searched = true
      toast(`Search failed: ${searchError}`, { kind: 'error' })
    } finally {
      if (mine === seq) loading = false
    }
  }

  // Debounced so a fast typist costs one request, not twelve.
  $effect(() => {
    const terms = query.trim()
    const type = kind
    if (terms.length < 2) {
      results = []
      issueCount = 0
      searchError = ''
      searched = false
      return
    }
    const timer = setTimeout(() => run(terms, type), 350)
    return () => clearTimeout(timer)
  })

  const filters = [
    ['all', 'Everything'],
    ['pr', 'Pull requests'],
    ['issue', 'Issues'],
  ] as const
</script>

<Header title="Search" meta="Open issues and pull requests across all of GitHub" />

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-5 py-2">
    <label class="relative min-w-0 flex-1">
      <span class="sr-only">Search GitHub</span>
      <i class="fa-solid fa-magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-ink-3"></i>
      <input
        bind:value={query}
        placeholder="org:acme lockfile, or repo:acme/api flaky test"
        class="w-full rounded-sm border border-line-strong bg-field py-1.5 pl-7 pr-2 text-[12px] text-ink placeholder:text-ink-3 focus:border-brass focus:outline-none"
      />
    </label>
    <div class="flex overflow-hidden rounded-sm border border-line-strong" role="group" aria-label="Result type">
      {#each filters as [id, label]}
        <button
          onclick={() => (kind = id)}
          aria-pressed={kind === id}
          class="border-r border-line-strong px-2.5 py-1 text-[11px] transition-colors last:border-r-0
                 {kind === id ? 'bg-raised text-ink' : 'text-ink-3 hover:bg-hover hover:text-ink-2'}"
        >{label}</button>
      {/each}
    </div>
  </div>

  {#if loading}
    <div class="flex flex-1 items-center justify-center"><Spinner label="Searching GitHub…" /></div>
  {:else if searchError}
    <EmptyState
      icon="fa-solid fa-triangle-exclamation"
      title="Search failed"
      body="GitHub did not answer the query: {searchError}"
    />
  {:else if searched && results.length === 0}
    <EmptyState
      icon="fa-solid fa-magnifying-glass"
      title="Nothing found"
      body="No open issue or pull request matches “{query}”."
    />
  {:else if results.length === 0}
    <EmptyState
      icon="fa-solid fa-keyboard"
      title="Search all of GitHub"
      body="GitHub search qualifiers work here — try org:, repo:, author:, or label:."
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#each results as hit (hit.id)}
        {@const isPR = hit.__typename === 'PullRequest'}
        <button
          onclick={() => openUrl(hit.url)}
          class="flex w-full items-center gap-3 border-b border-line/60 px-5 py-2 text-left transition-colors hover:bg-hover"
        >
          <i
            class="fa-solid {isPR ? 'fa-code-pull-request' : 'fa-circle-dot'} shrink-0 text-[10px] text-ink-3"
            aria-hidden="true"
          ></i>
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2">
              <span class="truncate text-[13px] text-ink">{hit.title}</span>
              {#if hit.isDraft}<span class="engraved shrink-0">draft</span>{/if}
            </span>
            <span class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
              <span class="text-ink-2">{hit.repository?.nameWithOwner}</span>
              <span>#{hit.number}</span>
              <span>{hit.author?.login ?? 'unknown'}</span>
              <span>{ago(hit.updatedAt)}</span>
            </span>
          </span>
          {#if hit.comments?.totalCount}
            <span class="shrink-0 text-[11px] text-ink-3">
              <i class="fa-regular fa-comment text-[10px]"></i>
              {hit.comments.totalCount}
            </span>
          {/if}
        </button>
      {/each}
      {#if issueCount > results.length}
        <p class="px-5 py-3 text-[11px] text-ink-3">
          Showing {results.length} of {issueCount} matches
        </p>
      {/if}
    </div>
  {/if}
</div>
