<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { issues, issuesLoaded, viewer, toast, goTo } from '../lib/stores'
  import { loadIssues, refreshIssues } from '../lib/api'
  import { addAssignees, addComment, addLabels, fetchLabels, setIssueState } from '../lib/graphql'
  import { pluralise, shortRepo } from '../lib/util'
  import Header from '../components/Header.svelte'
  import IssueRow from '../components/IssueRow.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import Panel from '../components/Panel.svelte'
  import type { Issue, Label } from '../lib/types'

  let query = $state('')
  let repoFilter = $state('all')
  let typeFilter = $state('all')
  let assigneeFilter = $state<'all' | 'me' | 'none'>('all')
  let selected = $state(new SvelteSet<string>())
  let working = $state(false)

  let labelPanel = $state<{ repo: string; labels: Label[] }[] | null>(null)
  let commentPanel = $state(false)
  let commentText = $state('')
  let loadError = $state('')
  let refreshing = $state(false)

  const tryLoad = () => {
    loadError = ''
    loadIssues().catch((e: unknown) => (loadError = e instanceof Error ? e.message : String(e)))
  }

  $effect(tryLoad)

  const repos = $derived([...new Set($issues.map((i) => i.repo))].sort())

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return $issues.filter((issue) => {
      if (repoFilter !== 'all' && issue.repo !== repoFilter) return false
      if (typeFilter !== 'all' && (issue.issueType?.name ?? 'NONE') !== typeFilter) return false
      const mine = issue.assignees.nodes.some((a) => a.login === $viewer?.login)
      if (assigneeFilter === 'me' && !mine) return false
      if (assigneeFilter === 'none' && issue.assignees.nodes.length > 0) return false
      if (!q) return true
      const labels = issue.labels.map((l) => l.name).join(' ')
      return `${issue.title} ${issue.repo} #${issue.number} ${labels}`.toLowerCase().includes(q)
    })
  })

  const chosen = $derived($issues.filter((i) => selected.has(i.id)))
  const allShown = $derived(filtered.length > 0 && filtered.every((i) => selected.has(i.id)))

  const toggleAll = () => {
    if (allShown) for (const i of filtered) selected.delete(i.id)
    else for (const i of filtered) selected.add(i.id)
  }

  /**
   * A mutation that lands without a refresh leaves the row contradicting its
   * own toast, so every bulk action re-reads the list afterwards.
   *
   * `keepSelection` exists for labelling: label IDs are per-repo, so a
   * multi-repo selection needs several passes through the picker. Clearing
   * after the first repo would strand the rest.
   */
  const finishBatch = async (mutated: boolean, keepSelection = false) => {
    if (!keepSelection) selected.clear()
    if (!mutated) return
    try {
      await refreshIssues()
    } catch (e) {
      toast(`Applied, but could not refresh the list: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
        sticky: true,
      })
    }
  }

  /**
   * Run one mutation per selected issue, reporting how many actually landed.
   * The targets are snapshotted first: `chosen` is derived off `$issues`, and a
   * refresh or a checkbox click during the awaits would otherwise make the
   * final tally compare against a list that is no longer the one we acted on.
   */
  const applyToChosen = async (verb: string, fn: (issue: Issue) => Promise<unknown>) => {
    const targets = [...chosen]
    working = true
    let done = 0
    let lastError = ''
    const failedIds: string[] = []
    for (const issue of targets) {
      try {
        await fn(issue)
        done++
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        failedIds.push(issue.id)
      }
    }
    working = false
    if (done === targets.length) {
      toast(`${verb} ${pluralise(done, 'issue')}`, { kind: 'success' })
      await finishBatch(done > 0)
    } else {
      toast(`${verb} ${done} of ${targets.length} — ${lastError}. The failed ones stay selected.`, {
        kind: 'error',
        sticky: true,
      })
      // Only the failures stay selected, so the next click retries exactly
      // the subset that did not land instead of re-running the successes.
      await finishBatch(done > 0, true)
      selected.clear()
      for (const id of failedIds) selected.add(id)
    }
  }

  /** Label sets rarely change mid-session; refetching them per picker open does not. */
  const labelCache = new Map<string, Label[]>()

  const openLabels = async () => {
    working = true
    const repos = [...new Set(chosen.map((i) => i.repo))]
    const failures: string[] = []
    const groups = await Promise.all(
      repos.map(async (repo) => {
        const cached = labelCache.get(repo)
        if (cached) return { repo, labels: cached }
        try {
          const labels = await fetchLabels(repo)
          labelCache.set(repo, labels)
          return { repo, labels }
        } catch {
          failures.push(repo)
          return null
        }
      }),
    )
    working = false
    if (failures.length) {
      toast(`Could not read labels for ${pluralise(failures.length, 'repository', 'repositories')}`, {
        kind: 'error',
      })
    }
    labelPanel = groups.filter((g) => g !== null)
  }

  /** Label IDs are per-repo, so this only touches the issues in that repo. */
  const applyLabel = async (repo: string, label: Label) => {
    const targets = chosen.filter((i) => i.repo === repo)
    labelPanel = null
    working = true
    let done = 0
    let lastError = ''
    for (const issue of targets) {
      try {
        await addLabels(issue.id, [label.id])
        done++
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    working = false
    if (done === targets.length) {
      toast(`Added ${label.name} to ${pluralise(done, 'issue')} in ${shortRepo(repo)}`, { kind: 'success' })
    } else {
      toast(`Labelled ${done} of ${targets.length} — ${lastError}`, { kind: 'error', sticky: true })
    }
    await finishBatch(done > 0, true)
  }

  const postComment = async () => {
    const body = commentText.trim()
    if (!body) return
    commentPanel = false
    commentText = ''
    await applyToChosen('Commented on', (issue) => addComment(issue.id, body))
  }

  const setClosed = async (closed: boolean) => {
    await applyToChosen(closed ? 'Closed' : 'Reopened', (issue) => setIssueState(issue.id, closed))
  }

  const types = [
    ['all', 'Any type'],
    ['BUG', 'Bug'],
    ['SECURITY', 'Security'],
    ['ENHANCEMENT', 'Enhancement'],
    ['EPIC', 'Epic'],
  ] as const
</script>

<Header
  title="Issues"
  meta="{pluralise($issues.length, 'open issue')} across {pluralise(repos.length, 'repo')}"
  actions={[
    {
      label: 'Refresh',
      icon: 'fa-rotate-right',
      // A refresh landing mid-mutation swaps the list out from under the
      // in-flight batch, so it stays shut until the batch finishes — and
      // until its own previous run settles, so a double-click is one fetch.
      disabled: working || refreshing,
      onclick: () => {
        refreshing = true
        selected.clear()
        loadError = ''
        refreshIssues()
          .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), { kind: 'error' }))
          .finally(() => (refreshing = false))
      },
    },
  ]}
/>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-5 py-2">
    <label class="relative">
      <span class="sr-only">Search issues</span>
      <i class="fa-solid fa-magnifying-glass pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-ink-3"></i>
      <input
        bind:value={query}
        placeholder="title, repo, or label"
        class="w-56 rounded-sm border border-line-strong bg-field py-1 pl-7 pr-2 text-[12px] text-ink placeholder:text-ink-3 focus:border-brass focus:outline-none"
      />
    </label>

    <select
      bind:value={repoFilter}
      aria-label="Filter by repository"
      class="rounded-sm border border-line-strong bg-field px-2 py-1 text-[12px] text-ink-2 focus:border-brass focus:outline-none"
    >
      <option value="all">All repos</option>
      {#each repos as repo}<option value={repo}>{shortRepo(repo)}</option>{/each}
    </select>

    <select
      bind:value={typeFilter}
      aria-label="Filter by issue type"
      class="rounded-sm border border-line-strong bg-field px-2 py-1 text-[12px] text-ink-2 focus:border-brass focus:outline-none"
    >
      {#each types as [id, label]}<option value={id}>{label}</option>{/each}
    </select>

    <select
      bind:value={assigneeFilter}
      aria-label="Filter by assignee"
      class="rounded-sm border border-line-strong bg-field px-2 py-1 text-[12px] text-ink-2 focus:border-brass focus:outline-none"
    >
      <option value="all">Anyone</option>
      <option value="me">Assigned to me</option>
      <option value="none">Unassigned</option>
    </select>

    <button
      onclick={toggleAll}
      class="ml-auto flex items-center gap-2 text-[11px] text-ink-3 transition-colors hover:text-ink"
    >
      <input type="checkbox" checked={allShown} tabindex="-1" class="pointer-events-none h-3.5 w-3.5 accent-[var(--brass)]" />
      {selected.size > 0 ? `${selected.size} selected` : `Select ${filtered.length} shown`}
    </button>
  </div>

  {#if loadError && !$issuesLoaded}
    <EmptyState
      icon="fa-solid fa-triangle-exclamation"
      title="Could not load issues"
      body={loadError}
      action={{ label: 'Try again', onclick: tryLoad }}
    />
  {:else if !$issuesLoaded}
    <div class="flex flex-1 items-center justify-center"><Spinner label="Reading issues…" /></div>
  {:else if $issues.length === 0}
    <EmptyState
      icon="fa-solid fa-mug-hot"
      title="No open issues"
      body="Nothing open across the repos in scope."
      action={{ label: 'Widen the scope', onclick: () => goTo('fleet') }}
    />
  {:else if filtered.length === 0}
    <EmptyState
      icon="fa-solid fa-filter"
      title="No issues match"
      body="Clear the filters to see all {$issues.length} open issues."
      action={{
        label: 'Clear filters',
        onclick: () => { query = ''; repoFilter = 'all'; typeFilter = 'all'; assigneeFilter = 'all' },
      }}
    />
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto pb-16">
      {#each filtered as issue (issue.id)}
        <IssueRow
          {issue}
          selected={selected.has(issue.id)}
          onToggle={(on) => (on ? selected.add(issue.id) : selected.delete(issue.id))}
          onOpen={() => goTo('issue', { repo: issue.repo, number: issue.number })}
        />
      {/each}
    </div>
  {/if}

  {#if chosen.length > 0}
    <!-- Bulk actions sit at the bottom edge, next to the selection they act on. -->
    <div
      class="settle fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-sm border border-line-strong bg-raised px-2 py-1.5 shadow-xl shadow-black/40"
      role="toolbar"
      aria-label="Actions for selected issues"
    >
      <span class="px-2 text-[11px] text-ink">{chosen.length} selected</span>
      <span class="mx-1 h-4 w-px bg-line"></span>
      <button
        onclick={() => $viewer && applyToChosen('Assigned you to', (i) => addAssignees(i.id, [$viewer!.id]))}
        disabled={working || !$viewer}
        class="rounded-sm px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
      >Assign me</button>
      <button
        onclick={openLabels}
        disabled={working}
        class="rounded-sm px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
      >Label</button>
      <button
        onclick={() => { commentText = ''; commentPanel = true }}
        disabled={working}
        class="rounded-sm px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
      >Comment</button>
      <button
        onclick={() => setClosed(false)}
        disabled={working}
        class="rounded-sm px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
      >Reopen</button>
      <button
        onclick={() => setClosed(true)}
        disabled={working}
        class="rounded-sm border border-stop/40 px-2 py-1 text-[11px] text-stop transition-colors hover:bg-stop/10 disabled:opacity-40"
      >Close</button>
      {#if working}<span class="pl-1"><Spinner /></span>{/if}
    </div>
  {/if}
</div>

{#if labelPanel}
  <Panel title="Add a label" onClose={() => (labelPanel = null)}>
    {#if labelPanel.length === 0}
      <p class="font-sans text-[13px] text-ink-3">No labels available in the selected repositories.</p>
    {/if}
    {#each labelPanel as group}
      <div class="mb-4 last:mb-0">
        <p class="engraved mb-2">{shortRepo(group.repo)}</p>
        <div class="flex flex-wrap gap-1.5">
          {#each group.labels as label}
            <button
              onclick={() => applyLabel(group.repo, label)}
              class="inline-flex items-center gap-1.5 rounded-sm border border-line-strong px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-brass/60 hover:text-ink"
            >
              {#if label.color}
                <span class="h-1.5 w-1.5 rounded-full" style:background="#{label.color}"></span>
              {/if}
              {label.name}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </Panel>
{/if}

{#if commentPanel}
  <Panel title="Comment on {pluralise(chosen.length, 'issue')}" onClose={() => (commentPanel = false)}>
    <textarea
      bind:value={commentText}
      rows="5"
      placeholder="The same comment is posted to every selected issue."
      class="w-full rounded-sm border border-line-strong bg-field p-2.5 font-sans text-[13px] text-ink placeholder:text-ink-3 focus:border-brass focus:outline-none"
    ></textarea>
    <div class="mt-3 flex justify-end">
      <button
        onclick={postComment}
        disabled={!commentText.trim()}
        class="rounded-sm border border-brass/60 bg-brass/15 px-3 py-1.5 text-[11px] text-brass transition-colors hover:bg-brass/25 disabled:cursor-not-allowed disabled:opacity-40"
      >Post comment</button>
    </div>
  </Panel>
{/if}
