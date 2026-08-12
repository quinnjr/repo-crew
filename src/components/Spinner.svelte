<script lang="ts">
  let { label = '' }: { label?: string } = $props()
</script>

<span class="inline-flex items-center gap-2.5 text-ink-3" role="status">
  <!-- A rotating sector, matching the lamp vocabulary rather than a generic ring. -->
  <svg class="spin h-3.5 w-3.5" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25" />
    <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" fill="none" stroke="var(--brass)" stroke-width="1.5" stroke-linecap="round" />
  </svg>
  <!-- A bare spinner is often the only in-flight indicator on screen, so it
       still has to say something to a screen reader. -->
  {#if label}<span class="text-[12px]">{label}</span>{:else}<span class="sr-only">Working</span>{/if}
</span>
