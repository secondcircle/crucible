import type { TranscriptItem } from '../agent/port'
import { spokenByCrucible } from '../agent/spoken-by-crucible.ts'

// The conversation as a markdown document, which is what the summarizing
// request reads. One heading per thing that happened, in order, with the
// hierarchy plain: a person's message, the agent's reply, and under a reply
// the tool calls it made. Thinking is left out; it was never part of the
// conversation the two of them had.

// Tool results are most of a conversation's tokens. Each keeps its opening
// lines, enough to say what the file held or the command printed, and says
// how much was cut.
export const RESULT_LINES_KEPT = 40

export interface ConversationDocument {
  /** What the previous compaction wrote, where there was one. */
  readonly previousSummary?: string
  readonly items: readonly TranscriptItem[]
}

export function renderConversation({ previousSummary, items }: ConversationDocument): string {
  const sections: string[] = ['# Conversation']
  if (previousSummary !== undefined && previousSummary.trim() !== '') {
    sections.push(
      '## Summary of the conversation before this point\n\n' +
        'Everything earlier than this was compacted once already; this is what that ' +
        'compaction kept.\n\n' +
        previousSummary.trim()
    )
  }
  sections.push('## Messages')
  for (const item of items) {
    const section = renderItem(item)
    if (section !== undefined) sections.push(section)
  }
  return sections.join('\n\n')
}

function renderItem(item: TranscriptItem): string | undefined {
  switch (item.kind) {
    case 'user': {
      const text = item.text.trim()
      if (text === '') return undefined
      // A run's report, a monitor's wake or an answer batch arrives in the
      // user's role because prompting the agent is the only voice Crucible
      // has, but nobody typed it. Named for what it is, and cut like a tool
      // result: every fact in one is on a record somewhere else.
      return spokenByCrucible(text)
        ? `### Message from Crucible\n\n${clipped(text)}`
        : `### User\n\n${text}`
    }
    case 'assistant': {
      const text = item.markdown.trim()
      return text === '' ? undefined : `### Assistant\n\n${text}`
    }
    case 'tool':
      return (
        `#### Tool call: ${item.name}\n\n` +
        `${item.summary.trim()}\n\n` +
        `Result (${item.ok ? 'ok' : 'failed'}):\n\n${fenced(clipped(item.output))}`
      )
    case 'bashRun':
      return (
        `### Bash run by the user\n\n` +
        `${fenced(item.command.trim())}\n\n` +
        `Output${item.exitCode === undefined ? '' : ` (exit ${item.exitCode})`}:\n\n` +
        fenced(clipped(item.output))
      )
    case 'error':
      return `### Error\n\n${item.message.trim()}`
    case 'thinking':
    case 'summary':
    case 'cacheMiss':
    case 'stopped':
      return undefined
  }
}

function clipped(text: string): string {
  const lines = text.trimEnd().split('\n')
  if (lines.length <= RESULT_LINES_KEPT) return lines.join('\n')
  const cut = lines.length - RESULT_LINES_KEPT
  return `${lines.slice(0, RESULT_LINES_KEPT).join('\n')}\n(${cut.toLocaleString('en-US')} more lines)`
}

// A fence longer than any run of backticks inside, so the content cannot
// close it early.
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}
