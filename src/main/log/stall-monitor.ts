import type { LogSink } from './sink'

// The main process's event loop is the window's input pump: while a
// synchronous call holds it, the app beachballs and nothing here can say so.
// This monitor is the one thing that can, after the fact. A timer asks to be
// woken every `intervalMs`; how late it wakes is how long the loop was held.
// Anything past `thresholdMs` is written to the log as `main_stalled`, so the
// next freeze is a line to search for rather than a silence to infer from.

export interface StallMonitorOptions {
  readonly log: LogSink
  /** How often the loop is sampled. */
  readonly intervalMs?: number
  /** Lateness below this is scheduling jitter, not a stall. */
  readonly thresholdMs?: number
  /** Epoch milliseconds; injected so a test can move the clock without waiting. */
  readonly now?: () => number
  /** The timer, injected for the same reason. */
  readonly schedule?: (callback: () => void, ms: number) => () => void
}

export interface StallMonitor {
  stop(): void
}

export const DEFAULT_STALL_INTERVAL_MS = 500
export const DEFAULT_STALL_THRESHOLD_MS = 1000

export function startStallMonitor({
  log,
  intervalMs = DEFAULT_STALL_INTERVAL_MS,
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  now = Date.now,
  schedule = (callback, ms) => {
    const timer = setTimeout(callback, ms)
    // A diagnostic must never be what keeps the process alive at quit.
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}: StallMonitorOptions): StallMonitor {
  let cancel: (() => void) | undefined
  let stopped = false

  function arm(): void {
    if (stopped) return
    const expected = now() + intervalMs
    cancel = schedule(() => {
      const late = now() - expected
      if (late >= thresholdMs) {
        log.append({ source: 'main', event: 'main_stalled', stalledMs: late })
      }
      arm()
    }, intervalMs)
  }

  arm()
  return {
    stop() {
      stopped = true
      cancel?.()
    }
  }
}
