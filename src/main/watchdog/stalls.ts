import { Session } from 'node:inspector'
import type { LogSink } from '../log/sink'

// The main process's event loop, watched from inside it. A beachball on a Mac
// is this loop failing to turn: one synchronous call (a file read, a
// spawnSync, a big JSON.stringify) holds the whole window for as long as it
// takes. Nothing here prevents that; this is the instrument that says, after
// the fact, how long the loop was held and which frames held it, so the
// cause is on the run log instead of in somebody's memory of a spinner.
//
// Two parts. The timer measures: a tick that should fire every `tickMs` and
// fires late by `thresholdMs` or more is a stall, and its lateness is the
// stall's length. The profiler attributes: V8's sampling profiler runs the
// whole time at a coarse interval, and when a stall is measured the profile
// is stopped, the samples inside the stall window are summed by frame, and
// the heaviest frames go on the log beside the duration. Sampling costs a few
// percent of one core; the profile is dropped and restarted every `rotateMs`
// so it never grows without bound.

export interface StallWatchdogOptions {
  readonly log: LogSink
  /** Where a stall's full `.cpuprofile` is written, for DevTools; none when absent. */
  readonly profileDir?: string
  /** Writes the profile file; injected so tests never touch a disk. */
  readonly writeProfile?: (path: string, body: string) => void
  /** A stall is a tick this late, milliseconds. Default 250. */
  readonly thresholdMs?: number
  /** Milliseconds between ticks. Default 50. */
  readonly tickMs?: number
  /** Milliseconds between profile restarts when nothing stalled. Default 120000. */
  readonly rotateMs?: number
  /** Profiler sampling interval, microseconds. Default 2000. */
  readonly samplingIntervalUs?: number
  /** The profiler, or none: without one a stall is measured but not attributed. */
  readonly profiler?: StallProfiler
  /** Injected clock and timers, for tests. */
  readonly now?: () => number
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface StallWatchdog {
  dispose(): void
}

/** The little of V8's `Profiler` domain this needs, through `node:inspector`. */
export interface StallProfiler {
  start(samplingIntervalUs: number): void
  /** Resolves with the profile since `start`, or undefined when there is none. */
  stop(): Promise<CpuProfile | undefined>
  dispose(): void
}

// The shape `Profiler.stop` returns, as far as this reads it.
export interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[]
  /** Microseconds. */
  readonly startTime: number
  readonly endTime: number
  readonly samples?: readonly number[]
  readonly timeDeltas?: readonly number[]
}

export interface CpuProfileNode {
  readonly id: number
  readonly callFrame: {
    readonly functionName: string
    readonly url: string
    readonly lineNumber: number
  }
  readonly children?: readonly number[]
}

/** One frame's share of a stall window, as written to the log. */
export interface StallFrame {
  readonly frame: string
  readonly ms: number
}

export function startStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
  const {
    log,
    thresholdMs = 250,
    tickMs = 50,
    rotateMs = 2 * 60 * 1000,
    samplingIntervalUs = 2000,
    profiler,
    now = () => performance.now(),
    setInterval: schedule = (fn, ms) => setInterval(fn, ms),
    clearInterval: unschedule = (handle) => clearInterval(handle as NodeJS.Timeout)
  } = options

  let expected = now() + tickMs
  let profiling = false
  let profileStartedAt = now()
  let attributing = false
  let disposed = false

  function startProfile(): void {
    if (profiler === undefined || disposed) return
    try {
      profiler.start(samplingIntervalUs)
      profiling = true
      profileStartedAt = now()
    } catch (cause) {
      profiling = false
      log.append({
        source: 'main',
        event: 'stall_profiler_failed',
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }

  async function takeProfile(): Promise<CpuProfile | undefined> {
    if (profiler === undefined || !profiling) return undefined
    profiling = false
    try {
      return await profiler.stop()
    } catch (cause) {
      log.append({
        source: 'main',
        event: 'stall_profiler_failed',
        message: cause instanceof Error ? cause.message : String(cause)
      })
      return undefined
    }
  }

  async function stalled(lateMs: number): Promise<void> {
    const ms = Math.round(lateMs)
    if (attributing) {
      log.append({ source: 'main', event: 'main_stalled', ms })
      return
    }
    attributing = true
    try {
      const profile = await takeProfile()
      if (profile === undefined) {
        log.append({ source: 'main', event: 'main_stalled', ms })
        return
      }
      const top = stallFrames(profile, ms)
      const stack = heaviestStack(profile, ms)
      let profilePath: string | undefined
      if (options.profileDir !== undefined && options.writeProfile !== undefined) {
        profilePath = `${options.profileDir}/stall-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`
        try {
          options.writeProfile(profilePath, JSON.stringify(profile))
        } catch {
          profilePath = undefined
        }
      }
      log.append({
        source: 'main',
        event: 'main_stalled',
        ms,
        top,
        stack,
        ...(profilePath === undefined ? {} : { profile: profilePath })
      })
    } finally {
      attributing = false
      startProfile()
    }
  }

  function tick(): void {
    const at = now()
    const late = at - expected
    expected = at + tickMs
    if (late >= thresholdMs) {
      void stalled(late)
      return
    }
    if (profiling && at - profileStartedAt >= rotateMs && !attributing) {
      // Nothing stalled: the samples so far say nothing worth keeping.
      void takeProfile().then(() => {
        startProfile()
      })
    }
  }

  startProfile()
  const handle = schedule(tick, tickMs)

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      unschedule(handle)
      profiler?.dispose()
    }
  }
}

/** Microsecond timestamps of every sample, from the profile's deltas. */
function sampleTimes(profile: CpuProfile): readonly number[] {
  const deltas = profile.timeDeltas ?? []
  const times: number[] = []
  let at = profile.startTime
  for (const delta of deltas) {
    at += delta
    times.push(at)
  }
  return times
}

/**
 * Self time per frame inside the last `stallMs` of the profile, heaviest first.
 * V8's sampler keeps ticking while the thread is inside a synchronous call, so
 * the frame that made the call is where the time lands.
 */
export function stallFrames(profile: CpuProfile, stallMs: number, limit = 6): StallFrame[] {
  const samples = profile.samples ?? []
  const times = sampleTimes(profile)
  const windowStart = profile.endTime - stallMs * 1000
  const byNode = new Map<number, CpuProfileNode>()
  for (const node of profile.nodes) byNode.set(node.id, node)

  const selfUs = new Map<string, number>()
  for (let index = 0; index < samples.length; index++) {
    const at = times[index]
    if (at === undefined || at < windowStart) continue
    const next = times[index + 1] ?? profile.endTime
    const node = byNode.get(samples[index] ?? -1)
    if (node === undefined) continue
    const key = frameName(node)
    selfUs.set(key, (selfUs.get(key) ?? 0) + Math.max(0, next - at))
  }

  return [...selfUs.entries()]
    .filter(([key]) => key !== '(idle)' && key !== '(root)')
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([frame, us]) => ({ frame, ms: Math.round(us / 1000) }))
}

/**
 * The call stack of the node that held the most samples in the window,
 * innermost first, as the frames a reader would grep for.
 */
export function heaviestStack(profile: CpuProfile, stallMs: number, limit = 12): string[] {
  const samples = profile.samples ?? []
  const times = sampleTimes(profile)
  const windowStart = profile.endTime - stallMs * 1000
  const byNode = new Map<number, CpuProfileNode>()
  const parent = new Map<number, number>()
  for (const node of profile.nodes) {
    byNode.set(node.id, node)
    for (const child of node.children ?? []) parent.set(child, node.id)
  }

  const count = new Map<number, number>()
  for (let index = 0; index < samples.length; index++) {
    const at = times[index]
    if (at === undefined || at < windowStart) continue
    const id = samples[index]
    if (id === undefined) continue
    const node = byNode.get(id)
    if (node === undefined) continue
    const name = frameName(node)
    if (name === '(idle)' || name === '(root)' || name === '(program)') continue
    count.set(id, (count.get(id) ?? 0) + 1)
  }

  let heaviest: number | undefined
  let most = 0
  for (const [id, n] of count) {
    if (n > most) {
      most = n
      heaviest = id
    }
  }
  if (heaviest === undefined) return []

  const stack: string[] = []
  let at: number | undefined = heaviest
  while (at !== undefined && stack.length < limit) {
    const node = byNode.get(at)
    if (node === undefined) break
    const name = frameName(node)
    if (name !== '(root)') stack.push(name)
    at = parent.get(at)
  }
  return stack
}

function frameName(node: CpuProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame
  const name = functionName === '' ? '(anonymous)' : functionName
  if (url === '') return name
  const file = url.replace(/^file:\/\//, '')
  return `${name} ${file}:${lineNumber + 1}`
}

/** The profiler over `node:inspector`, in-process: the main thread profiling itself. */
export function inspectorProfiler(): StallProfiler | undefined {
  const session = new Session()
  try {
    session.connect()
  } catch {
    // A runtime without an inspector measures stalls without attributing them.
    return undefined
  }

  function post<T = void>(method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      session.post(method, params ?? {}, (error, result) => {
        if (error) reject(error)
        else resolve(result as T)
      })
    })
  }

  let enabled = false

  return {
    start(samplingIntervalUs: number): void {
      // Fire-and-forget on purpose: the three posts queue in order on the
      // session, and a failure surfaces on the first `stop`.
      void (async () => {
        if (!enabled) {
          await post('Profiler.enable')
          enabled = true
        }
        await post('Profiler.setSamplingInterval', { interval: samplingIntervalUs })
        await post('Profiler.start')
      })()
    },
    async stop(): Promise<CpuProfile | undefined> {
      const { profile } = await post<{ profile: CpuProfile }>('Profiler.stop')
      return profile
    },
    dispose(): void {
      try {
        session.disconnect()
      } catch {
        // Already gone.
      }
    }
  }
}
