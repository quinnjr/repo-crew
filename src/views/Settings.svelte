<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { authenticated, prefs, theme, toast, viewer } from '../lib/stores'
  import { cancelSignIn, INSTALLATIONS_URL, installUrl, oauthConfig, signInWithGitHub, SignInCancelled, type OauthConfig } from '../lib/auth'
  import Header from '../components/Header.svelte'
  import LoginLink from '../components/LoginLink.svelte'
  import type { MergeMethod } from '../lib/types'
  import type { Theme } from '../lib/stores'


  let signingIn = $state(false)
  let loginUrl = $state('')
  let cfg = $state<OauthConfig>({ configured: true, slug: null })

  onMount(() => {
    oauthConfig()
      .then((c) => (cfg = c))
      .catch(() => {})
    return () => {
      if (signingIn) void cancelSignIn()
    }
  })

  // Re-running the browser flow replaces the stored credential — the way to
  // switch accounts or recover from a revoked authorization.
  const signIn = async () => {
    if (signingIn) return
    signingIn = true
    try {
      await signInWithGitHub((url) => (loginUrl = url))
      toast(`Signed in as ${$viewer?.login ?? 'GitHub user'}`, { kind: 'success' })
    } catch (e) {
      if (!(e instanceof SignInCancelled)) {
        toast(`Could not sign in: ${e instanceof Error ? e.message : e}`, { kind: 'error', sticky: true })
      }
    } finally {
      signingIn = false
      loginUrl = ''
    }
  }

  // If clearing the credential fails the UI must not keep claiming a working
  // connection, so the local state is dropped either way and the failure is
  // reported as "may still be stored" rather than swallowed.
  const disconnect = async () => {
    try {
      await invoke('clear_token')
      toast('Disconnected', { kind: 'info' })
    } catch (e) {
      toast(
        `Could not clear the stored credential, so it may still exist on this machine: ${e instanceof Error ? e.message : e}`,
        { kind: 'error', sticky: true },
      )
    } finally {
      viewer.set(null)
      authenticated.set(false)
    }
  }

  const themes: [Theme, string, string][] = [
    ['dark', 'fa-lightbulb', 'Work light'],
    ['light', 'fa-sun', 'Daylight'],
  ]
  const strategies: MergeMethod[] = ['SQUASH', 'MERGE', 'REBASE']
  const toggles: [keyof Pick<typeof $prefs, 'deleteBranch' | 'autoMerge'>, string, string][] = [
    ['deleteBranch', 'Delete branch after merge', 'Keeps Dependabot branches from piling up'],
    ['autoMerge', 'Merge when checks pass', 'Hands the merge to GitHub instead of waiting'],
  ]
</script>

<Header title="Settings" meta="Account, defaults, and appearance" />

<div class="min-h-0 flex-1 overflow-y-auto">
  <div class="mx-auto max-w-2xl space-y-px px-6 py-6">
    <section class="rounded-sm border border-line bg-panel p-5">
      <h2 class="engraved mb-3">Account</h2>
      {#if $viewer}
        <div class="flex items-center gap-3">
          {#if $viewer.avatarUrl}
            <img src={$viewer.avatarUrl} alt="" class="h-9 w-9 rounded-sm border border-line" />
          {/if}
          <div>
            <p class="text-[13px] text-ink">{$viewer.name || $viewer.login}</p>
            <p class="text-[11px] text-ink-3">{$viewer.login}</p>
          </div>
          <button
            onclick={disconnect}
            class="ml-auto rounded-sm border border-stop/40 px-2.5 py-1 text-[11px] text-stop transition-colors hover:bg-stop/10"
          >Disconnect</button>
        </div>
      {:else}
        <p class="font-sans text-[13px] text-ink-3">Not connected.</p>
      {/if}
      <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button
          onclick={signIn}
          disabled={signingIn || !cfg.configured}
          class="rounded-sm border border-brass/60 bg-brass/15 px-3 py-1.5 text-[11px] text-brass transition-colors hover:bg-brass/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <i class="fa-brands fa-github text-[11px]"></i>
          {signingIn ? 'Waiting for the browser…' : $viewer ? 'Sign in again' : 'Sign in with GitHub'}
        </button>
        {#if signingIn}
          <button
            onclick={() => void cancelSignIn()}
            class="rounded-sm px-3 py-1.5 text-[11px] text-ink-3 transition-colors hover:text-ink"
          >Cancel</button>
        {/if}
        {#if signingIn && loginUrl}
          <LoginLink url={loginUrl} />
        {/if}
        <button
          onclick={() => openUrl(cfg.slug ? installUrl(cfg.slug) : INSTALLATIONS_URL)}
          class="ml-auto rounded-sm border border-line-strong px-3 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <i class="fa-solid fa-up-right-from-square text-[10px]"></i> Manage app installation
        </button>
      </div>
      {#if !cfg.configured}
        <!-- The button above is disabled in an unconfigured build; without this
             the control is simply greyed out with no stated reason, while
             Welcome explains the same condition in prose. Wording is kept
             identical to Welcome's so the two screens agree. -->
        <p class="mt-3 font-sans text-[11px] leading-relaxed text-ink-3">
          This build has no sign-in credentials. It was compiled without
          <span class="font-mono text-ink-2">REPO_CREW_GH_CLIENT_ID</span> and
          <span class="font-mono text-ink-2">REPO_CREW_GH_CLIENT_SECRET</span>, so it cannot start the
          GitHub sign-in. Rebuild with both set.
        </p>
      {/if}
      <p class="mt-3 font-sans text-[11px] leading-relaxed text-ink-3">
        Sign-in happens in your browser; the resulting credential lives in your system keychain,
        is never written to disk in plain text, and is never sent anywhere except github.com and
        api.github.com. The app only sees repositories where it is installed.
      </p>
    </section>

    <section class="mt-4 rounded-sm border border-line bg-panel p-5">
      <h2 class="engraved mb-3">Merge defaults</h2>
      <div class="flex items-center justify-between py-1.5">
        <span class="text-[12px] text-ink-2">Strategy</span>
        <div class="flex overflow-hidden rounded-sm border border-line-strong">
          {#each strategies as s}
            <button
              onclick={() => ($prefs = { ...$prefs, defaultMerge: s })}
              aria-pressed={$prefs.defaultMerge === s}
              class="border-r border-line-strong px-2.5 py-1 text-[11px] transition-colors last:border-r-0
                     {$prefs.defaultMerge === s ? 'bg-brass/20 text-brass' : 'text-ink-3 hover:bg-hover hover:text-ink-2'}"
            >{s.toLowerCase()}</button>
          {/each}
        </div>
      </div>
      {#each toggles as [key, label, hint]}
        <label class="flex cursor-pointer items-center gap-3 border-t border-line py-2.5">
          <input
            type="checkbox"
            checked={$prefs[key]}
            onchange={(e) => ($prefs = { ...$prefs, [key]: e.currentTarget.checked })}
            class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--brass)]"
          />
          <span>
            <span class="block text-[12px] text-ink">{label}</span>
            <span class="block font-sans text-[11px] text-ink-3">{hint}</span>
          </span>
        </label>
      {/each}
    </section>

    <section class="mt-4 rounded-sm border border-line bg-panel p-5">
      <h2 class="engraved mb-3">Appearance</h2>
      <div class="flex items-center justify-between">
        <span class="text-[12px] text-ink-2">Panel light</span>
        <div class="flex overflow-hidden rounded-sm border border-line-strong">
          {#each themes as [value, icon, label]}
            <button
              onclick={() => theme.set(value)}
              aria-pressed={$theme === value}
              class="flex items-center gap-1.5 border-r border-line-strong px-2.5 py-1 text-[11px] transition-colors last:border-r-0
                     {$theme === value ? 'bg-brass/20 text-brass' : 'text-ink-3 hover:bg-hover hover:text-ink-2'}"
            >
              <i class="fa-solid {icon} text-[10px]"></i>{label}
            </button>
          {/each}
        </div>
      </div>
    </section>
  </div>
</div>
