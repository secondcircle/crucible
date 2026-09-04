import type {
  BranchSummaryResult,
  GenerateBranchSummaryOptions,
  InlineExtension,
  SessionEntry
} from '@earendil-works/pi-coding-agent'

// π writes a branch summary with a fixed 2048-token reply cap and, since
// 0.84.4, refuses a reply that hit it — so a busy branch fails to summarize
// at random, and the jump that asked for it goes nowhere. This is the same
// summarizer, π's own, run through π's `session_before_tree` hook with the
// cap taken off: the prompt, the budget walk, the file lists and the retries
// are all π's. Only the request differs.

type StreamFn = NonNullable<GenerateBranchSummaryOptions['streamFn']>

export interface BranchSummaryDeps {
  /** π's `generateBranchSummary`, handed in so nothing here loads the SDK. */
  readonly generate: (
    entries: SessionEntry[],
    options: GenerateBranchSummaryOptions
  ) => Promise<BranchSummaryResult>
  /** One model request. The runtime's `streamSimple` resolves its own auth. */
  readonly stream: StreamFn
  /** Read per summary, since settings can change between jumps. */
  readonly retry: () => GenerateBranchSummaryOptions['retry']
  readonly reserveTokens: () => number
  /** A transient failure π is about to retry, narrated across the port. */
  readonly retryScheduled: (
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    errorMessage: string
  ) => void
  // π swallows a hook that throws and falls back to its own capped
  // summarizer, so a failure is reported here and the jump cancelled
  // instead: the caller turns the message into the error the user sees.
  readonly failed: (message: string) => void
}

// Without a cap of its own the request falls to the model's own output
// limit, clamped by the provider to what the context has room for — which
// is what every ordinary turn already gets.
export function uncapped<T extends { maxTokens?: number }>(options: T): Omit<T, 'maxTokens'> {
  const rest: T = { ...options }
  delete rest.maxTokens
  return rest
}

export const BRANCH_SUMMARY_EXTENSION = 'crucible-branch-summary'

export function branchSummaryExtension(deps: BranchSummaryDeps): InlineExtension {
  return {
    name: BRANCH_SUMMARY_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.on('session_before_tree', async (event, ctx) => {
        const { preparation, signal } = event
        // A jump without a summary, or from nowhere, is π's to finish alone.
        if (!preparation.userWantsSummary || preparation.entriesToSummarize.length === 0) return
        // Without a model π's own path fails the same way; let it say so.
        if (ctx.model === undefined) return

        let result: BranchSummaryResult
        try {
          result = await deps.generate(preparation.entriesToSummarize, {
            model: ctx.model,
            signal,
            customInstructions: preparation.customInstructions,
            replaceInstructions: preparation.replaceInstructions,
            reserveTokens: deps.reserveTokens(),
            streamFn: (model, context, options) =>
              deps.stream(model, context, uncapped(options ?? {})),
            retry: deps.retry(),
            callbacks: { onRetryScheduled: deps.retryScheduled }
          })
        } catch (thrown) {
          deps.failed(thrown instanceof Error ? thrown.message : String(thrown))
          return { cancel: true }
        }

        if (result.aborted === true) return { cancel: true }
        if (result.error !== undefined) {
          deps.failed(result.error)
          return { cancel: true }
        }
        return {
          summary: {
            summary: result.summary ?? '',
            details: {
              readFiles: result.readFiles ?? [],
              modifiedFiles: result.modifiedFiles ?? []
            },
            usage: result.usage
          }
        }
      })
    }
  }
}
