import { fork } from 'node:child_process'
import { join } from 'node:path'
import type { HostChild, SpawnHost } from '../host/host'

// The workflow host as a test starts it: the same entry the app builds into
// a utility process, run by plain Node straight from source over its IPC
// channel. What the entry does is what is under test; only the process
// primitive differs, and the entry adapts to both.

export const HOST_ENTRY = join(__dirname, '..', 'host', 'entry.ts')

export const AUTHORING_MODULE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'resources',
  'workflow-lib',
  'workflow.ts'
)

export const forkHost: SpawnHost = (workflowFile, authoringModule): HostChild => {
  const child = fork(HOST_ENTRY, [workflowFile, authoringModule], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Node runs the TypeScript itself; the one warning it would print about
    // the repository's package.json having no "type" is not the host's news.
    execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']
  })
  return {
    postMessage(message) {
      if (child.connected) child.send(message as Parameters<typeof child.send>[0])
    },
    on(event: 'message' | 'exit', listener: (argument: never) => void) {
      if (event === 'message') child.on('message', listener as (message: unknown) => void)
      else child.on('exit', (code) => (listener as (code: number | null) => void)(code))
    },
    stderr: child.stderr,
    kill() {
      child.kill('SIGKILL')
    }
  }
}
