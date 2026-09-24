import type { Unsubscribe } from '../../../shared/agent/port'
import type { BoardScope, BoardWindow, FiringView, RulesBoard, RulesHealth } from '../../../shared/rules/board'
import type { RulesListener, RulesService } from '../../../shared/rules/service'
import { rulesBridge } from '../bridge'

// The renderer's side of the rules channel. It holds no state: the ledger is
// the truth, and a change notice is the cue to ask again.

export function createRulesClient(): RulesService {
  const bridge = rulesBridge()
  const listeners = new Set<RulesListener>()

  bridge.onEvent((event) => {
    for (const listener of [...listeners]) listener(event)
  })

  async function call<T>(op: string, ...args: readonly unknown[]): Promise<T> {
    const result = await bridge.request({ op, args })
    if (!result.ok) throw new Error(result.message)
    return result.value as T
  }

  return {
    health: (workspacePath: string) => call<RulesHealth | undefined>('health', workspacePath),
    board: (workspacePath: string, scope: BoardScope, window: BoardWindow) =>
      call<RulesBoard>('board', workspacePath, scope, window),
    firings: (workspacePath: string, scope: BoardScope) =>
      call<readonly FiringView[]>('firings', workspacePath, scope),
    onEvent(listener: RulesListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
