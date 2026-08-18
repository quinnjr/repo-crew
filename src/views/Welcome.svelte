<script lang="ts">
  import { onMount } from 'svelte'
  import { openUrl } from '@tauri-apps/plugin-opener'
  import { keychainError, toast } from '../lib/stores'
  import { bootstrapSession, cancelSignIn, INSTALLATIONS_URL, installUrl, oauthConfig, signInWithGitHub, SignInCancelled, type OauthConfig } from '../lib/auth'
  import Spinner from '../components/Spinner.svelte'
  import LoginLink from '../components/LoginLink.svelte'

  let signingIn = $state(false)
  let loginUrl = $state('')
  // Optimistic: assume a configured build until the backend says otherwise,
  // so the button does not flash in and out on every launch.
  let cfg = $state<OauthConfig>({ configured: true, slug: null })

  onMount(() => {
    oauthConfig()
      .then((c) => (cfg = c))
      .catch(() => {})
    return () => {
      // Leaving the screen abandons the flow — nothing else could report it.
      if (signingIn) void cancelSignIn()
    }
  })

  const signIn = async () => {
    // Re-entry guard: a duplicate click would start a second flow, silently
    // cancel the first, and strand its never-settling promise.
    if (signingIn) return
    signingIn = true
    try {
      await signInWithGitHub((url) => (loginUrl = url))
    } catch (e) {
      if (!(e instanceof SignInCancelled)) {
        toast(`Could not sign in: ${e instanceof Error ? e.message : e}`, { kind: 'error', sticky: true })
      }
    } finally {
      signingIn = false
      loginUrl = ''
    }
  }

  const cancel = () => {
    void cancelSignIn()
  }

  let retrying = $state(false)

  // A locked keyring is recoverable without restarting anything: unlock it, or
  // start gnome-keyring, then probe again. `bootstrapSession` re-derives every
  // auth store from the answer, so this is a real retry rather than a reload.
  const retry = async () => {
    if (retrying) return
    retrying = true
    try {
      await bootstrapSession()
    } finally {
      retrying = false
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
      {#if $keychainError}
        <!-- Named before the sign-in button, because sign-in cannot succeed:
             the flow ends by writing the credential to the keychain we already
             know we cannot reach. Sending the user through two browser round
             trips to discover that would be a lie of omission. -->
        <p class="font-sans text-[13px] leading-relaxed text-ink-2">
          Your keyring is not available — start gnome-keyring, KWallet, or KeePassXC and try again.
        </p>
        <p class="mt-2 font-sans text-[11px] leading-relaxed text-ink-3">
          Repo Crew keeps your GitHub credential in the system keychain and never writes it to disk,
          so it cannot sign you in until the keyring answers. The keyring reported:
          <span class="font-mono text-ink-2">{$keychainError}</span>
        </p>
        <button
          onclick={retry}
          disabled={retrying}
          class="mt-4 flex w-full items-center justify-center gap-2 rounded-sm border border-brass/60 bg-brass/15 py-2.5 text-[12px] text-brass transition-colors hover:bg-brass/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <i class="fa-solid fa-rotate-right text-[12px]"></i>
          Retry
        </button>
      {:else if !cfg.configured}
        <p class="font-sans text-[13px] leading-relaxed text-ink-2">
          This build has no sign-in credentials.
        </p>
        <p class="mt-2 font-sans text-[11px] leading-relaxed text-ink-3">
          It was compiled without <span class="font-mono text-ink-2">REPO_CREW_GH_CLIENT_ID</span> and
          <span class="font-mono text-ink-2">REPO_CREW_GH_CLIENT_SECRET</span>, so it cannot start the
          GitHub sign-in. Rebuild with both set.
        </p>
      {:else if signingIn}
        <div class="flex items-center gap-3">
          <Spinner label="Waiting for your browser…" />
          <button
            onclick={cancel}
            class="ml-auto rounded-sm px-3 py-1.5 text-[11px] text-ink-3 transition-colors hover:text-ink"
          >Cancel</button>
        </div>
        <p class="mt-3 font-sans text-[11px] leading-relaxed text-ink-3">
          Finish signing in with GitHub in the browser window that just opened. Organisation SSO
          happens there too, if your org requires it.
        </p>
        {#if loginUrl}
          <div class="mt-3 border-t border-line pt-3">
            <p class="engraved mb-2">Browser didn't open?</p>
            <LoginLink url={loginUrl} />
            <p class="mt-2 font-sans text-[11px] leading-relaxed text-ink-3">
              Paste it into any browser on this machine — the sign-in returns to this app through
              127.0.0.1.
            </p>
          </div>
        {/if}
      {:else}
        <button
          onclick={signIn}
          class="flex w-full items-center justify-center gap-2 rounded-sm border border-brass/60 bg-brass/15 py-2.5 text-[12px] text-brass transition-colors hover:bg-brass/25"
        >
          <i class="fa-brands fa-github text-[13px]"></i>
          Sign in with GitHub
        </button>
        <p class="mt-3 font-sans text-[11px] leading-relaxed text-ink-3">
          Opens github.com in your browser; the app never sees your password. It can only reach
          repositories where it is installed — <button
            onclick={() => openUrl(cfg.slug ? installUrl(cfg.slug) : INSTALLATIONS_URL)}
            class="text-brass underline underline-offset-2 hover:text-brass-hi"
          >install it on your account</button>.
        </p>
      {/if}
    </div>
  </div>
</div>
