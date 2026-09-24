import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JsonValue, Questions, SystemOneResult } from '@typesafe-ai/sdk'

// The judge client: real Jev calls, cached by (model, state, questions), with
// a spend cap. The credential is handed in by whoever built it from Crucible's
// own settings; nothing here reads the environment or the repository.

/** Jev's price: input tokens only, output is free. */
export const PRICE_PER_TOKEN = 0.042 / 1_000_000

export interface JudgeRequest<Q extends Questions = Questions> {
  readonly model: string
  readonly state: { readonly [field: string]: JsonValue } | string
  readonly questions: Q
}

export interface Judged<Q extends Questions = Questions> {
  readonly result: SystemOneResult<Q>
  readonly cached: boolean
  readonly ms: number
  readonly tokens: number
  readonly dollars: number
}

/** One call to the service, as the SDK makes it. Injected so tests make none. */
export type SystemOneCall = (request: JudgeRequest) => Promise<SystemOneResult<Questions>>

export interface JudgeOptions {
  readonly cacheDir: string
  /** Dollars. Uncached calls beyond this are refused before any is sent. */
  readonly budget: number
  /** Absent means no credential: every uncached call fails as unreachable. */
  readonly call?: SystemOneCall
  readonly concurrency?: number
}

/** What `evaluate` needs of a judge, so a test can hand in canned answers. */
export interface JudgeLike {
  askAll<Q extends Questions>(requests: readonly JudgeRequest<Q>[]): Promise<(Judged<Q> | Error)[]>
}

/** The SDK's own client behind one function, built only when a key exists. */
export async function typesafeCall(apiKey: string): Promise<SystemOneCall> {
  const { TypeSafeClient } = await import('@typesafe-ai/sdk')
  const client = new TypeSafeClient({ apiKey, timeout: 20_000 })
  return (request) =>
    client.systemOne({
      model: request.model,
      state: request.state as never,
      questions: request.questions
    }) as Promise<SystemOneResult<Questions>>
}

export class Judge implements JudgeLike {
  spent = 0
  calls = 0
  hits = 0

  private readonly opts: JudgeOptions

  constructor(opts: JudgeOptions) {
    this.opts = opts
    mkdirSync(opts.cacheDir, { recursive: true })
  }

  get available(): boolean {
    return this.opts.call !== undefined
  }

  private keyOf(req: JudgeRequest): string {
    return createHash('sha256').update(JSON.stringify([req.model, req.state, req.questions])).digest('hex')
  }

  cached<Q extends Questions>(req: JudgeRequest<Q>): SystemOneResult<Q> | undefined {
    const file = join(this.opts.cacheDir, `${this.keyOf(req)}.json`)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SystemOneResult<Q>) : undefined
  }

  /** A rough input-token estimate, for the spend preview only; real usage comes back on the answer. */
  static estimateTokens(req: JudgeRequest): number {
    return Math.ceil(JSON.stringify(req.state).length / 4 + JSON.stringify(req.questions).length / 4)
  }

  /** Estimate what the uncached part of a batch will cost. */
  preview(reqs: readonly JudgeRequest[]): { uncached: number; dollars: number } {
    const todo = reqs.filter((r) => !this.cached(r))
    const tokens = todo.reduce((n, r) => n + Judge.estimateTokens(r), 0)
    return { uncached: todo.length, dollars: tokens * PRICE_PER_TOKEN }
  }

  async ask<Q extends Questions>(req: JudgeRequest<Q>): Promise<Judged<Q>> {
    const hit = this.cached(req)
    if (hit) {
      this.hits++
      const tokens = hit.usage.input_tokens
      return { result: hit, cached: true, ms: 0, tokens, dollars: 0 }
    }
    const call = this.opts.call
    if (call === undefined) throw new Error('no judge credential is set')
    const t0 = performance.now()
    const result = (await call(req)) as SystemOneResult<Q>
    const ms = performance.now() - t0
    this.calls++
    const dollars = result.usage.input_tokens * PRICE_PER_TOKEN
    this.spent += dollars
    writeFileSync(join(this.opts.cacheDir, `${this.keyOf(req)}.json`), JSON.stringify(result))
    return { result, cached: false, ms, tokens: result.usage.input_tokens, dollars }
  }

  /** Ask many, a few at a time, after checking the batch fits what is left of the budget. */
  async askAll<Q extends Questions>(reqs: readonly JudgeRequest<Q>[]): Promise<(Judged<Q> | Error)[]> {
    const { uncached, dollars } = this.preview(reqs)
    if (uncached > 0 && this.opts.call === undefined) {
      const refusal = new Error('no judge credential is set')
      return reqs.map((req) => (this.cached(req) ? this.fromCache(req) : refusal))
    }
    if (this.spent + dollars > this.opts.budget) {
      const refusal = new Error(
        `${uncached} uncached calls, estimated $${dollars.toFixed(4)}, would pass the $${this.opts.budget} spend cap`
      )
      return reqs.map((req) => (this.cached(req) ? this.fromCache(req) : refusal))
    }
    const out: (Judged<Q> | Error)[] = new Array(reqs.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < reqs.length) {
        const i = next++
        try {
          out[i] = await this.ask(reqs[i]!)
        } catch (cause) {
          out[i] = cause instanceof Error ? cause : new Error(String(cause))
        }
      }
    }
    await Promise.all(Array.from({ length: this.opts.concurrency ?? 10 }, worker))
    return out
  }

  private fromCache<Q extends Questions>(req: JudgeRequest<Q>): Judged<Q> {
    const hit = this.cached(req)!
    this.hits++
    return { result: hit, cached: true, ms: 0, tokens: hit.usage.input_tokens, dollars: 0 }
  }
}
