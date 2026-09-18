import type { TranscriptItem } from '../../../shared/agent/port'
import {
  isContinuedNodeMessage,
  nodeStop,
  stoppedNodes,
  type RunNode,
  type RunRecord
} from '../../../shared/workflows/run'
import type { ViewItem } from '../state/shell-state'
import { since, toViewItem } from './format'

// Where one node's transcript was cut and where it was joined again, drawn
// into the transcript itself. Both seams are read from what is already on the
// record: the stop from that node's own record, the pick-up from the message
// Crucible sends a node whose session it reopened. Nothing here invents a time
// it was not given — a node resumed twice has two rules and neither claims an
// instant.

/**
 * One node's transcript as the run view shows it, with a rule where a resume
 * picked the node up again and a closing rule where the node stopped.
 */
export function transcriptWithSeams(
  run: RunRecord,
  node: RunNode,
  items: readonly TranscriptItem[],
  now = Date.now()
): readonly ViewItem[] {
  const shown: ViewItem[] = []
  for (const item of items) {
    // Above the message, not below it: what Crucible told the node when it
    // picked it up is the first thing on the new side of the seam.
    if (item.kind === 'user' && isContinuedNodeMessage(item.text)) {
      shown.push({ kind: 'rule', tone: 'resumed', text: 'resumed · picked up from here' })
    }
    shown.push(toViewItem(item))
  }
  const closing = closingRule(run, node, now)
  if (closing !== undefined) shown.push(closing)
  return shown
}

/**
 * The rule that ends a stopped node's transcript, in that node's own word for
 * how it stopped (`nodeStop`). A run can hold several nodes in flight, so the
 * stop that ended the run is not always the stop that ended this node: the
 * run's word carries only where the record has none of its own, which is the
 * node a cancel or a quit released.
 */
function closingRule(run: RunRecord, node: RunNode, now: number): ViewItem | undefined {
  const stop = nodeStop(run, node)
  if (stop === undefined) return undefined
  if (!stoppedNodes(run).some((stopped) => stopped.id === node.id)) return undefined
  const age = since(node.endedAt ?? run.endedAt, now)
  return { kind: 'rule', tone: stop, text: `${stop} here${age === '' ? '' : ` · ${age}`}` }
}
