import { renderConversation, type ConversationDocument } from './transcript.ts'

// What the model is asked for at a compaction, and how its answer is read.
// The request stands on its own: a document that is the conversation so far,
// and one instruction. Nothing about the shape of the answer is dictated; the
// whole reply is the summary.

// The request's own system prompt, so the summarizing model is not the agent
// mid-turn with its tools mounted. It is asked to read a document.
export const COMPACTION_SYSTEM_PROMPT =
  'You summarize conversations between a user and an AI coding assistant so the assistant ' +
  'can continue them after the earlier messages are removed from its context.'

export function compactionInstruction(document: ConversationDocument): string {
  return [
    'Below is the conversation so far between a user and an AI coding assistant, as a ' +
      'markdown document.',
    renderConversation(document),
    '---',
    'Write a summary of this conversation for the assistant, so that it can continue the ' +
      'conversation as if no compaction had happened. Keep all information that is still ' +
      'relevant: what the user asked for and the constraints they set, the decisions made, ' +
      'what was tried and did not work, what is in progress, what comes next, and the files ' +
      'and commands that matter now. Leave out information that no longer bears on the ' +
      'conversation. Write the summary and nothing else.'
  ].join('\n\n')
}

// The whole reply is the summary. Nothing where the model wrote nothing, which
// the caller treats as a failure and leaves the conversation as it was.
export function readCompactionReply(text: string): string | undefined {
  const summary = text.trim()
  return summary === '' ? undefined : summary
}
