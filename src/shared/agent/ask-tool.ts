import type { SessionId } from './port.ts'
// Spelled with its extension so plain Node can load this module for
// `prove:sdk`: its ESM resolver does no extension guessing.
import type { ToolParameter } from './tool-parameter.ts'

// Both adapters build the ask tool from this definition, so a question cannot
// mean one thing behind the fake and another behind the SDK. The teaching
// rides the description and the argument descriptions: a description travels
// in the request's tools parameter, the one channel Crucible's system prompt
// does not replace.

export const ASK_TOOL = 'crucible_ask'

export interface AskToolDefinition {
  readonly name: typeof ASK_TOOL
  /** Human-readable, for a tool row. */
  readonly label: string
  readonly description: string
  readonly parameters: readonly ToolParameter[]
}

export const ASK_TOOL_DEFINITION: AskToolDefinition = {
  name: ASK_TOOL,
  label: 'Ask the User',
  description:
    'Put one decision to the user without stopping. The question appears in the questions ' +
    'dock, pinned above their composer where it cannot scroll away, and this call comes back ' +
    'at once.\n\n' +
    'It never carries an answer. Ask, then carry on with whatever does not depend on the ' +
    'answer, or end your turn and wait. Never sleep, never poll, never ask the same thing ' +
    'again in a message: a second ask is a second question in their line.\n\n' +
    'Answers arrive together and only once every open question has been answered or ' +
    'dismissed: one message listing each question with the user\'s answer, or with the note ' +
    'that they dismissed it. It reaches you mid-turn if you are still working, and starts a ' +
    'turn if you have stopped. A dismissed question is theirs declined, not forgotten — ' +
    'decide that one yourself and say what you decided.\n\n' +
    'One question per call. Several decisions are several calls, made together; do not pack ' +
    'two questions into one.\n\n' +
    'Ask when the work genuinely forks and the user owns the fork: a preference, a ' +
    'trade-off, a scope call, something only they know. Do not ask what the repository, the ' +
    'code or your own tools can tell you, and do not ask for permission to do the obvious.',
  parameters: [
    {
      name: 'question',
      description:
        'The decision, as one sentence ending in a question mark. The user reads this in ' +
        'bold and nothing else is guaranteed to be read, so it has to be answerable cold, ' +
        'by someone who has not been watching the work.'
    },
    {
      name: 'context',
      description:
        'What the user needs to decide this one thing, in a short paragraph. Write for ' +
        'someone who knows nothing of the current work: name the thing at stake, what is ' +
        'true of it today, and what each way would mean. Exactly that much — background ' +
        'that does not bear on this decision costs them the decision.'
    },
    {
      name: 'recommendation',
      description:
        'What you would do, as a course of action with its reason in a line or two. Shown ' +
        'in its own box, and a button sends it back verbatim as the answer, so write the ' +
        'answer you would be content to receive.'
    }
  ]
}

/** What `crucible_ask` is called with, already checked. */
export interface AskRequest {
  readonly question: string
  readonly context: string
  readonly recommendation: string
}

export function askRequestFrom(params: unknown): AskRequest {
  const given = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >
  const question = text(given.question)
  const context = text(given.context)
  const recommendation = text(given.recommendation)

  const missing = [
    question === '' ? 'question' : undefined,
    context === '' ? 'context' : undefined,
    recommendation === '' ? 'recommendation' : undefined
  ].filter((name): name is string => name !== undefined)
  if (missing.length > 0) {
    throw new Error(
      `A question needs ${missing.join(', ')}. Nothing was asked. Call ${ASK_TOOL} again with ` +
        'the question in one sentence, the context the user needs to decide it cold, and your ' +
        'recommendation.'
    )
  }

  return { question, context, recommendation }
}

/** The tool row's summary: the question itself, which is what it is about. */
export function askCallSummary(args: unknown): string {
  const given = (typeof args === 'object' && args !== null ? args : {}) as { question?: unknown }
  const question = text(given.question)
  return question === '' ? 'a question' : question
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// An adapter is handed the behavior rather than the line itself. It resolves
// with exactly the text the tool result must show.
export interface AskTools {
  ask(sessionId: SessionId, request: AskRequest): string
}

/** The same behavior with the session fixed: what a tool builder is handed. */
export interface BoundAskTool {
  ask(request: AskRequest): string
}

// A session's questions are its own: the adapter binds to the session it
// opened, and the tool takes no session argument, so no agent can put a
// question into another session's dock.
export function bindAskTool(tools: AskTools, sessionId: SessionId): BoundAskTool {
  return { ask: (request: AskRequest) => tools.ask(sessionId, request) }
}
