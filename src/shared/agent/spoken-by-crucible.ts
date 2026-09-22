// Spelled with their extensions so plain Node can load this module for
// `prove:sdk`: its ESM resolver does no extension guessing.
import { isWakeMessage } from '../monitors/wording.ts'
import { isAnswerBatch } from '../questions/wording.ts'
import { isContinuedNodeMessage, isRunMessage } from '../workflows/run.ts'

// Whether a message in the user's role was Crucible talking, not a person.
// A run's report, a monitor's wake, an answer batch and a resumed node's
// opening all arrive as user messages because prompting an agent is the only
// voice any of them has; each opens with a prefix its own module spells, and
// this is the one place that reads them all. Anything that treats the
// person's words differently from Crucible's — the titler, the compaction's
// document — asks here, so no reader keeps its own list.
export function spokenByCrucible(text: string): boolean {
  return (
    isRunMessage(text) ||
    isWakeMessage(text) ||
    isAnswerBatch(text) ||
    isContinuedNodeMessage(text)
  )
}
