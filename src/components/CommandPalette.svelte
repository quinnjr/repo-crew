<script lang="ts">
  import {
    allRepos,
    dependabotPRs,
    goTo,
    isTopModal,
    pivot,
    popModal,
    pushModal,
    selectedRepos,
    toast,
    togglePivot,
    views,
  } from '../lib/stores'
  import { focusTrap } from '../lib/focusTrap'
  import { mergeInfo, pluralise } from '../lib/util'
  import type { PullRequest } from '../lib/types'

  let { onClose, onMerge }: { onClose: () => void; onMerge: (prs: PullRequest[]) => void } = $props()

  let query = $state('')
  let cursor = $state(0)

  const token = Symbol('palette')

  const ready = $derived($dependabotPRs.filter((p) => mergeInfo(p).state === 'READY'))

  type Command = { label: string; hint: string; icon: string; run: () => void }

  const commands = $derived.by<Command[]>(() => {
    const list: Command[] = views.map((v) => ({
      label: v.label,
      hint: v.hint,
      icon: v.icon,
      run: () => goTo(v.id),
    }))

    list.push({
      label: 'Merge every ready update',
      hint: ready.length ? pluralise(ready.length, 'pull request') : 'nothing ready',
      icon: 'fa-solid fa-check-double',
      run: () => {
        if (!ready.length) {
          toast('Nothing is ready to merge right now', { kind: 'info' })
          return
        }
        onMerge(ready)
      },
    })
    list.push({
      label: `Read the ledger by ${$pivot === 'repo' ? 'change' : 'repository'}`,
      hint: 'Transpose the sweep',
      icon: 'fa-solid fa-right-left',
      run: togglePivot,
    })
    list.push({
      label: 'Put every repository in scope',
      hint: pluralise($allRepos.length, 'repo'),
      icon: 'fa-solid fa-layer-group',
      run: () => selectedRepos.set($allRepos.map((r) => r.nameWithOwner)),
    })
    list.push({
      label: 'Settings',
      hint: 'Account, defaults, appearance',
      icon: 'fa-solid fa-sliders',
      run: () => goTo('settings'),
    })

    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(q))
  })

  // Clamped at the point of use rather than in an effect that writes the state
  // it reads — which would re-run the effect on every keystroke that filters.
  const active = $derived(Math.min(cursor, Math.max(0, commands.length - 1)))

  const select = (command: Command | undefined) => {
    if (!command) return
    onClose()
    command.run()
  }

  const onKey = (e: KeyboardEvent) => {
    if (!isTopModal(token)) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      cursor = Math.min(active + 1, commands.length - 1)
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      cursor = Math.max(active - 1, 0)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      select(commands[active])
    }
  }

  $effect(() => {
    pushModal(token)
    return () => popModal(token)
  })
</script>

<svelte:window onkeydown={onKey} />

<div class="fixed inset-0 z-50 flex items-start justify-center p-6 pt-[14vh]">
  <button class="absolute inset-0 cursor-default bg-[var(--overlay)]" aria-label="Close commands" onclick={onClose}
  ></button>
  <div
    use:focusTrap
    class="settle relative w-full max-w-lg overflow-hidden rounded-sm border border-line-strong bg-panel shadow-2xl shadow-black/50"
    role="dialog"
    aria-modal="true"
    aria-label="Commands"
    tabindex="-1"
  >
    <div class="flex items-center gap-3 border-b border-line px-4">
      <i class="fa-solid fa-angle-right text-[11px] text-brass" aria-hidden="true"></i>
      <input
        bind:value={query}
        aria-label="Search commands"
        aria-controls="palette-results"
        placeholder="Jump to a view or run a command"
        class="w-full bg-transparent py-3 text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
      />
      <kbd class="shrink-0 rounded-sm border border-line-strong px-1.5 py-0.5 text-[10px] text-ink-3">esc</kbd>
    </div>

    <ul id="palette-results" class="max-h-80 overflow-y-auto py-1">
      {#each commands as command, i (command.label)}
        <li>
          <button
            onclick={() => select(command)}
            onmouseenter={() => (cursor = i)}
            class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors {i === active
              ? 'bg-raised'
              : ''}"
          >
            <i class="{command.icon} w-4 shrink-0 text-center text-[11px] {i === active ? 'text-brass' : 'text-ink-3'}"></i>
            <span class="flex-1 truncate text-[12px] text-ink">{command.label}</span>
            <span class="shrink-0 text-[11px] text-ink-3">{command.hint}</span>
          </button>
        </li>
      {:else}
        <li class="px-4 py-6 text-center font-sans text-[12px] text-ink-3">No command matches “{query}”.</li>
      {/each}
    </ul>
  </div>
</div>
