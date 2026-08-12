<script lang="ts">
  import { toasts, dismiss } from '../lib/stores'
  import type { ToastKind } from '../lib/types'

  const icon: Record<ToastKind, string> = {
    success: 'fa-solid fa-circle-check text-go',
    error: 'fa-solid fa-triangle-exclamation text-stop',
    info: 'fa-solid fa-circle-info text-ink-3',
    spinner: 'fa-solid fa-arrows-rotate spin text-brass',
  }
</script>

<div class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-1.5">
  {#each $toasts as t (t.id)}
    <div
      class="settle pointer-events-auto flex items-start gap-2.5 rounded-sm border border-line-strong bg-raised px-3 py-2.5 shadow-lg shadow-black/30"
      role={t.kind === 'error' ? 'alert' : 'status'}
    >
      <i class="{icon[t.kind]} mt-0.5 text-[11px]" aria-hidden="true"></i>
      <p class="flex-1 font-sans text-[12px] leading-relaxed text-ink-2">{t.message}</p>
      <!-- Sticky toasts need this most: they are the ones that never expire. -->
      <button
        onclick={() => dismiss(t.id)}
        aria-label="Dismiss"
        class="text-ink-3 transition-colors hover:text-ink"
      >
        <i class="fa-solid fa-xmark text-[11px]"></i>
      </button>
    </div>
  {/each}
</div>
