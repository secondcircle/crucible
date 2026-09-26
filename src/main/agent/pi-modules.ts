import { Worker } from 'node:worker_threads'

// π's two packages are ESM, some fifteen hundred files between them, and an
// import reads every one of them synchronously on the thread that asks. Where
// opening a file is slow — a security scanner inspecting each open — that
// held the main thread, and the window with it, for up to twenty seconds at
// launch. So the first import runs in a worker thread, where the wait blocks
// nothing, and the main thread's own import follows it over files the machine
// has just opened. Every import of π in main goes through here.

type CodingAgent = typeof import('@earendil-works/pi-coding-agent')
type Ai = typeof import('@earendil-works/pi-ai')

export interface PiModules {
  codingAgent(): Promise<CodingAgent>
  ai(): Promise<Ai>
}

/** What a warm-up came to, for the run log. */
export type WarmOutcome =
  | { readonly outcome: 'warmed'; readonly ms: number }
  | { readonly outcome: 'failed'; readonly ms: number; readonly message: string }

export interface PiLoaderOptions {
  // Imports π once away from this thread. Absent, or failing, the imports
  // here go ahead unwarmed: a warm-up only ever makes π arrive sooner.
  readonly warm?: () => Promise<void>
  readonly onWarm?: (outcome: WarmOutcome) => void
  readonly importCodingAgent?: () => Promise<CodingAgent>
  readonly importAi?: () => Promise<Ai>
}

export function createPiLoader({
  warm,
  onWarm,
  importCodingAgent = () => import('@earendil-works/pi-coding-agent'),
  importAi = () => import('@earendil-works/pi-ai')
}: PiLoaderOptions = {}): PiModules {
  let warmed: Promise<void> | undefined
  let codingAgent: Promise<CodingAgent> | undefined
  let ai: Promise<Ai> | undefined

  function afterWarm(): Promise<void> {
    if (warm === undefined) return Promise.resolve()
    warmed ??= (async () => {
      const started = Date.now()
      try {
        await warm()
        onWarm?.({ outcome: 'warmed', ms: Date.now() - started })
      } catch (cause) {
        onWarm?.({
          outcome: 'failed',
          ms: Date.now() - started,
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    })()
    return warmed
  }

  return {
    codingAgent: () => (codingAgent ??= afterWarm().then(importCodingAgent)),
    ai: () => (ai ??= afterWarm().then(importAi))
  }
}

/** Past this, the main thread imports π whatever the worker is still doing. */
const WARM_TIMEOUT_MS = 90_000

// Resolves once the worker at `file` says it has imported π, and rejects when
// it fails, exits first or overruns. The worker is ended either way: it has
// done its whole job the moment the files are open.
export function warmInWorker(file: string, timeoutMs: number = WARM_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file)
    // A warm-up still going must never be what keeps the app from quitting.
    worker.unref()
    const timer = setTimeout(
      () => finish(new Error(`the warm-up took longer than ${timeoutMs} ms`)),
      timeoutMs
    )
    timer.unref?.()
    function finish(failure?: Error): void {
      clearTimeout(timer)
      worker.removeAllListeners()
      // Listened for, so a late error from a worker being torn down lands here
      // rather than as an uncaught one.
      worker.on('error', () => {})
      void worker.terminate()
      if (failure === undefined) resolve()
      else reject(failure)
    }
    worker.once('message', () => finish())
    worker.once('error', (cause) => finish(cause))
    worker.once('exit', (code) => finish(new Error(`the warm-up exited with code ${code}`)))
  })
}

// One per process, because the module cache it fills is one per process.
// Unwarmed until main names the worker file; plain Node — tests, `prove:sdk`
// — imports directly, as it always did.
let shared: PiModules = createPiLoader()

/** Called once at launch, before anything asks for π. */
export function warmPiIn(file: string, onWarm?: (outcome: WarmOutcome) => void): void {
  shared = createPiLoader({
    warm: () => warmInWorker(file),
    ...(onWarm === undefined ? {} : { onWarm })
  })
}

export const piModules: PiModules = {
  codingAgent: () => shared.codingAgent(),
  ai: () => shared.ai()
}
