/**
 * Diagnostics for a surface that degrades by disappearing.
 *
 * A shrinking row must be diagnosable, but a provider that has been down for an
 * hour must not fill the log: every message here is delivered at most once per
 * process per distinct text. Fetch and parse *state transitions* are logged by
 * the store, which is the only thing that knows a provider recovered.
 */

const seen = new Set<string>()

/**
 * A once-per-process sink for one scope.
 *
 * The suppression belongs to the process, not to the sink: "say it once per
 * process" has to hold however the message is delivered, or injecting a sink
 * (which the store does) would turn one diagnostic into one per parse, forever,
 * on a provider whose payload never changes. So the gate runs first and the
 * sink — injected or default — is only reached the first time.
 */
export function onceIn(scope: string, sink?: (message: string) => void): (message: string) => void {
  return (message: string) => {
    const key = `${scope}\u0000${message}`
    if (seen.has(key)) return
    seen.add(key)
    if (sink) sink(message)
    else console.warn(`[quota:${scope}] ${message}`)
  }
}

/** Test seam: a fresh process's memory, without a fresh process. */
export function forgetOnceIn(): void {
  seen.clear()
}
