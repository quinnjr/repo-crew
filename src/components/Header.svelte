<script lang="ts">
  import type { Snippet } from 'svelte'

  export type Action = {
    label: string
    icon?: string
    kind?: 'primary' | 'danger' | 'quiet'
    disabled?: boolean
    onclick: () => void
  }

  let {
    title,
    meta = '',
    actions = [],
    right,
  }: { title: string; meta?: string; actions?: Action[]; right?: Snippet } = $props()

  const style: Record<NonNullable<Action['kind']>, string> = {
    primary: 'border-brass/60 bg-brass/15 text-brass hover:bg-brass/25',
    danger: 'border-stop/40 text-stop hover:bg-stop/10',
    quiet: 'border-transparent text-ink-3 hover:text-ink',
  }
</script>

<header class="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel px-5">
  <div class="flex min-w-0 items-baseline gap-3">
    <h1 class="truncate font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-ink">
      {title}
    </h1>
    {#if meta}
      <p class="truncate text-[11px] text-ink-3">{meta}</p>
    {/if}
  </div>

  <div class="ml-auto flex shrink-0 items-center gap-1.5">
    {#if right}{@render right()}{/if}
    {#each actions as action}
      <button
        onclick={action.onclick}
        disabled={action.disabled}
        class="flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-35
               {action.kind ? style[action.kind] : 'border-line-strong text-ink-2 hover:bg-hover hover:text-ink'}"
      >
        {#if action.icon}<i class="fa-solid {action.icon} text-[10px]"></i>{/if}
        {action.label}
      </button>
    {/each}
  </div>
</header>
