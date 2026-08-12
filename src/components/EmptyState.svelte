<script lang="ts">
  /**
   * An empty screen is an invitation to act, so `action` is the point of this
   * component and `body` explains the state in plain terms rather than mood.
   */
  let {
    icon = 'fa-solid fa-inbox',
    title,
    body = '',
    action,
  }: {
    icon?: string
    title: string
    body?: string
    action?: { label: string; onclick: () => void }
  } = $props()
</script>

<div class="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center">
  <i class="{icon} mb-4 text-lg text-ink-3" aria-hidden="true"></i>
  <p class="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-ink">{title}</p>
  {#if body}
    <p class="mt-2 max-w-sm font-sans text-[13px] leading-relaxed text-ink-3">{body}</p>
  {/if}
  {#if action}
    <button
      onclick={action.onclick}
      class="mt-5 rounded-sm border border-brass/60 bg-brass/15 px-3 py-1.5 text-[11px] text-brass transition-colors hover:bg-brass/25"
    >
      {action.label}
    </button>
  {/if}
</div>
