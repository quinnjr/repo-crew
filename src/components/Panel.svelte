<script lang="ts">
  import type { Snippet } from 'svelte'
  import { focusTrap } from '../lib/focusTrap'
  import { isTopModal, popModal, pushModal } from '../lib/stores'

  let {
    title,
    onClose,
    wide = false,
    children,
    footer,
  }: {
    title: string
    onClose: () => void
    wide?: boolean
    children: Snippet
    footer?: Snippet
  } = $props()

  // Identity in the modal stack, so Escape only closes the topmost dialog
  // rather than collapsing the whole stack at once.
  const token = Symbol('panel')

  $effect(() => {
    pushModal(token)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopModal(token)) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      popModal(token)
    }
  })
</script>

<div class="fixed inset-0 z-40 flex items-start justify-center p-6 pt-[12vh]">
  <!-- A real button rather than a click handler on the backdrop, so dismissing
       by clicking away is reachable from the keyboard too. -->
  <button class="absolute inset-0 cursor-default bg-[var(--overlay)]" aria-label="Close {title}" onclick={onClose}
  ></button>
  <div
    use:focusTrap
    class="settle relative flex max-h-[76vh] w-full flex-col overflow-hidden rounded-sm border border-line-strong bg-panel shadow-2xl shadow-black/50 {wide
      ? 'max-w-2xl'
      : 'max-w-md'}"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
  >
    <div class="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
      <h2 class="font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">{title}</h2>
      <button onclick={onClose} aria-label="Close" class="text-ink-3 transition-colors hover:text-ink">
        <i class="fa-solid fa-xmark text-[12px]"></i>
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {@render children()}
    </div>
    {#if footer}
      <div class="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        {@render footer()}
      </div>
    {/if}
  </div>
</div>
