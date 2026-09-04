// @vitest-environment node
//
// A fake of π's hook and a fake of its summarizer, never a session, so
// nothing here makes a paid call. What is checked is the seam: what the hook
// hands π's summarizer, and what it hands back.
import { describe, expect, it, vi } from 'vitest'
import type {
  BranchSummaryResult,
  ExtensionAPI,
  GenerateBranchSummaryOptions,
  SessionEntry
} from '@earendil-works/pi-coding-agent'
import { branchSummaryExtension, uncapped, type BranchSummaryDeps } from './sdk-branch-summary'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

const ENTRY = { type: 'message', id: 'e1' } as unknown as SessionEntry
const MODEL = { provider: 'anthropic', id: 'claude', maxTokens: 64_000 }

function harness(
  answer: BranchSummaryResult | Error = { summary: 'what happened', readFiles: ['a.ts'] }
): {
  handler: Handler
  deps: {
    generate: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
    retryScheduled: ReturnType<typeof vi.fn>
    failed: ReturnType<typeof vi.fn>
  }
  jump: (preparation?: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>
} {
  const deps = {
    generate: vi.fn(async () => {
      if (answer instanceof Error) throw answer
      return answer
    }),
    stream: vi.fn(),
    retry: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1 }),
    reserveTokens: () => 16_384,
    retryScheduled: vi.fn(),
    failed: vi.fn()
  }
  let handler: Handler | undefined
  const pi = {
    on: (event: string, given: Handler) => {
      if (event === 'session_before_tree') handler = given
    }
  } as unknown as ExtensionAPI
  const extension = branchSummaryExtension(deps as unknown as BranchSummaryDeps)
  if (typeof extension === 'function') throw new Error('expected a named extension')
  void extension.factory(pi)
  if (handler === undefined) throw new Error('no session_before_tree handler registered')
  const registered = handler

  return {
    handler: registered,
    deps,
    jump: (preparation = {}, ctx = {}) =>
      registered(
        {
          type: 'session_before_tree',
          preparation: { userWantsSummary: true, entriesToSummarize: [ENTRY], ...preparation },
          signal: new AbortController().signal
        },
        { model: MODEL, ...ctx }
      )
  }
}

describe('taking the cap off', () => {
  it('drops maxTokens and keeps everything else', () => {
    expect(uncapped({ maxTokens: 2048, signal: undefined, cacheRetention: 'none' })).toEqual({
      signal: undefined,
      cacheRetention: 'none'
    })
  })

  it('leaves options with no cap alone', () => {
    expect(uncapped({ apiKey: 'k' } as { apiKey: string; maxTokens?: number })).toEqual({
      apiKey: 'k'
    })
  })
})

describe('when the hook stands aside', () => {
  it('for a jump that asked for no summary', async () => {
    const { jump, deps } = harness()
    expect(await jump({ userWantsSummary: false })).toBeUndefined()
    expect(deps.generate).not.toHaveBeenCalled()
  })

  it('for a jump with nothing to summarize', async () => {
    const { jump, deps } = harness()
    expect(await jump({ entriesToSummarize: [] })).toBeUndefined()
    expect(deps.generate).not.toHaveBeenCalled()
  })

  it('for a session with no model', async () => {
    const { jump, deps } = harness()
    expect(await jump({}, { model: undefined })).toBeUndefined()
    expect(deps.generate).not.toHaveBeenCalled()
  })
})

describe('what π’s summarizer is handed', () => {
  it('the branch, the model, the instructions and the budget', async () => {
    const { jump, deps } = harness()
    await jump({ customInstructions: 'focus on tests', replaceInstructions: false })

    const [entries, options] = deps.generate.mock.calls[0] as [
      SessionEntry[],
      GenerateBranchSummaryOptions
    ]
    expect(entries).toEqual([ENTRY])
    expect(options.model).toBe(MODEL)
    expect(options.customInstructions).toBe('focus on tests')
    expect(options.replaceInstructions).toBe(false)
    expect(options.reserveTokens).toBe(16_384)
    expect(options.retry).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 1 })
  })

  it('a stream function that strips π’s reply cap before the request', async () => {
    const { jump, deps } = harness()
    await jump()

    const [, options] = deps.generate.mock.calls[0] as [SessionEntry[], GenerateBranchSummaryOptions]
    const context = { messages: [] }
    options.streamFn?.(MODEL as never, context as never, {
      maxTokens: 2048,
      cacheRetention: 'none'
    } as never)

    expect(deps.stream).toHaveBeenCalledWith(MODEL, context, { cacheRetention: 'none' })
  })

  it('a retry callback that narrates π’s retries', async () => {
    const { jump, deps } = harness()
    await jump()

    const [, options] = deps.generate.mock.calls[0] as [SessionEntry[], GenerateBranchSummaryOptions]
    void options.callbacks?.onRetryScheduled?.(1, 3, 500, 'overloaded')

    expect(deps.retryScheduled).toHaveBeenCalledWith(1, 3, 500, 'overloaded')
  })
})

describe('what π gets back', () => {
  it('the summary, with the file lists as π stores its own', async () => {
    const { jump } = harness({
      summary: 'what happened',
      readFiles: ['a.ts'],
      modifiedFiles: ['b.ts'],
      usage: { totalTokens: 10 } as never
    })

    expect(await jump()).toEqual({
      summary: {
        summary: 'what happened',
        details: { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] },
        usage: { totalTokens: 10 }
      }
    })
  })

  it('a cancellation when the user aborted, and no failure', async () => {
    const { jump, deps } = harness({ aborted: true })

    expect(await jump()).toEqual({ cancel: true })
    expect(deps.failed).not.toHaveBeenCalled()
  })

  // π swallows a hook that throws and runs its own capped summarizer after
  // it, so a refusal has to be a cancellation with the reason left beside it.
  it('a cancellation with the reason recorded when π’s summarizer refused', async () => {
    const { jump, deps } = harness({ error: 'Branch summarization failed: no' })

    expect(await jump()).toEqual({ cancel: true })
    expect(deps.failed).toHaveBeenCalledWith('Branch summarization failed: no')
  })

  it('the same when the request itself threw', async () => {
    const { jump, deps } = harness(new Error('Provider is not configured: anthropic'))

    expect(await jump()).toEqual({ cancel: true })
    expect(deps.failed).toHaveBeenCalledWith('Provider is not configured: anthropic')
  })
})
