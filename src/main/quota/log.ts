// A shrinking row has to be diagnosable without an hour-long outage filling
// the log, so each distinct message is delivered once per process.

const seen = new Set<string>()

// The gate runs before the sink, so injecting a sink cannot turn one
// diagnostic into one per parse.
export function onceIn(scope: string, sink?: (message: string) => void): (message: string) => void {
  return (message: string) => {
    const key = `${scope}\u0000${message}`
    if (seen.has(key)) return
    seen.add(key)
    if (sink) sink(message)
    else console.warn(`[quota:${scope}] ${message}`)
  }
}

/** A fresh process's memory, without a fresh process. */
export function forgetOnceIn(): void {
  seen.clear()
}
