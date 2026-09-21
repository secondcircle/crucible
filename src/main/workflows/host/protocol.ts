import type {
  NodeSpec,
  PlannedNode,
  ReviseOptions,
  RunContext
} from '../../../../resources/workflow-lib/workflow.ts'

// What crosses between the main process and a workflow host: one symmetric
// request/reply grammar over a message channel, and the plain-data shapes
// each side speaks in. Nothing here touches Electron or Node's process API,
// so the same module serves the host entry running under plain Node in a
// test and under utilityProcess in the app.

/**
 * What the engine answers a host with. Everything the authoring context has,
 * except `effect`: the work an effect wraps runs where the workflow's code
 * does, so the engine offers the two halves it can answer — what this run
 * already recorded, and what it has just produced — and `effectOver` below
 * makes `ctx.effect` out of them, in whichever process the file runs in.
 */
export interface EngineContext extends Omit<RunContext, 'effect'> {
  recordedEffect(id: string): Promise<RecordedEffect>
  recordEffect(id: string, value: unknown): Promise<void>
}

export type RecordedEffect = { readonly replayed: true; readonly value: unknown } | { readonly replayed: false }

/**
 * `ctx.effect` built over those two halves: ask, else produce and record.
 * The value is round-tripped through JSON before it is recorded and before
 * it is returned, so what a first run hands back is exactly what a resumed
 * one will.
 */
export function effectOver(engine: {
  recordedEffect(id: string): Promise<RecordedEffect>
  recordEffect(id: string, value: unknown): Promise<void>
}): RunContext['effect'] {
  return async <T>(id: string, produce: () => T | Promise<T>): Promise<T> => {
    const already = await engine.recordedEffect(id)
    if (already.replayed) return already.value as T
    // A produce that returns nothing records null: JSON has no undefined,
    // and a replay must hand back what the record holds.
    const kept = JSON.parse(JSON.stringify(await produce()) ?? 'null') as T
    await engine.recordEffect(id, kept)
    return kept
  }
}

/** What a workflow file declares, minus its functions: readable without running it. */
export interface WorkflowManifest {
  readonly description: string
  readonly inputs: Readonly<Record<string, string>>
  readonly commit?: boolean
  /** Whether the file declares `plan()`. */
  readonly plans: boolean
  /** Present when the file declares a schedule; `cron` only when it is text. */
  readonly schedule?: { readonly cron?: string; readonly checks: boolean }
}

/** A node spec as it crosses the wire: the `check` function becomes a flag. */
export type WireNodeSpec = Omit<NodeSpec, 'check'> & { readonly checks: boolean }

/** An error as it crosses the wire; rebuilt as an Error on the other side. */
export interface WireError {
  readonly message: string
  readonly stack?: string
}

export function toWireError(cause: unknown): WireError {
  if (cause instanceof Error) {
    return { message: cause.message, ...(cause.stack === undefined ? {} : { stack: cause.stack }) }
  }
  return { message: String(cause) }
}

export function fromWireError(wire: WireError): Error {
  const error = new Error(wire.message)
  // The far side's stack is the one that names the workflow file's line.
  if (wire.stack !== undefined) error.stack = wire.stack
  return error
}

/** Requests the main process makes of a host. */
export type HostRequests = {
  manifest: { params: Record<never, never>; result: WorkflowManifest }
  plan: { params: { inputs: Record<string, string> }; result: PlannedNode[] }
  scheduleCheck: { params: { workspacePath: string }; result: boolean }
  run: {
    params: { inputs: Record<string, string>; artifactDir: string; cwd: string }
    result: Record<string, unknown> | undefined
  }
  /** `spec.check(outputs, verdict)` of the node request named, run where the function lives. */
  check: {
    params: { nodeRequest: number; outputs: Record<string, string>; verdict?: unknown }
    result: string[]
  }
}

/** Requests a host makes of the main process: the run context, call by call. */
export type MainRequests = {
  // `nodeRequest` is the host's own number for the spec it sent, which is
  // what a `check` request coming back names.
  node: {
    params: { id: string; spec: WireNodeSpec; nodeRequest: number }
    result: { outputs: Record<string, string>; verdict: unknown; summary: string }
  }
  openNode: {
    params: { id: string; spec: WireNodeSpec; nodeRequest: number }
    result: {
      handle: number
      id: string
      result: { outputs: Record<string, string>; verdict: unknown; summary: string }
    }
  }
  revise: {
    params: { handle: number; message: string; opts?: ReviseOptions }
    result: {
      id: string
      result: { outputs: Record<string, string>; verdict: unknown; summary: string }
    }
  }
  close: { params: { handle: number }; result: undefined }
  ask: { params: { reason: string; artifacts?: Record<string, string> }; result: string }
  notify: { params: { reason: string; artifacts?: Record<string, string> }; result: undefined }
  // The two halves of `ctx.effect`, because the work itself runs where the
  // workflow's code lives: the host asks whether this run already recorded
  // the id, and posts what it produced when it did not.
  recordedEffect: { params: { id: string }; result: RecordedEffect }
  recordEffect: { params: { id: string; value: unknown }; result: undefined }
  derive: { params: { path: string; fromNodeId: string }; result: undefined }
  stage: { params: { workflow: string; inputs: Record<string, string> }; result: string }
}

// The constraint on either side's request table. Types here rather than
// interfaces, so a table satisfies the index signature without declaring one.
type Requests = { [kind: string]: { params: unknown; result: unknown } }

export type Message =
  | { readonly t: 'request'; readonly id: number; readonly kind: string; readonly params: unknown }
  | { readonly t: 'reply'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: 'reply'; readonly id: number; readonly ok: false; readonly error: WireError }

/** The little of a message channel either side needs. */
export interface Channel {
  post(message: Message): void
  onMessage(listener: (message: Message) => void): void
}

export type Handlers<Incoming extends Requests> = {
  readonly [Kind in keyof Incoming]: (
    params: Incoming[Kind]['params']
  ) => Incoming[Kind]['result'] | Promise<Incoming[Kind]['result']>
}

export interface Rpc<Outgoing extends Requests> {
  request<Kind extends keyof Outgoing & string>(
    kind: Kind,
    params: Outgoing[Kind]['params']
  ): Promise<Outgoing[Kind]['result']>
  /** Rejects everything still in flight; later requests reject at once. */
  fail(cause: Error): void
}

/**
 * Both ends of the wire are the same thing: a side that answers the other's
 * requests and makes its own. Ids are the requester's, so the two id spaces
 * never collide.
 */
export function createRpc<Outgoing extends Requests, Incoming extends Requests>(
  channel: Channel,
  handlers: Handlers<Incoming>
): Rpc<Outgoing> {
  let nextId = 1
  const pending = new Map<number, { resolve(value: unknown): void; reject(cause: Error): void }>()
  let failed: Error | undefined

  channel.onMessage((message) => {
    if (message.t === 'reply') {
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.value)
      else waiter.reject(fromWireError(message.error))
      return
    }
    const handler = (handlers as Record<string, (params: unknown) => unknown>)[message.kind]
    if (handler === undefined) {
      channel.post({
        t: 'reply',
        id: message.id,
        ok: false,
        error: { message: `no handler for "${message.kind}"` }
      })
      return
    }
    void Promise.resolve()
      .then(() => handler(message.params))
      .then(
        (value) => channel.post({ t: 'reply', id: message.id, ok: true, value }),
        (cause: unknown) =>
          channel.post({ t: 'reply', id: message.id, ok: false, error: toWireError(cause) })
      )
  })

  return {
    request(kind, params) {
      if (failed !== undefined) return Promise.reject(failed)
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        channel.post({ t: 'request', id, kind, params })
      })
    },
    fail(cause) {
      if (failed !== undefined) return
      failed = cause
      for (const waiter of pending.values()) waiter.reject(cause)
      pending.clear()
    }
  }
}
