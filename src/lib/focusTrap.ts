import type { Action } from 'svelte/action'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const focusableWithin = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )

/**
 * Make an element behave like the modal it claims to be.
 *
 * `aria-modal="true"` tells assistive tech the rest of the page is inert. If
 * Tab can still reach the page behind, that attribute is a lie — so this moves
 * focus in on mount, wraps Tab at both ends, and restores focus to whatever
 * opened the dialog on teardown.
 */
export const focusTrap: Action<HTMLElement> = (node) => {
  const previous = document.activeElement as HTMLElement | null

  const initial = focusableWithin(node)[0] ?? node
  // Defer so the element is laid out (offsetParent) before we measure it.
  const raf = requestAnimationFrame(() => initial.focus())

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const items = focusableWithin(node)
    if (items.length === 0) {
      e.preventDefault()
      node.focus()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement

    if (e.shiftKey && (active === first || active === node)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  node.addEventListener('keydown', onKeydown)

  return {
    destroy() {
      cancelAnimationFrame(raf)
      node.removeEventListener('keydown', onKeydown)
      previous?.focus()
    },
  }
}
