import type { CommandInfo, CommandService, Expansion } from '../../../shared/commands/service'
import { commandsBridge } from '../bridge'

// The renderer's side of the command channel. It holds no state: the folders,
// the precedence and the expansion are all main's.

export function createCommandClient(): CommandService {
  const commands = commandsBridge()

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await commands.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    list: (workspacePath: string) => call<readonly CommandInfo[]>('list', workspacePath),
    expand: (workspacePath: string, draft: string) =>
      call<Expansion>('expand', workspacePath, draft)
  }
}
