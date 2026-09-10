import type {
  NodeSpec,
  OpenNode,
  PlannedNode,
  RunContext,
  WorkflowDef
} from '../authoring'
import {
  createRpc,
  type HostRequests,
  type MainRequests,
  type Message,
  type WireNodeSpec,
  type WorkflowManifest
} from './protocol'

// The main process's side of a workflow host. The engine speaks to a
// workflow through this and nothing else, so a repository's code never runs
// on the thread that pumps the window: what runs here is the engine's own
// `RunContext`, answering the file's calls as they arrive over the wire.

export type { WorkflowManifest } from './protocol'

/** The little of a child process a host needs, in utilityProcess's own shape. */
export interface HostChild {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number | null) => void): void
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  kill(): void
}

/** Starts the host process for one workflow file. */
export type SpawnHost = (workflowFile: string, authoringModule: string) => HostChild

export interface WorkflowHost {
  manifest(): Promise<WorkflowManifest>
  plan(inputs: Record<string, string>): Promise<PlannedNode[]>
  scheduleCheck(workspacePath: string): Promise<boolean>
  /**
   * Runs the file's `run()` against the engine's context. Resolves with what
   * the workflow returned; rejects with what it threw, or with the host's
   * death if it died first.
   */
  run(ctx: RunContext): Promise<Record<string, unknown> | undefined>
  /** Stops the process where it stands. Everything in flight rejects. */
  kill(): void
}

/** How much of a dead host's stderr its epitaph carries. */
const STDERR_TAIL = 2000

export function createWorkflowHost(
  spawn: SpawnHost,
  workflowFile: string,
  authoringModule: string
): WorkflowHost {
  const child = spawn(workflowFile, authoringModule)
  let said = ''
  let gone = false

  child.stderr?.on('data', (chunk) => {
    said = `${said}${chunk.toString()}`.slice(-STDERR_TAIL)
  })

  // Only the context of a running `run()` can answer the file's requests;
  // before and after, a request from the host is a file misbehaving.
  let serving: RunContext | undefined
  const opened = new Map<number, OpenNode>()
  let nextHandle = 1

  const ctx = (): RunContext => {
    if (serving === undefined) throw new Error('the workflow made a ctx call outside run()')
    return serving
  }

  // The `check` the engine calls is the file's, reached back over the wire.
  const withCheck = (spec: WireNodeSpec, nodeRequest: number): NodeSpec => {
    const { checks, ...rest } = spec
    return checks
      ? { ...rest, check: (outputs) => rpc.request('check', { nodeRequest, outputs }) }
      : rest
  }

  const rpc = createRpc<HostRequests, MainRequests>(
    {
      post: (message) => {
        if (!gone) child.postMessage(message)
      },
      onMessage: (listener) => child.on('message', (message) => listener(message as Message))
    },
    {
      node: ({ id, spec, nodeRequest }) => ctx().node(id, withCheck(spec, nodeRequest)),
      openNode: async ({ id, spec, nodeRequest }) => {
        const node = await ctx().openNode(id, withCheck(spec, nodeRequest))
        const handle = nextHandle++
        opened.set(handle, node)
        return { handle, id: node.id, result: node.result }
      },
      revise: async ({ handle, message, opts }) => {
        const node = opened.get(handle)
        if (node === undefined) throw new Error(`revise on an unknown open node (${handle})`)
        const result = await node.revise(message, opts)
        return { id: node.id, result }
      },
      close: ({ handle }) => {
        opened.get(handle)?.close()
        opened.delete(handle)
        return undefined
      },
      ask: (question) => ctx().ask(question),
      derive: async ({ path, fromNodeId }) => {
        await ctx().derive(path, fromNodeId)
        return undefined
      },
      stage: (opts) => ctx().stage(opts)
    }
  )

  child.on('exit', (code) => {
    if (gone) return
    gone = true
    const tail = said.trim()
    rpc.fail(
      new Error(
        `the workflow host exited with code ${code ?? 'unknown'}` +
          (tail === '' ? '' : `\n${tail}`)
      )
    )
  })

  return {
    manifest: () => rpc.request('manifest', {}),
    plan: (inputs) => rpc.request('plan', { inputs }),
    scheduleCheck: (workspacePath) => rpc.request('scheduleCheck', { workspacePath }),
    async run(context) {
      if (serving !== undefined) throw new Error('a host runs one workflow once')
      serving = context
      try {
        return await rpc.request('run', {
          inputs: { ...context.inputs },
          artifactDir: context.artifactDir,
          cwd: context.cwd
        })
      } finally {
        serving = undefined
      }
    },
    kill() {
      if (gone) return
      gone = true
      rpc.fail(new Error('the workflow host was stopped'))
      child.kill()
    }
  }
}

/**
 * The same interface over a definition already in this process: what the
 * engine's tests run on. It cannot stop a file that blocks — that is exactly
 * what the real host exists for — so `kill()` only makes later calls refuse.
 */
export function inProcessHost(def: WorkflowDef): WorkflowHost {
  let killed = false
  const alive = (): void => {
    if (killed) throw new Error('the workflow host was stopped')
  }
  return {
    async manifest() {
      alive()
      return {
        description: def.description,
        inputs: { ...def.inputs },
        ...(def.commit === undefined ? {} : { commit: def.commit }),
        plans: typeof def.plan === 'function',
        ...(def.schedule === undefined
          ? {}
          : {
              schedule: {
                ...(typeof def.schedule.cron === 'string' ? { cron: def.schedule.cron } : {}),
                checks: typeof def.schedule.check === 'function'
              }
            })
      }
    },
    async plan(inputs) {
      alive()
      return def.plan?.(inputs) ?? []
    },
    async scheduleCheck(workspacePath) {
      alive()
      const check = def.schedule?.check
      return check === undefined ? true : Boolean(await check({ workspacePath }))
    },
    async run(ctx) {
      alive()
      const outputs = await def.run(ctx)
      return outputs === null || outputs === undefined ? undefined : outputs
    },
    kill() {
      killed = true
    }
  }
}
