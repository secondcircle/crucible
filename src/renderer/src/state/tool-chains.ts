import { tokens } from '../labels'
import type { ViewItem } from './shell-state'

// A derivation over the flat item list rather than a second shape the reducer
// has to keep in step, so a restored transcript groups as the stream did.

export type ToolItem = Extract<ViewItem, { kind: 'tool' }>

/** Everything that is not a tool call, which is everything a chain ends on. */
export type LoneItem = Exclude<ViewItem, { kind: 'tool' }>

export interface ToolCount {
  readonly name: string
  readonly count: number
}

export interface ToolChain {
  /** Stable while the user stays in the session: what expansion state is keyed by. */
  readonly key: string
  readonly calls: readonly ToolItem[]
  /** Settled calls per tool name, in order of first settlement. */
  readonly counts: readonly ToolCount[]
  /** The running call to describe in the collapsed row, if one is running. */
  readonly live?: ToolItem
  readonly errors: number
  /** Failure outranks running, so a collapsed row can never hide one. */
  readonly state: 'failed' | 'running' | 'stopped' | 'done'
  /** Exactly what the collapsed row says on its right-hand side. */
  readonly label: string
}

export type TranscriptRow =
  | { readonly kind: 'item'; readonly key: string; readonly item: LoneItem }
  | { readonly kind: 'chain'; readonly key: string; readonly chain: ToolChain }

export function groupIntoChains(items: readonly ViewItem[]): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let run: ToolItem[] = []
  let startedAt = 0

  function closeRun(): void {
    if (run.length === 0) return
    const chain = describe(run, startedAt)
    rows.push({ kind: 'chain', key: chain.key, chain })
    run = []
  }

  items.forEach((item, index) => {
    if (item.kind === 'tool') {
      if (run.length === 0) startedAt = index
      run.push(item)
      return
    }
    closeRun()
    // The transcript is append-only and never reordered, so position names a
    // row as stably as an id would, without a port having minted it.
    rows.push({ kind: 'item', key: `item-${index}`, item })
  })
  closeRun()

  return rows
}

function describe(calls: readonly ToolItem[], startedAt: number): ToolChain {
  const counts: ToolCount[] = []
  let errors = 0
  let running = false
  let cutOff = false
  let live: ToolItem | undefined

  for (const call of calls) {
    if (call.running) {
      running = true
      // The most recently started call is the one the row describes, so
      // overlapping calls never leave a stale summary on screen.
      live = call
      continue
    }
    // A call cut off with its turn never ended at all, and no outcome is
    // invented for it here.
    if (call.ok === undefined) {
      cutOff = true
      continue
    }
    if (!call.ok) errors += 1
    const already = counts.find((count) => count.name === call.name)
    if (already === undefined) counts.push({ name: call.name, count: 1 })
    else counts[counts.indexOf(already)] = { name: already.name, count: already.count + 1 }
  }

  // A failure is said the moment it happens and from then on, even while later
  // calls in the same chain are still running.
  const state = errors > 0 ? 'failed' : running ? 'running' : cutOff ? 'stopped' : 'done'
  const label = errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : state

  return {
    key: calls[0]?.callId ?? `chain-${startedAt}`,
    calls,
    counts,
    live,
    errors,
    state,
    label
  }
}

// What a call says about itself on one line. Before it runs that is the count
// of arguments streamed so far, in the meter's own shorthand; from execution
// start it is the real summary. Half-parsed JSON is never shown.
export function callSummary(call: ToolItem): string {
  if (call.argChars === undefined) return call.summary
  return `arguments · ${tokens(call.argChars)}`
}

/** `3 bash · 2 read`, or nothing at all until the first call has landed. */
export function countsText(counts: readonly ToolCount[]): string {
  return counts.map((count) => `${count.count} ${count.name}`).join(' · ')
}
