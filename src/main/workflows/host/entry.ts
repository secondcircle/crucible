import { createJiti } from 'jiti'
import type {
  NodeResult,
  NodeSpec,
  OpenNode,
  RunContext,
  WorkflowDef
} from '../../../../resources/workflow-lib/workflow.ts'
import {
  createRpc,
  effectOver,
  type HostRequests,
  type MainRequests,
  type WireNodeSpec,
  type WorkflowManifest
} from './protocol.ts'
import { openParentChannel } from '../../host/parent-channel.ts'

// The workflow host: where a repository's workflow code runs. One process per
// workflow file, started by the main process, which stays the engine — every
// `ctx` call the file makes is a request back across the wire, and the file's
// own synchronous work holds only this process. Under Electron this is a
// utility process talking through `process.parentPort`; under plain Node, as
// the tests run it, the same script talks through Node's IPC channel.
//
// argv: <workflow file> <authoring module the file imports as crucible:workflow>

const [, , workflowFile, authoringModule] = process.argv
if (workflowFile === undefined || authoringModule === undefined) {
  process.stderr.write('workflow host: expected <workflow file> <authoring module>\n')
  process.exit(2)
}

const channel = openParentChannel('workflow host')

// Loaded once, on the first request that needs it, so a file that throws at
// import reports through the request that asked rather than by dying.
let definition: Promise<WorkflowDef> | undefined
function def(): Promise<WorkflowDef> {
  definition ??= load(workflowFile, authoringModule)
  return definition
}

/** Specs by the node request that carried them, for `check` calls coming back. */
const specs = new Map<number, NodeSpec>()
let nextNodeRequest = 1

const rpc = createRpc<MainRequests, HostRequests>(channel, {
  manifest: async () => manifestOf(await def()),

  plan: async ({ inputs }) => {
    const loaded = await def()
    return loaded.plan?.(inputs) ?? []
  },

  scheduleCheck: async ({ workspacePath }) => {
    const loaded = await def()
    const check = loaded.schedule?.check
    if (check === undefined) return true
    return Boolean(await check({ workspacePath }))
  },

  run: async ({ inputs, artifactDir, cwd }) => {
    const loaded = await def()
    const outputs = await loaded.run(runContext(inputs, artifactDir, cwd))
    return outputs === null || outputs === undefined ? undefined : outputs
  },

  check: async ({ nodeRequest, outputs, verdict }) => {
    const spec = specs.get(nodeRequest)
    if (spec?.check === undefined) {
      throw new Error(`check asked of a node request with no check (${nodeRequest})`)
    }
    return spec.check(outputs, verdict)
  }
})

/** The `ctx` a workflow's `run()` sees: every call a request to the engine. */
function runContext(
  inputs: Record<string, string>,
  artifactDir: string,
  cwd: string
): RunContext {
  const wire = (spec: NodeSpec): { nodeRequest: number; spec: WireNodeSpec } => {
    const nodeRequest = nextNodeRequest++
    specs.set(nodeRequest, spec)
    const { check, ...rest } = spec
    return { nodeRequest, spec: { ...rest, checks: check !== undefined } }
  }

  return {
    inputs,
    artifactDir,
    cwd,
    node: async (id, spec): Promise<NodeResult> => {
      const sent = wire(spec)
      return rpc.request('node', { id, spec: sent.spec, nodeRequest: sent.nodeRequest })
    },
    openNode: async (id, spec): Promise<OpenNode> => {
      const sent = wire(spec)
      const opened = await rpc.request('openNode', {
        id,
        spec: sent.spec,
        nodeRequest: sent.nodeRequest
      })
      let currentId = opened.id
      return {
        result: opened.result,
        get id() {
          return currentId
        },
        async revise(message, opts) {
          const revised = await rpc.request('revise', {
            handle: opened.handle,
            message,
            ...(opts === undefined ? {} : { opts })
          })
          currentId = revised.id
          return revised.result
        },
        close() {
          void rpc.request('close', { handle: opened.handle }).catch(() => {})
        }
      }
    },
    ask: (question) => rpc.request('ask', question),
    notify: async (message) => {
      await rpc.request('notify', message)
    },
    // Built here, so the workflow's own code is what runs inside an effect
    // and only its result crosses the wire.
    effect: effectOver({
      recordedEffect: (id) => rpc.request('recordedEffect', { id }),
      recordEffect: async (id, value) => {
        await rpc.request('recordEffect', { id, value })
      }
    }),
    derive: (path, fromNodeId) => rpc.request('derive', { path, fromNodeId }),
    stage: (opts) => rpc.request('stage', opts)
  }
}

function manifestOf(loaded: WorkflowDef): WorkflowManifest {
  const schedule = loaded.schedule
  return {
    description: loaded.description,
    inputs: { ...loaded.inputs },
    ...(loaded.commit === undefined ? {} : { commit: loaded.commit }),
    plans: typeof loaded.plan === 'function',
    ...(schedule === undefined || schedule === null
      ? {}
      : {
          schedule: {
            ...(typeof schedule.cron === 'string' ? { cron: schedule.cron } : {}),
            checks: typeof schedule.check === 'function'
          }
        })
  }
}

async function load(file: string, authoring: string): Promise<WorkflowDef> {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    interopDefault: true,
    alias: { 'crucible:workflow': authoring }
  })
  const loaded: unknown = await jiti.import(file, { default: true })
  return checkDef(file, loaded)
}

/** The floor a default export must meet before the engine will run it. */
function checkDef(file: string, loaded: unknown): WorkflowDef {
  const candidate = loaded as Partial<WorkflowDef> | null | undefined
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(`${file} does not default-export a workflow definition.`)
  }
  if (typeof candidate.description !== 'string' || candidate.description.trim() === '') {
    throw new Error(`The workflow at ${file} has no description.`)
  }
  if (typeof candidate.inputs !== 'object' || candidate.inputs === null) {
    throw new Error(`The workflow at ${file} declares no inputs record.`)
  }
  if (typeof candidate.run !== 'function') {
    throw new Error(`The workflow at ${file} has no run().`)
  }
  return candidate as WorkflowDef
}

// The host has nothing to say on its own: it lives as long as the channel
// does, and the far end's disconnect is its cue to leave.
process.on('disconnect', () => process.exit(0))
