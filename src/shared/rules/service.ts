// The seam the rules board, the rule marks and the run view's rules tab are
// driven through. It only reads: nothing here sends anything to a judge or an
// agent, toggles a mode or resets a count, so reading the board costs nothing.

import type { Unsubscribe } from '../agent/port'
import type { BoardScope, BoardWindow, FiringView, RulesBoard, RulesHealth } from './board'

// A notice that a workspace's ledger grew, or its rules changed. The
// renderer asks again for whatever it is showing.
export type RulesEvent = { readonly type: 'changed'; readonly workspacePath: string }

export type RulesListener = (event: RulesEvent) => void

export interface RulesService {
  /** The chip's facts; absent for a workspace with no `.crucible/rules/`. */
  health(workspacePath: string): Promise<RulesHealth | undefined>
  board(workspacePath: string, scope: BoardScope, window: BoardWindow): Promise<RulesBoard>
  /** Every firing in a session or a run, newest first: the marks and the rules tab. */
  firings(workspacePath: string, scope: BoardScope): Promise<readonly FiringView[]>
  /** Live-only: no replay, no backlog. */
  onEvent(listener: RulesListener): Unsubscribe
}
