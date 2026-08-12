<script lang="ts">
  import { views, activeView, selectedRepos, goTo, theme, toggleTheme } from '../lib/stores'
  import { pluralise } from '../lib/util'
</script>

<!--
  A fixed rail rather than a resizable sidebar: the destination list never
  grows, so space spent on it is space taken from the ledger.
-->
<aside class="flex w-14 shrink-0 flex-col items-center border-r border-line bg-panel py-3 lg:w-44 lg:items-stretch">
  <div class="mb-5 flex items-center gap-2.5 px-0 lg:px-4">
    <span
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line-strong text-ink-2"
      aria-hidden="true"
    >
      <i class="fa-solid fa-tower-broadcast text-[11px]"></i>
    </span>
    <span class="hidden font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-ink lg:block">
      Repo&nbsp;Crew
    </span>
  </div>

  <nav class="flex flex-1 flex-col gap-0.5 px-1.5 lg:px-2" aria-label="Views">
    {#each views as view}
      {@const active = $activeView === view.id}
      <button
        onclick={() => goTo(view.id)}
        title={view.hint}
        aria-current={active ? 'page' : undefined}
        class="group relative flex items-center gap-3 rounded-sm py-2 pl-3 pr-2 text-left text-[12px] transition-colors
               {active ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}"
      >
        <!-- The brass keyline is the only place brass appears in the rail. -->
        <span
          class="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full transition-colors {active
            ? 'bg-brass'
            : 'bg-transparent'}"
        ></span>
        <i class="{view.icon} w-4 shrink-0 text-center text-[12px] {active ? 'text-brass' : 'text-ink-3'}"></i>
        <span class="hidden lg:block">{view.label}</span>
      </button>
    {/each}
  </nav>

  <div class="mt-3 flex flex-col gap-0.5 border-t border-line px-1.5 pt-3 lg:px-2">
    <button
      onclick={toggleTheme}
      title={$theme === 'dark' ? 'Switch to daylight' : 'Switch to work light'}
      class="flex items-center gap-3 rounded-sm py-2 pl-3 pr-2 text-left text-[12px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
    >
      <i class="fa-solid {$theme === 'dark' ? 'fa-sun' : 'fa-moon'} w-4 shrink-0 text-center text-[12px] text-ink-3"></i>
      <span class="hidden lg:block">{$theme === 'dark' ? 'Daylight' : 'Work light'}</span>
    </button>
    <button
      onclick={() => goTo('settings')}
      aria-current={$activeView === 'settings' ? 'page' : undefined}
      class="flex items-center gap-3 rounded-sm py-2 pl-3 pr-2 text-left text-[12px] transition-colors
             {$activeView === 'settings' ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}"
    >
      <i class="fa-solid fa-sliders w-4 shrink-0 text-center text-[12px] text-ink-3"></i>
      <span class="hidden lg:block">Settings</span>
    </button>

    <button
      onclick={() => goTo('fleet')}
      class="mt-2 hidden rounded-sm px-3 py-2 text-left transition-colors hover:bg-hover lg:block"
    >
      <span class="engraved block">In scope</span>
      <span class="mt-1 block text-[12px] text-ink">{pluralise($selectedRepos.length, 'repo')}</span>
    </button>
  </div>
</aside>
