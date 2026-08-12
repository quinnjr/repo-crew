<script lang="ts">
  import { ago } from '../lib/util'
  import type { Issue } from '../lib/types'

  let {
    issue,
    selected,
    onToggle,
    onOpen,
  }: {
    issue: Issue
    selected: boolean
    onToggle: (checked: boolean) => void
    onOpen: () => void
  } = $props()

  // The taxonomy is carried by the glyph alone; an issue type is not a machine
  // state, so every icon stays neutral.
  const typeIcon: Record<string, string> = {
    BUG: 'fa-solid fa-bug text-ink-3',
    SECURITY: 'fa-solid fa-shield-halved text-ink-3',
    ENHANCEMENT: 'fa-regular fa-lightbulb text-ink-3',
    EPIC: 'fa-solid fa-flag text-ink-3',
    DEPENDENCY: 'fa-solid fa-cube text-ink-3',
  }
  const icon = $derived(typeIcon[issue.issueType?.name ?? ''] ?? 'fa-regular fa-circle-dot text-ink-3')
</script>

<div class="group grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-line/60 px-4 py-2 last:border-b-0 hover:bg-hover">
  <input
    type="checkbox"
    checked={selected}
    onchange={(e) => onToggle(e.currentTarget.checked)}
    aria-label="Select {issue.repoShort} #{issue.number}"
    class="h-3.5 w-3.5 cursor-pointer accent-[var(--brass)]"
  />

  <button onclick={onOpen} class="min-w-0 text-left">
    <span class="flex items-baseline gap-2">
      <i class="{icon} shrink-0 text-[10px]" aria-hidden="true"></i>
      <span class="truncate text-[13px] text-ink">{issue.title}</span>
    </span>
    <span class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
      <span class="text-ink-2">{issue.repoShort}</span>
      <span>#{issue.number}</span>
      <span>{ago(issue.createdAt)} old</span>
      {#if issue.author}<span>{issue.author.login}</span>{/if}
      {#each issue.labels.slice(0, 3) as label}
        <span class="inline-flex items-center gap-1 text-ink-3">
          {#if label.color}
            <span class="h-1.5 w-1.5 rounded-full" style:background="#{label.color}"></span>
          {/if}
          {label.name}
        </span>
      {/each}
    </span>
  </button>

  <div class="flex shrink-0 items-center gap-3 text-[11px] text-ink-3">
    {#if issue.assignees.nodes.length}
      <span class="hidden sm:inline">{issue.assignees.nodes.map((a) => a.login).join(', ')}</span>
    {/if}
    {#if issue.comments.totalCount > 0}
      <span class="inline-flex items-center gap-1">
        <i class="fa-regular fa-comment text-[10px]" aria-hidden="true"></i>{issue.comments.totalCount}
      </span>
    {/if}
  </div>
</div>
