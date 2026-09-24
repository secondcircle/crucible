import type { Unsubscribe } from '../agent/port'
import { firingsIn, indexLedger, rulesBoard, rulesHealth, type LedgerIndex } from './board'
import type { LedgerLine } from './ledger'
import type { RulesListener, RulesService } from './service'

// The rules service over any source of ledger lines: main's reads the file,
// the fake flavor's holds canned lines. The board's answers are computed the
// same way from both.

export interface LedgerSource {
  /** Absent for a workspace with no `.crucible/rules/`. */
  lines(workspacePath: string): Promise<readonly LedgerLine[] | undefined>
}

export interface LedgerRulesService extends RulesService {
  /** Tell every listener this workspace's ledger changed. */
  changed(workspacePath: string): void
}

export function createLedgerRulesService(source: LedgerSource, now: () => number = () => Date.now()): LedgerRulesService {
  const listeners = new Set<RulesListener>()

  async function index(workspacePath: string): Promise<LedgerIndex | undefined> {
    const lines = await source.lines(workspacePath)
    return lines === undefined ? undefined : indexLedger(lines)
  }

  return {
    async health(workspacePath) {
      const found = await index(workspacePath)
      return found === undefined ? undefined : rulesHealth(found)
    },
    async board(workspacePath, scope, window) {
      const found = (await index(workspacePath)) ?? indexLedger([])
      return rulesBoard(found, scope, window, now())
    },
    async firings(workspacePath, scope) {
      const found = await index(workspacePath)
      return found === undefined ? [] : firingsIn(found, scope)
    },
    onEvent(listener): Unsubscribe {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changed(workspacePath) {
      for (const listener of [...listeners]) listener({ type: 'changed', workspacePath })
    }
  }
}
