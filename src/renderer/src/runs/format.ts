import type { TranscriptItem } from '../../../shared/agent/port'
import { nodeChains, type RunNode, type RunRecord } from '../../../shared/workflows/run'
import type { ViewItem } from '../state/shell-state'

// The run surfaces' small display formats, in one place so the chip, the
// run view and the global view cannot drift into three spellings of a fact.

/** `18m`, `2h`, `3d` — the chip's shorthand, no "ago". */
export function shortAge(iso: string | undefined, now = Date.now()): string {
  if (iso === undefined) return ''
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** `2h ago`, and `just now` under the minute — never the "now ago" of a bare suffix. */
export function since(iso: string | undefined, now = Date.now()): string {
  const age = shortAge(iso, now)
  if (age === '') return ''
  return age === 'now' ? 'just now' : `${age} ago`
}

/** `$4.10`; nothing at all when no node has reported money. */
export function money(amount: number | undefined): string {
  if (amount === undefined) return ''
  return `$${amount.toFixed(2)}`
}

/** `812 B`, `6.2 KB`, `1.4 MB` — what the artifact reader's header shows. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** `anthropic/claude-opus-5-5:high` worn short: `opus-5-5:high`. */
export function shortModel(model: string | undefined): string {
  if (model === undefined) return ''
  const afterProvider = model.split('/').at(-1) ?? model
  return afterProvider.replace(/^claude-/, '')
}

/** How long a node worked, from its own stamps: `4m`, `18s`. */
export function nodeDuration(node: RunNode, now = Date.now()): string {
  if (node.startedAt === undefined) return ''
  const start = new Date(node.startedAt).getTime()
  const end = node.endedAt === undefined ? now : new Date(node.endedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return ''
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

/** What the chip says beside the workflow name. */
export function chipNodeLabel(run: RunRecord, node: RunNode | undefined): string {
  if (run.waiting === true) return '⚑ asked the agent'
  if (run.status === 'paused') return 'paused'
  if (node === undefined) return run.status
  return `▸ ${node.id}`
}

// `3/4 nodes`, counting what settled against what the graph shows. Nodes, not
// records: a revision is another attempt at a node the count already made,
// and counting it again puts this strip an inch above a graph header that
// says something else. The status is read off the record the engine is acting
// on, the furthest of each chain, for the same reason.
export function nodeProgress(run: RunRecord): string {
  const chains = nodeChains(run)
  const settled = chains.filter((chain) => chain.furthest.status === 'complete').length
  return `${settled}/${chains.length} nodes`
}

// The chat pane's shapes, restored: what the store snapshotted of a node's
// session renders through the same component the chat uses, nothing live.
export function toViewItems(items: readonly TranscriptItem[]): readonly ViewItem[] {
  return items.map(toViewItem)
}

/** One stored item as the transcript renders it. */
export function toViewItem(item: TranscriptItem): ViewItem {
  switch (item.kind) {
    case 'assistant':
      return { kind: 'assistant', markdown: item.markdown, streaming: false }
    case 'thinking':
      return {
        kind: 'thinking',
        text: item.text,
        ...(item.seconds === undefined ? {} : { seconds: item.seconds }),
        running: false
      }
    case 'tool':
      return {
        kind: 'tool',
        ...(item.callId === undefined ? {} : { callId: item.callId }),
        name: item.name,
        summary: item.summary,
        output: item.output,
        ok: item.ok,
        running: false
      }
    default:
      return item
  }
}
