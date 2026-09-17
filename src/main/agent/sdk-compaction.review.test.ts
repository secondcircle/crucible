// @vitest-environment node
//
// Left failing by review-1: the reproduction for finding 1 of
// `review-1.md`. Delete this file with the fix.
//
// Q6 ruled the compaction request runs at the "same model and same thinking
// level as the loop being compacted". `askOnWarmCache` passes no thinking
// level at all, and pi-ai reads a missing `reasoning` as thinking off
// (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:661`,
// which sends `thinking: { type: "disabled" }`). π's own summarizer does
// carry it: `createSummarizationOptions` sets `options.reasoning =
// thinkingLevel`.
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { askOnWarmCache } from './sdk-compaction'

const thinkingSession = (): AgentSession =>
  ({
    model: { id: 'claude-probe', provider: 'anthropic', reasoning: true },
    thinkingLevel: 'high',
    systemPrompt: 'the session’s own system prompt',
    messages: [{ role: 'user', content: 'the conversation so far' }],
    getActiveToolNames: () => [],
    getAllTools: () => []
  }) as unknown as AgentSession

describe('the compaction’s own model request', () => {
  it('runs at the thinking level the loop being compacted runs at', async () => {
    let asked: { readonly reasoning?: string } | undefined
    const ask = askOnWarmCache({
      session: thinkingSession(),
      toLlm: (messages) => [...(messages as unknown as unknown[])],
      complete: async (_model, _context, options) => {
        asked = options as { readonly reasoning?: string }
        return { content: [{ type: 'text', text: '<trajectory>x</trajectory>' }] } as AssistantMessage
      }
    })

    await ask('compact this', new AbortController().signal)

    expect(asked?.reasoning).toBe('high')
  })
})
