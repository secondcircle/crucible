import type { CatalogRule } from '../../../shared/rules/ledger.ts'
import type { HostChild } from '../../workflows/host/host.ts'
import { createRpc, type Message, type Rpc } from '../../workflows/host/protocol.ts'
import type { EvaluateRequest, JudgeConfig, RuleEngine, RuleRun } from './engine.ts'
import type { RuleHostRequests, RuleMainRequests } from './protocol.ts'

// Main's side of a workspace's rule host. The process is started on the first
// question, kept for as long as the workspace is, and started afresh after it
// dies or stops answering, so one rule that hangs costs one timed-out event
// and never the agent's turn.

export interface RuleHost {
  configure(config: JudgeConfig): Promise<void>
  load(): Promise<readonly CatalogRule[]>
  evaluate(request: EvaluateRequest): Promise<readonly RuleRun[]>
  present(request: { rule: string; path: string; text: string }): Promise<readonly string[] | undefined>
  head(cwd: string): Promise<string | undefined>
  dispose(): void
}

/** Starts the host process for one workspace. */
export type SpawnRuleHost = (workspacePath: string, libDir: string) => HostChild

/** How long a question may go unanswered before the process is ended. */
export const HOST_TIMEOUT_MS = 30_000

const STDERR_TAIL = 2000

export function supervisedRuleHost({
  spawn,
  workspacePath,
  libDir,
  timeoutMs = HOST_TIMEOUT_MS,
  onDeath = () => {}
}: {
  readonly spawn: SpawnRuleHost
  readonly workspacePath: string
  readonly libDir: string
  readonly timeoutMs?: number
  /** The process went away on its own, with what it last wrote to stderr. */
  readonly onDeath?: (message: string) => void
}): RuleHost {
  interface Live {
    readonly child: HostChild
    readonly rpc: Rpc<RuleHostRequests>
    gone: boolean
  }
  let live: Live | undefined
  let config: JudgeConfig | undefined
  let disposed = false

  function start(): Live {
    const child = spawn(workspacePath, libDir)
    let said = ''
    child.stderr?.on('data', (chunk) => {
      said = `${said}${chunk.toString()}`.slice(-STDERR_TAIL)
    })
    const rpc = createRpc<RuleHostRequests, RuleMainRequests>(
      {
        post: (message) => {
          if (!started.gone) child.postMessage(message)
        },
        onMessage: (listener) => child.on('message', (message) => listener(message as Message))
      },
      {}
    )
    const started: Live = { child, rpc, gone: false }
    child.on('exit', (code) => {
      if (started.gone) return
      started.gone = true
      if (live === started) live = undefined
      const tail = said.trim()
      const message = `the rule host exited with code ${code ?? 'unknown'}${tail === '' ? '' : `\n${tail}`}`
      rpc.fail(new Error(message))
      if (!disposed) onDeath(message)
    })
    return started
  }

  function end(target: Live, why: string): void {
    if (target.gone) return
    target.gone = true
    if (live === target) live = undefined
    target.rpc.fail(new Error(why))
    target.child.kill()
  }

  async function ask<Kind extends keyof RuleHostRequests & string>(
    kind: Kind,
    params: RuleHostRequests[Kind]['params']
  ): Promise<RuleHostRequests[Kind]['result']> {
    if (disposed) throw new Error('the rule host was stopped')
    let target = live
    if (target === undefined) {
      target = start()
      live = target
      if (config !== undefined && kind !== 'configure') await target.rpc.request('configure', config)
    }
    const running = target
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        end(running, 'the rule host stopped answering and was ended')
        reject(new Error('the rule host stopped answering and was ended'))
      }, timeoutMs)
    })
    try {
      return await Promise.race([running.rpc.request(kind, params), late])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async configure(next) {
      config = next
      await ask('configure', next)
    },
    load: () => ask('load', {}),
    evaluate: (request) => ask('evaluate', request),
    present: (request) => ask('present', request),
    head: (cwd) => ask('head', { cwd }),
    dispose() {
      disposed = true
      if (live !== undefined) end(live, 'the rule host was stopped')
    }
  }
}

/** The same interface over an engine in this process: what the gate's tests run on. */
export function inProcessRuleHost(engine: RuleEngine): RuleHost {
  return {
    async configure(config) {
      engine.configure(config)
    },
    load: () => engine.load(),
    evaluate: (request) => engine.evaluate(request),
    present: (request) => engine.present(request),
    head: async (cwd) => engine.head(cwd),
    dispose() {}
  }
}
