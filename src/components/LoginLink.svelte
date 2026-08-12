<script lang="ts">
  import { copyLoginLink } from '../lib/auth'

  /** The copy-pasteable authorize link shown while a sign-in waits on the browser. */
  let { url }: { url: string } = $props()

  let input = $state<HTMLInputElement | null>(null)
</script>

<div class="flex w-full min-w-0 items-center gap-2">
  <input
    bind:this={input}
    value={url}
    readonly
    onfocus={(e) => e.currentTarget.select()}
    aria-label="Sign-in link"
    class="min-w-0 flex-1 rounded-sm border border-line-strong bg-field px-2 py-1.5 font-mono text-[11px] text-ink-2 focus:border-brass focus:outline-none"
  />
  <button
    onclick={() => copyLoginLink(url, input)}
    class="shrink-0 rounded-sm border border-line-strong px-2.5 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
  ><i class="fa-regular fa-copy text-[10px]"></i> Copy</button>
</div>
