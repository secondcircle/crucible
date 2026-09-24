import { fork } from 'node:child_process'
import { join } from 'node:path'
import type { HostChild } from '../../workflows/host/host'
import type { SpawnRuleHost } from '../host/host'

// The rule host as a test starts it: the entry the app builds into a utility
// process, run by plain Node straight from source over its IPC channel.

export const RULE_HOST_ENTRY = join(__dirname, '..', 'host', 'entry.ts')

export const forkRuleHost: SpawnRuleHost = (workspacePath, libDir): HostChild => {
  const child = fork(RULE_HOST_ENTRY, [workspacePath, libDir], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
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
