<script lang="ts">
  import { get } from 'svelte/store'
  import { deleteHeadRef, enableAutoMerge, fetchHeadOids, mergePullRequest } from '../lib/graphql'
  import { prefs, toast } from '../lib/stores'
  import { bumpOf, isCleanStatusError, mergeInfo, pluralise } from '../lib/util'
  import Panel from './Panel.svelte'
  import Spinner from './Spinner.svelte'
  import type { MergeMethod, PullRequest } from '../lib/types'

  let { prs, onClose, onDone }: { prs: PullRequest[]; onClose: () => void; onDone: () => void } = $props()

  const saved = get(prefs)
  let method = $state<MergeMethod>(saved.defaultMerge)
  let deleteBranch = $state(saved.deleteBranch)
  let auto = $state(saved.autoMerge)
  let running = $state(false)
  let cancelling = $state(false)
  let results = $state<Record<string, { ok: boolean; msg: string }>>({})

  /** Drafts and closed PRs can't merge, so they never reach the queue. */
  const queue = $derived(prs.filter((p) => !['CLOSED', 'DRAFT'].includes(mergeInfo(p).state)))
  const succeeded = $derived(queue.filter((p) => results[p.id]?.ok).length)
  /** Anything not yet merged — the retry set after a partial run. */
  const outstanding = $derived(queue.filter((p) => !results[p.id]?.ok))
  const skipped = $derived(prs.length - queue.length)

  const strategies: { id: MergeMethod; label: string; hint: string }[] = [
    { id: 'SQUASH', label: 'Squash', hint: 'One commit per update' },
    { id: 'MERGE', label: 'Merge', hint: 'Keeps branch history' },
    { id: 'REBASE', label: 'Rebase', hint: 'Linear, no merge commit' },
  ]

  /**
   * GitHub's mutation errors arrive as sentences written for its own UI.
   * The recurring ones get translated into what to actually do; anything
   * unrecognised passes through verbatim rather than being flattened into
   * "merge failed".
   */
  const friendly = (msg: string): string => {
    if (/expected head|head branch was modified|oid/i.test(msg)) return 'branch moved since the sweep — retry uses the new commit'
    if (/not mergeable|merge commit cannot be cleanly created/i.test(msg)) return 'conflicts — needs a rebase first'
    if (/required status|protected branch|review is required|approving review/i.test(msg)) return 'blocked by branch protection'
    if (/auto.?merge is not allowed|auto merge is not enabled/i.test(msg)) return 'auto-merge is off in this repository'
    return msg
  }

  /** True once any pull request in the queue has been attempted. */
  const started = $derived(queue.some((p) => results[p.id]))

  /**
   * Work the outstanding set, so a retry after a partial failure never
   * re-attempts a pull request that already merged.
   *
   * ponytail: serial, to stay well inside GitHub's secondary rate limit for
   * mutations. Move to a small bounded pool if queues routinely exceed ~20.
   */
  const run = async () => {
    const targets = [...outstanding]
    if (!targets.length) return

    running = true
    cancelling = false
    prefs.update((p) => ({ ...p, defaultMerge: method, deleteBranch, autoMerge: auto }))

    // On a retry the sweep's head commits are minutes old — and if the first
    // attempt failed BECAUSE the branch moved, retrying with the same oid
    // fails identically forever. Re-read the heads; fall back to the sweep's
    // if the lookup itself fails.
    const oids = new Map(targets.flatMap((p) => (p.headRefOid ? [[p.id, p.headRefOid] as const] : [])))
    if (started) {
      try {
        for (const [id, oid] of await fetchHeadOids(targets.map((p) => p.id))) oids.set(id, oid)
      } catch {
        /* stale oids still protect against the wrong commit landing */
      }
    }

    /** Direct merge + optional branch deletion; sets the row's result. */
    const directMerge = async (pr: PullRequest) => {
      await mergePullRequest(pr.id, { method, expectedHeadOid: oids.get(pr.id) ?? null })
      if (deleteBranch) {
        // The merge landed, so a failed deletion must not put this PR in
        // the retry set — it is reported on the row instead.
        try {
          await deleteHeadRef(pr.id)
          results[pr.id] = { ok: true, msg: 'merged' }
        } catch {
          results[pr.id] = { ok: true, msg: 'merged — branch not deleted' }
        }
      } else {
        results[pr.id] = { ok: true, msg: 'merged' }
      }
    }

    for (const pr of targets) {
      if (cancelling) break
      try {
        // expectedHeadOid matters more on auto-merge, not less: it has the
        // widest window between the sweep and the commit that lands.
        if (auto) {
          // deleteBranch is not sent: the input type has no such field, and
          // GitHub deletes queued-merge branches only via the repo's own
          // auto-delete setting (see the toggle's hint).
          try {
            await enableAutoMerge(pr.id, { method, expectedHeadOid: oids.get(pr.id) ?? null })
            results[pr.id] = { ok: true, msg: 'queued' }
          } catch (e) {
            // GitHub refuses to queue a PR whose checks already pass. For
            // "merge when checks pass" that means: the checks passed — merge
            // it now. Reactive rather than pre-checked, so a sweep gone
            // stale in either direction still lands on the right path.
            if (!isCleanStatusError(e instanceof Error ? e.message : String(e))) throw e
            await directMerge(pr)
          }
        } else {
          await directMerge(pr)
        }
      } catch (e) {
        results[pr.id] = { ok: false, msg: friendly(e instanceof Error ? e.message : String(e)) }
      }
    }

    running = false
    const ok = queue.filter((p) => results[p.id]?.ok).length
    if (cancelling) {
      toast(`Stopped after ${pluralise(ok, 'pull request')}`, { kind: 'info' })
    } else if (ok === queue.length) {
      // An auto run can mix outcomes: already-clean PRs merge directly
      // instead of queueing, so count what actually happened.
      const queued = queue.filter((p) => results[p.id]?.msg === 'queued').length
      const verbPast = queued === 0 ? 'Merged' : queued === ok ? 'Queued' : 'Queued or merged'
      toast(`${verbPast} ${pluralise(ok, 'pull request')}`, { kind: 'success' })
      onDone()
    } else {
      toast(`${ok} of ${queue.length} went through — retry the rest below`, { kind: 'error', sticky: true })
    }
    cancelling = false
  }

  const close = () => {
    if (running) return
    // A partial run still changed state, so the board must refetch.
    if (succeeded > 0) onDone()
    else onClose()
  }

  const verb = $derived(auto ? 'Queue' : 'Merge')
  const anyFailed = $derived(queue.some((p) => results[p.id]?.ok === false))
  // Counts the outstanding set once anything has run: after a cancel the
  // label must offer the remainder, not re-promise the whole queue.
  const actionLabel = $derived(
    running
      ? 'Working…'
      : outstanding.length === 0
        ? `${succeeded} of ${queue.length} done`
        : started
          ? `${anyFailed ? 'Retry' : verb} ${outstanding.length}`
          : `${verb} ${queue.length}`,
  )
</script>

<Panel title="{verb} {pluralise(queue.length, 'pull request')}" onClose={close} wide>
  {#if skipped > 0}
    <p class="mb-4 font-sans text-[12px] text-ink-3">
      {pluralise(skipped, 'draft or closed pull request')} left out — they cannot merge.
    </p>
  {/if}

  <fieldset class="mb-4" disabled={running}>
    <legend class="engraved mb-2">Strategy</legend>
    <div class="grid grid-cols-3 gap-1.5">
      {#each strategies as s}
        <button
          onclick={() => (method = s.id)}
          aria-pressed={method === s.id}
          class="rounded-sm border px-2.5 py-2 text-left transition-colors
                 {method === s.id ? 'border-brass/60 bg-brass/10' : 'border-line-strong hover:bg-hover'}"
        >
          <span class="block text-[12px] {method === s.id ? 'text-brass' : 'text-ink'}">{s.label}</span>
          <span class="mt-0.5 block font-sans text-[11px] leading-snug text-ink-3">{s.hint}</span>
        </button>
      {/each}
    </div>
  </fieldset>

  <div class="mb-4 divide-y divide-line rounded-sm border border-line">
    {#each [
      { get: () => auto, set: (v: boolean) => (auto = v), label: 'Merge when checks pass', hint: 'Hands the merge to GitHub instead of waiting here' },
      { get: () => deleteBranch, set: (v: boolean) => (deleteBranch = v), label: 'Delete branch after merge', hint: auto ? 'Queued merges delete only if the repository auto-deletes head branches' : 'Keeps Dependabot branches from piling up' },
    ] as toggle}
      <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5">
        <input
          type="checkbox"
          checked={toggle.get()}
          disabled={running}
          onchange={(e) => toggle.set(e.currentTarget.checked)}
          class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--brass)]"
        />
        <span>
          <span class="block text-[12px] text-ink">{toggle.label}</span>
          <span class="block font-sans text-[11px] text-ink-3">{toggle.hint}</span>
        </span>
      </label>
    {/each}
  </div>

  <p class="engraved mb-2">Queue</p>
  <ul class="space-y-px">
    {#each queue as pr (pr.id)}
      {@const result = results[pr.id]}
      {@const bump = bumpOf(pr)}
      <li class="flex items-center gap-2.5 rounded-sm bg-field px-2.5 py-1.5">
        <span
          class="lamp shrink-0 {result ? (result.ok ? 'lamp-go' : 'lamp-stop') : running ? 'lamp-hold' : ''}"
          aria-hidden="true"
        ></span>
        <span class="min-w-0 flex-1 truncate text-[11px] text-ink-2">
          <span class="text-ink-3">{pr.repoShort}#{pr.number}</span>
          {bump ? `${bump.pkg} ${bump.to ?? ''}` : pr.title}
        </span>
        {#if result}
          <span class="shrink-0 text-[11px] {result.ok ? 'text-go' : 'text-stop'}">{result.msg}</span>
        {/if}
      </li>
    {:else}
      <li class="font-sans text-[13px] text-ink-3">Nothing in this selection can merge right now.</li>
    {/each}
  </ul>

  {#snippet footer()}
    {#if running}<Spinner label="Working through the queue…" />{/if}
    <button
      onclick={() => (running ? (cancelling = true) : close())}
      class="rounded-sm px-3 py-1.5 text-[11px] text-ink-3 transition-colors hover:text-ink"
    >{running ? 'Stop' : started ? 'Done' : 'Cancel'}</button>
    <button
      onclick={run}
      disabled={running || outstanding.length === 0}
      class="rounded-sm border border-brass/60 bg-brass/15 px-3 py-1.5 text-[11px] text-brass transition-colors hover:bg-brass/25 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {actionLabel}
    </button>
  {/snippet}
</Panel>
