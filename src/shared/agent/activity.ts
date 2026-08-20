import type { TranscriptItem } from './port'

// The dim line a session tree shows between two user messages. Both adapters
// build it from real entries here, so one conversation never reads two ways.

/** Counted off real entries: nothing is invented and nothing is rounded. */
export function summarizeActivity(items: readonly TranscriptItem[]): string | undefined {
  const parts: string[] = []
  const tools = new Map<string, number>()
  let assistant = false
  let thinking = false
  let stopped = false
  let failed = false
  let shared = 0

  for (const item of items) {
    switch (item.kind) {
      case 'assistant':
        assistant = true
        break
      case 'thinking':
        thinking = true
        break
      case 'tool':
        tools.set(item.name, (tools.get(item.name) ?? 0) + 1)
        break
      case 'bashRun':
        shared += 1
        break
      case 'stopped':
        stopped = true
        break
      case 'error':
        failed = true
        break
      case 'user':
        // A user message is a node of its own and never part of the line
        // between two nodes.
        break
    }
  }

  if (thinking) parts.push('thinking')
  if (assistant) parts.push('assistant')
  for (const [name, count] of tools) parts.push(`${count} ${name}`)
  if (shared > 0) parts.push(`${shared} bash run${shared === 1 ? '' : 's'}`)
  if (stopped) parts.push('stopped')
  if (failed) parts.push('failed')

  return parts.length === 0 ? undefined : parts.join(' · ')
}
