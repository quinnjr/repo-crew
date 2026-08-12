<script lang="ts">
  import { signalLamp, signalText } from '../lib/util'
  import type { Signal } from '../lib/types'

  /**
   * A status readout: one lamp, one word. Deliberately not a pill — pills stack
   * into visual noise once there are forty rows on screen, and the colour here
   * is carrying meaning that a border and background would only dilute.
   */
  let { signal, text }: { signal: Signal; text: string } = $props()
</script>

<span class="inline-flex shrink-0 items-center gap-1.5 text-[11px] {signalText[signal]}">
  <span class="{signalLamp[signal]} !h-2 !w-2 rounded-full"></span>
  {text}
</span>
