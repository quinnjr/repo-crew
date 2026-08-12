<script lang="ts">
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { activeIssue, goTo, prefs, toast } from '../lib/stores'
  import { fetchIssueDetail, mergePullRequest, type IssueDetail } from '../lib/graphql'
  import { ago, checksInfo, mergeInfo, pluralise } from '../lib/util'
  import Header from '../components/Header.svelte'
  import Signal from '../components/Signal.svelte'
  import Spinner from '../components/Spinner.svelte'
  import EmptyState from '../components/EmptyState.svelte'
  import type { LinkedPullRequest, MergeMethod } from '../lib/types'

  /** GitHub's own wording for each strategy — "merge and merge" is not a phrase. */
  const MERGE_VERB: Record<MergeMethod, string> = {
    SQUASH: 'Squash and merge',
    MERGE: 'Create a merge commit',
    REBASE: 'Rebase and merge',
  }

  let issue = $state<IssueDetail | null>(null)
  let loading = $state(true)
  let error = $state('')
  let merging = $state<string | null>(null)

  const load = async (repo: string, number: number) => {
    loading = true
    error = ''
    issue = null
    try {
      issue = await fetchIssueDetail(repo, number)
      if (!issue) error = `${repo}#${number} was not found.`
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    const ref = $activeIssue
    if (ref) load(ref.repo, ref.number)
  })

  const linked = $derived(issue?.closedByPullRequestsReferences?.nodes ?? [])

  const merge = async (pr: LinkedPullRequest) => {
    const ref = $activeIssue
    if (!ref) return
    merging = pr.id
    try {
      await mergePullRequest(pr.id, { method: $prefs.defaultMerge, expectedHeadOid: pr.headRefOid ?? null })
      toast(`Merged ${ref.repo}#${pr.number}`, { kind: 'success' })
      await load(ref.repo, ref.number)
    } catch (e) {
      toast(`Could not merge #${pr.number}: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
        sticky: true,
      })
    } finally {
      merging = null
    }
  }
</script>

<Header
  title="Issue #{$activeIssue?.number ?? ''}"
  meta={$activeIssue?.repo ?? ''}
  actions={[
    { label: 'Back', icon: 'fa-arrow-left', kind: 'quiet', onclick: () => goTo('issues') },
    {
      label: 'GitHub',
      icon: 'fa-up-right-from-square',
      disabled: !issue,
      onclick: () => issue && openUrl(issue.url),
    },
  ]}
/>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if loading}
    <div class="flex h-40 items-center justify-center"><Spinner label="Loading issue…" /></div>
  {:else if error}
    <EmptyState
      icon="fa-solid fa-triangle-exclamation"
      title="Could not load the issue"
      body={error}
      action={$activeIssue
        ? { label: 'Try again', onclick: () => load($activeIssue!.repo, $activeIssue!.number) }
        : undefined}
    />
  {:else if issue}
    <article class="mx-auto max-w-3xl px-6 py-6">
      <div class="mb-1 flex flex-wrap items-center gap-3">
        <Signal
          signal={issue.state === 'OPEN' ? 'go' : 'idle'}
          text={issue.state.toLowerCase()}
        />
        <span class="text-[11px] text-ink-3">
          {issue.author?.login ?? 'unknown'} · {ago(issue.createdAt)} old ·
          {pluralise(issue.comments.totalCount, 'comment')}
        </span>
      </div>

      <h2 class="font-sans text-xl font-semibold leading-snug text-ink">{issue.title}</h2>

      {#if issue.labels?.nodes.length}
        <div class="mt-3 flex flex-wrap gap-1.5">
          {#each issue.labels.nodes as label}
            <span class="inline-flex items-center gap-1.5 rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-ink-3">
              {#if label.color}<span class="h-1.5 w-1.5 rounded-full" style:background="#{label.color}"></span>{/if}
              {label.name}
            </span>
          {/each}
        </div>
      {/if}

      {#if issue.assignees.nodes.length}
        <p class="mt-3 text-[11px] text-ink-3">
          Assigned to {issue.assignees.nodes.map((a) => a.login).join(', ')}
        </p>
      {/if}

      {#if issue.body}
        <div class="mt-5 whitespace-pre-wrap rounded-sm border border-line bg-panel p-4 font-sans text-[13px] leading-relaxed text-ink-2">
          {issue.body}
        </div>
      {/if}

      <h3 class="engraved mt-8 mb-2">Closing pull requests</h3>

      {#if linked.length === 0}
        <p class="rounded-sm border border-dashed border-line px-4 py-5 text-center font-sans text-[13px] text-ink-3">
          Nothing links to this issue yet. A pull request that says “closes #{issue.number}” shows up here,
          ready to merge without leaving the page.
        </p>
      {:else}
        <ul class="divide-y divide-line rounded-sm border border-line">
          {#each linked as pr (pr.id)}
            {@const merge_ = mergeInfo(pr)}
            {@const checks = checksInfo(pr)}
            <li class="flex flex-wrap items-center gap-3 px-4 py-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] text-ink">{pr.title}</p>
                <p class="mt-0.5 text-[11px] text-ink-3">
                  #{pr.number} · {pr.author?.login ?? 'unknown'} · {pr.headRefName} → {pr.baseRefName}
                </p>
              </div>
              <Signal signal={checks.signal} text={checks.text} />
              <Signal signal={merge_.signal} text={merge_.text} />
              <button
                onclick={() => merge(pr)}
                disabled={merge_.state !== 'READY' || merging !== null}
                title={merge_.state === 'READY'
                  ? MERGE_VERB[$prefs.defaultMerge]
                  : `Not ready: ${merge_.text}`}
                class="rounded-sm border border-brass/60 bg-brass/15 px-2.5 py-1 text-[11px] text-brass transition-colors hover:bg-brass/25 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-3"
              >{merging === pr.id ? 'Merging…' : 'Merge'}</button>
              <button
                onclick={() => openUrl(pr.url)}
                aria-label="Open pull request #{pr.number} on GitHub"
                class="text-[11px] text-ink-3 transition-colors hover:text-ink"
              ><i class="fa-solid fa-up-right-from-square"></i></button>
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-[11px] text-ink-3">Merging a linked pull request closes this issue on GitHub.</p>
      {/if}
    </article>
  {/if}
</div>
