<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { authenticated, toast, viewer } from '../lib/stores'
  import { fetchViewer } from '../lib/graphql'
  import Spinner from '../components/Spinner.svelte'

  let token = $state('')
  let reveal = $state(false)
  let connecting = $state(false)

  // Vetted with GitHub before it is stored, so a typo'd paste never becomes
  // a saved credential the user has to hunt down and clear.
  const connect = async () => {
    const value = token.trim()
    if (!value) return
    connecting = true
    try {
      await invoke<string>('validate_token', { token: value })
      await invoke('set_token', { token: value })
      const me = await fetchViewer()
      if (!me) throw new Error('the token was accepted but returned no account')
      viewer.set(me)
      authenticated.set(true)
    } catch (e) {
      // Roll back so a half-connected state cannot survive: if the clear
      // itself fails, say so rather than claiming the token was discarded.
      const rolledBack = await invoke('clear_token').then(
        () => true,
        () => false,
      )
      const kept = rolledBack ? 'it was not kept' : 'and it could not be cleared — remove it in Settings'
      toast(`Could not connect, ${kept}: ${e instanceof Error ? e.message : e}`, {
        kind: 'error',
        sticky: true,
      })
    } finally {
      connecting = false
    }
  }
</script>

<div class="flex h-full items-center justify-center bg-ground p-8">
  <div class="w-full max-w-md">
    <!-- The wordmark is set in the display face; it is the only place it
         appears at size, and the panel behind it stays completely quiet. -->
    <div class="mb-8 flex items-center gap-3">
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-line-strong text-ink-2"
        aria-hidden="true"
      >
        <i class="fa-solid fa-tower-broadcast text-[13px]"></i>
      </span>
      <div>
        <h1 class="font-display text-[15px] font-semibold uppercase tracking-[0.16em] text-ink">Repo Crew</h1>
        <p class="mt-1 text-[11px] text-ink-3">One board for every repository you maintain</p>
      </div>
    </div>

    <div class="mb-6 divide-y divide-line rounded-sm border border-line bg-panel">
      <!-- Unlit lamps: the vocabulary is introduced here without any of these
           bullets claiming to report a machine state. -->
      {#each [['Sweep the fleet', 'Every open dependency update, grouped by repository or by the change itself.'], ['Merge a fan-out at once', 'One version bump open in nine repositories is one row and one action.'], ['See what is red', 'Check results render as a fixed strip, so a job failing everywhere reads as a column.']] as [title, body]}
        <div class="flex gap-3 px-4 py-3">
          <span class="lamp mt-1 shrink-0" aria-hidden="true"></span>
          <div>
            <p class="text-[12px] text-ink">{title}</p>
            <p class="mt-0.5 font-sans text-[11px] leading-relaxed text-ink-3">{body}</p>
          </div>
        </div>
      {/each}
    </div>

    <div class="rounded-sm border border-line bg-panel p-5">
      <label class="engraved mb-2 block" for="token">GitHub token</label>
      <div class="relative">
        <input
          id="token"
          bind:value={token}
          type={reveal ? 'text' : 'password'}
          placeholder="github_pat_… or ghp_…"
          onkeydown={(e) => e.key === 'Enter' && connect()}
          class="w-full rounded-sm border border-line-strong bg-field px-3 py-2.5 pr-10 text-[12px] text-ink placeholder:text-ink-3 focus:border-brass focus:outline-none"
        />
        <button
          onclick={() => (reveal = !reveal)}
          aria-label={reveal ? 'Hide token' : 'Show token'}
          class="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 transition-colors hover:text-ink"
        >
          <i class="fa-solid {reveal ? 'fa-eye-slash' : 'fa-eye'} text-[11px]"></i>
        </button>
      </div>

      <button
        onclick={connect}
        disabled={connecting || !token.trim()}
        class="mt-3 flex w-full items-center justify-center gap-2 rounded-sm border border-brass/60 bg-brass/15 py-2.5 text-[12px] text-brass transition-colors hover:bg-brass/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {#if connecting}<Spinner />{/if}
        {connecting ? 'Connecting…' : 'Connect'}
      </button>

      <p class="mt-3 font-sans text-[11px] leading-relaxed text-ink-3">
        A fine-grained token needs read and write on Issues and Pull requests; a classic token needs the
        <span class="font-mono text-ink-2">repo</span> scope.
        <button
          onclick={() => openUrl('https://github.com/settings/personal-access-tokens/new')}
          class="text-brass underline underline-offset-2 hover:text-brass-hi"
        >Create one on GitHub</button>.
      </p>
    </div>
  </div>
</div>
