import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFakeCommandService } from '../../shared/commands/fake-service'
import type { CommandService } from '../../shared/commands/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { shippedCommandsPath } from '../shipped'
import { createCommandService } from './service'

/** `~/.crucible/commands`, the user origin's folder. Never created here. */
export function userCommandsPath(home = homedir()): string {
  return join(home, '.crucible', 'commands')
}

// One flavor decision governs all seams, so a fake-flavor launch serves canned
// commands and reads no folder here either.
export function selectCommandService(
  flavor: Flavor,
  log: LogSink,
  appPath: string
): CommandService {
  log.append({ source: 'main', event: 'command_service_selected', service: flavor })

  if (flavor !== 'sdk') return createFakeCommandService()

  return createCommandService({
    roots: { builtIn: shippedCommandsPath(appPath), user: userCommandsPath() },
    onUnreadable: (path, cause) => {
      log.append({
        source: 'main',
        event: 'command_file_unreadable',
        path,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  })
}
