import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AdapterEvent } from '../../shared/agent/adapter'
import type { SessionId, TurnId } from '../../shared/agent/port'
// Spelled with its extension so plain Node can load this module: its ESM
// resolver does no extension guessing.
import { SKILL_TOOL } from '../../shared/agent/skill-tool.ts'
import { displaySafeMessage } from './adapter-error.ts'

export { SKILL_TOOL }

// Where no π SDK type is allowed past: the SDK is imported for its types only,
// and anything not named below is dropped rather than guessed at.

export interface TurnTarget {
  readonly sessionId: SessionId
  readonly turnId: TurnId
}

export interface EventMapper {
  map(event: AgentSessionEvent, target: TurnTarget): AdapterEvent | undefined
}

/** One skill, as attribution reads it: π's own `Skill` is one of these. */
export interface AttributableSkill {
  readonly name: string
  /** Absolute path of the skill's own markdown file. */
  readonly filePath: string
  /** Absolute directory that file sits in. */
  readonly baseDir: string
}

/** The skills in force for a turn, and where a relative path resolves. */
export interface SkillsInForce {
  readonly skills: readonly AttributableSkill[]
  readonly cwd: string
}

export interface DisplayedCall {
  readonly name: string
  readonly summary: string
}

// Attribution is by directory, so a supporting file read after the SKILL.md is
// still that skill and progressive disclosure stays visible in the tool chain.
// Only a `read` is re-attributed: a grep of a skill directory stays a grep.
export function displayToolCall(
  name: string,
  args: unknown,
  inForce?: SkillsInForce
): DisplayedCall {
  const summary = summarizeToolArgs(args)
  if (inForce === undefined || name !== 'read') return { name, summary }

  const asked = readPath(args)
  if (asked === undefined) return { name, summary }
  const path = absolutePath(asked, inForce.cwd)

  // The most specific claim wins, so a skill nested inside another's tree is
  // still its own skill.
  let best: { skill: AttributableSkill; within: string } | undefined
  for (const skill of inForce.skills) {
    const within = claimed(skill, path)
    if (within === undefined) continue
    if (best === undefined || within.length < best.within.length) best = { skill, within }
  }
  if (best === undefined) return { name, summary }

  return {
    name: SKILL_TOOL,
    summary: best.within === '' ? best.skill.name : `${best.skill.name} · ${best.within}`
  }
}

// A skill that is a loose `.md` at an origin root claims only that file: its
// directory is the origin, full of other people's skills.
function claimed(skill: AttributableSkill, path: string): string | undefined {
  if (path === resolve(skill.filePath)) return ''
  if (basename(skill.filePath) !== 'SKILL.md') return undefined
  const within = relative(resolve(skill.baseDir), path)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return undefined
  return within.split(sep).join('/')
}

/** π's read tool takes one path, and expands a leading `~` as this does. */
function readPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const asked = (args as { path?: unknown }).path
  return typeof asked === 'string' && asked.trim() !== '' ? asked.trim() : undefined
}

function absolutePath(asked: string, cwd: string): string {
  if (asked === '~') return homedir()
  if (asked.startsWith('~/')) return join(homedir(), asked.slice(2))
  return resolve(cwd, asked)
}

// What π's `navigateTree` answered, in the port's words. π reports a
// cancelled or aborted navigation without moving the leaf, so it is an
// outcome rather than a failure.
export function jumpOutcome(navigated: {
  readonly editorText?: string
  readonly cancelled: boolean
  readonly aborted?: boolean
}): { readonly cancelled: boolean; readonly editorText?: string } {
  if (navigated.cancelled || navigated.aborted === true) return { cancelled: true }
  return navigated.editorText === undefined
    ? { cancelled: false }
    : { cancelled: false, editorText: navigated.editorText }
}

// π's own retry of a branch summary, narrated across the port. Session-scoped
// and turn-less: the caller decides whether a summarizing jump is in flight,
// because π raises this event for compaction retries inside turns too.
export function summarizeRetryOf(
  event: AgentSessionEvent,
  sessionId: SessionId
): AdapterEvent | undefined {
  if (event.type !== 'summarization_retry_scheduled') return undefined
  return {
    type: 'summarize_retry',
    sessionId,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    delayMs: event.delayMs,
    message: displaySafeMessage(event.errorMessage, 'The summary could not be written.')
  }
}

const OUTPUT_LIMIT = 20_000

const SUMMARY_LIMIT = 160

// `inForce` is the turn's own skill set, read fresh on the way into it: what a
// turn is displayed against never changes under it mid-turn.
export function createEventMapper(inForce?: SkillsInForce): EventMapper {
  // Tool output arrives as a growing snapshot rather than as chunks, so only
  // the part past this count is forwarded.
  const forwarded = new Map<string, number>()
  // Argument characters streamed per call, so the count that crosses is
  // cumulative and monotonic rather than per-frame.
  const argChars = new Map<string, number>()
  /** The queue as the last `queue_update` reported it, oldest first. */
  let queued: readonly string[] = []
  // π says a message left its queue immediately before that message starts, so
  // what left is exactly what is being delivered. A prompt leaves no trace.
  const delivering: string[] = []

  return {
    map(event: AgentSessionEvent, { sessionId, turnId }: TurnTarget): AdapterEvent | undefined {
      switch (event.type) {
        case 'queue_update': {
          const now = [...event.steering, ...event.followUp]
          const left = [...queued]
          for (const text of now) {
            const at = left.indexOf(text)
            if (at !== -1) left.splice(at, 1)
          }
          delivering.push(...left)
          queued = now
          return {
            type: 'queue_changed',
            sessionId,
            steering: [...event.steering],
            followUp: [...event.followUp]
          }
        }

        case 'message_start': {
          if (event.message.role !== 'user') return undefined
          const text = userText(event.message.content)
          const at = delivering.indexOf(text)
          // A user message nobody queued is the prompt's own, and its caller
          // already echoed it.
          if (text === '' || at === -1) return undefined
          delivering.splice(at, 1)
          return { type: 'user_message', sessionId, turnId, text }
        }

        case 'message_update':
          switch (event.assistantMessageEvent.type) {
            case 'text_delta':
              return {
                type: 'text_delta',
                sessionId,
                turnId,
                delta: event.assistantMessageEvent.delta
              }
            case 'thinking_delta':
              return {
                type: 'thinking_delta',
                sessionId,
                turnId,
                delta: event.assistantMessageEvent.delta
              }
            // Nothing runs yet, and this window is the whole of a long call's
            // first seconds.
            case 'toolcall_start': {
              const call = toolCallAt(
                event.assistantMessageEvent.partial,
                event.assistantMessageEvent.contentIndex
              )
              if (call === undefined) return undefined
              argChars.set(call.id, 0)
              return {
                type: 'tool_call_started',
                sessionId,
                turnId,
                callId: call.id,
                name: call.name
              }
            }

            case 'toolcall_delta': {
              const call = toolCallAt(
                event.assistantMessageEvent.partial,
                event.assistantMessageEvent.contentIndex
              )
              if (call === undefined) return undefined
              const chars =
                (argChars.get(call.id) ?? 0) + event.assistantMessageEvent.delta.length
              argChars.set(call.id, chars)
              return { type: 'tool_call_args', sessionId, turnId, callId: call.id, chars }
            }

            // `toolcall_end` says nothing new: execution start, or the call's
            // own end, settles the element the two events above opened.

            case 'error':
              // An abort is not a failure: the adapter that asked for it says
              // so itself, and says it once.
              return event.assistantMessageEvent.reason === 'aborted'
                ? undefined
                : {
                    type: 'turn_error',
                    sessionId,
                    turnId,
                    message: displaySafeMessage(
                      event.assistantMessageEvent.error.errorMessage
                    )
                  }
            default:
              return undefined
          }

        // A failed request is folded into the final message rather than raised
        // as an error, so without this a paid failure reads as an empty turn.
        case 'message_end':
          return event.message.role === 'assistant' && event.message.stopReason === 'error'
            ? {
                type: 'turn_error',
                sessionId,
                turnId,
                message: displaySafeMessage(event.message.errorMessage)
              }
            : undefined

        case 'tool_execution_start': {
          forwarded.set(event.toolCallId, 0)
          argChars.delete(event.toolCallId)
          // The arguments have settled, so a path exists to attribute: a row
          // that announced itself as `read` becomes `skill` here.
          const displayed = displayToolCall(event.toolName, event.args, inForce)
          return {
            type: 'tool_started',
            sessionId,
            turnId,
            callId: event.toolCallId,
            name: displayed.name,
            summary: displayed.summary
          }
        }

        case 'tool_execution_update': {
          const whole = renderToolOutput(event.partialResult)
          const already = forwarded.get(event.toolCallId) ?? 0
          if (whole.length <= already) return undefined
          forwarded.set(event.toolCallId, whole.length)
          return {
            type: 'tool_output',
            sessionId,
            turnId,
            callId: event.toolCallId,
            chunk: whole.slice(already)
          }
        }

        case 'tool_execution_end':
          forwarded.delete(event.toolCallId)
          argChars.delete(event.toolCallId)
          return {
            type: 'tool_ended',
            sessionId,
            turnId,
            callId: event.toolCallId,
            ok: !event.isError,
            output: renderToolOutput(event.result)
          }

        // The SDK's own turn boundaries are dropped: one `prompt()` call spans
        // several of them when the SDK retries or compacts.
        default:
          return undefined
      }
    }
  }
}

// The call being streamed at that position, when the partial message genuinely
// carries one there: nothing is guessed from a half-parsed block.
function toolCallAt(
  partial: unknown,
  contentIndex: number
): { readonly id: string; readonly name: string } | undefined {
  const content = (partial as { content?: unknown })?.content
  if (!Array.isArray(content)) return undefined
  const block = content[contentIndex] as { type?: unknown; id?: unknown; name?: unknown }
  if (block?.type !== 'toolCall') return undefined
  if (typeof block.id !== 'string' || typeof block.name !== 'string') return undefined
  return { id: block.id, name: block.name }
}

// The argument a person recognizes the call by, never the whole object: this
// becomes a one-line label.
export function summarizeToolArgs(args: unknown): string {
  if (typeof args === 'string') return clip(args, SUMMARY_LIMIT)
  if (typeof args !== 'object' || args === null) return ''

  const fields = args as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(value.trim(), SUMMARY_LIMIT)
  }
  const first = Object.values(fields).find((value) => typeof value === 'string' && value !== '')
  return typeof first === 'string' ? clip(first, SUMMARY_LIMIT) : ''
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('')
}

// Only text blocks cross: an image or a structured payload is the SDK's own
// shape, and a transcript item is a string.
export function renderToolOutput(result: unknown): string {
  if (typeof result === 'string') return clip(result, OUTPUT_LIMIT)
  if (typeof result !== 'object' || result === null) return ''

  const content = (result as { content?: unknown }).content
  if (typeof content === 'string') return clip(content, OUTPUT_LIMIT)
  if (!Array.isArray(content)) return ''

  const text = content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('')
  return clip(text, OUTPUT_LIMIT)
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`
}
