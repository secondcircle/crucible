import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExtensionAPI, ExtensionContext, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { RuleAgent, RuleGate, RuleNote, RuleWatch } from '../../shared/rules/gate.ts'

// Rules, as π hooks into one agent loop. A bash call is judged before it runs
// and a block refuses it; an edit or a write is judged after it lands, and
// what decides in time rides in the tool result. What decides later is
// steered in at the next tool boundary; a session's hold is a follow-up at
// the end of its turn. None of it can fail a tool call: the gate swallows its
// own failures, and so does this.

export const RULES_EXTENSION = 'crucible-rules'

/** The custom message a steered note or a hold travels as. */
export const RULE_NOTE_TYPE = 'crucible.ruleNote'

/** How many times one prompt's end may be held before it is let go. */
const HOLDS_PER_PROMPT = 2

type TextBlock = { type: 'text'; text: string }

/** The path an edit names, relative to the checkout; absent for one outside it. */
export function checkoutPath(cwd: string, path: string): string | undefined {
  const inside = relative(cwd, isAbsolute(path) ? path : resolve(cwd, path))
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
  return inside.split(sep).join('/')
}

/** The tool result's content with text added to the end of its last text block. */
export function appendToContent<Block extends { type: string }>(content: readonly Block[], text: string): Block[] {
  const blocks = [...content]
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as unknown as TextBlock
    if (block.type !== 'text') continue
    blocks[i] = { ...block, text: `${block.text}${text}` } as unknown as Block
    return blocks
  }
  return [...blocks, { type: 'text', text: text.replace(/^\n+/, '') } as unknown as Block]
}

function assistantText(message: unknown): string {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown }
  if (role !== 'assistant' || !Array.isArray(content)) return ''
  return content
    .filter((block): block is TextBlock => (block as { type?: unknown }).type === 'text')
    .map((block) => block.text)
    .join('')
}

export interface RulesExtensionDeps {
  readonly gate: RuleGate
  /** Who this loop is; `cwd` is where its tools run. */
  readonly agent: RuleAgent
  /** A node's completion is held through its complete tool instead of at settle. */
  readonly holdsAtSettle: boolean
  /** The watch, once made, for the node's complete tool to ask at completion. */
  readonly watching?: (watch: RuleWatch) => void
}

export function rulesExtension(deps: RulesExtensionDeps): InlineExtension {
  return {
    name: RULES_EXTENSION,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      let ctx: ExtensionContext | undefined
      const befores = new Map<string, Promise<string | null>>()
      let holds = 0

      function steer(note: RuleNote): void {
        // A turn still running reads it at its next tool boundary; an idle
        // one reads it with whatever it is asked next.
        const idle = ctx?.isIdle() ?? true
        pi.sendMessage(
          { customType: RULE_NOTE_TYPE, content: note.text, display: true, details: { firingId: note.firingId, rule: note.rule } },
          { deliverAs: idle ? 'nextTurn' : 'steer' }
        )
      }

      const watch = deps.gate.watch(deps.agent, { steer })
      deps.watching?.(watch)

      pi.on('agent_start', async (_event, context) => {
        ctx = context
        holds = 0
        await watch.turnStarted()
      })

      pi.on('tool_call', async (event, context) => {
        ctx = context
        if (event.toolName === 'bash') {
          const command = String((event.input as { command?: unknown }).command ?? '')
          const { block } = await watch.beforeBash({ callId: event.toolCallId, command })
          return block === undefined ? undefined : { block: true, reason: block }
        }
        if (event.toolName === 'edit' || event.toolName === 'write') {
          const path = String((event.input as { path?: unknown }).path ?? '')
          befores.set(
            event.toolCallId,
            readFile(resolve(deps.agent.cwd, path), 'utf8').catch(() => null)
          )
        }
        return undefined
      })

      pi.on('tool_result', async (event, context) => {
        ctx = context
        let appendix: string | undefined
        if (event.toolName === 'bash') {
          const command = String((event.input as { command?: unknown }).command ?? '')
          appendix = (await watch.afterBash({ callId: event.toolCallId, command })).appendix
        } else if (event.toolName === 'edit' || event.toolName === 'write') {
          const before = befores.get(event.toolCallId)
          befores.delete(event.toolCallId)
          const given = String((event.input as { path?: unknown }).path ?? '')
          const path = checkoutPath(deps.agent.cwd, given)
          if (event.isError || before === undefined || path === undefined) return undefined
          const after = await readFile(resolve(deps.agent.cwd, given), 'utf8').catch(() => undefined)
          if (after === undefined) return undefined
          appendix = (
            await watch.afterEdit({ callId: event.toolCallId, tool: event.toolName, path, before: await before, after })
          ).appendix
        }
        return appendix === undefined ? undefined : { content: appendToContent(event.content, appendix) }
      })

      pi.on('message_end', (event) => {
        const text = assistantText(event.message)
        if (text !== '') watch.said(text)
      })

      pi.on('agent_before_settle', async (event, context) => {
        ctx = context
        if (!deps.holdsAtSettle || event.outcome !== 'completed') return undefined
        const { hold } = await watch.checkpoint('turn-end')
        if (hold === undefined || holds >= HOLDS_PER_PROMPT) return undefined
        holds += 1
        return {
          entries: [{ type: 'custom_message', customType: RULE_NOTE_TYPE, content: hold, display: true }],
          continue: true
        }
      })
    }
  }
}
