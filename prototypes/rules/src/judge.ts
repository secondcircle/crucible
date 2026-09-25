// The judge client: real Jev calls, cached by (model, state, questions), with a spend cap.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TypeSafeClient, type Questions, type SystemOneResult } from '@typesafe-ai/sdk'
import type { Item } from './rule.ts'

const PRICE_PER_TOKEN = 0.042 / 1_000_000

export interface JudgeRequest<Q extends Questions> {
  model: string
  state: Item['state']
  questions: Q
}

export interface Judged<Q extends Questions> {
  result: SystemOneResult<Q>
  cached: boolean
  ms: number
}

export interface JudgeOptions {
  cacheDir: string
  /** Dollars. Uncached calls beyond this are refused before any is sent. */
  budget: number
  concurrency?: number
}

export class Judge {
  private client: TypeSafeClient | undefined
  spent = 0
  calls = 0
  hits = 0

  private opts: JudgeOptions

  constructor(opts: JudgeOptions) {
    this.opts = opts
    mkdirSync(opts.cacheDir, { recursive: true })
    if (process.env.TYPESAFE_API_KEY) this.client = new TypeSafeClient({ timeout: 20_000 })
  }

  get available(): boolean {
    return this.client !== undefined
  }

  private keyOf(req: JudgeRequest<Questions>): string {
    return createHash('sha256').update(JSON.stringify([req.model, req.state, req.questions])).digest('hex')
  }

  cached<Q extends Questions>(req: JudgeRequest<Q>): SystemOneResult<Q> | undefined {
    const file = join(this.opts.cacheDir, `${this.keyOf(req)}.json`)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SystemOneResult<Q>) : undefined
  }

  /** A rough input-token estimate, for the spend preview only; real usage comes back on the answer. */
  static estimateTokens(req: JudgeRequest<Questions>): number {
    return Math.ceil(JSON.stringify(req.state).length / 4 + JSON.stringify(req.questions).length / 4)
  }

  /** Estimate what the uncached part of a batch will cost. */
  preview(reqs: JudgeRequest<Questions>[]): { uncached: number; dollars: number } {
    const todo = reqs.filter((r) => !this.cached(r))
    const tokens = todo.reduce((n, r) => n + Judge.estimateTokens(r), 0)
    return { uncached: todo.length, dollars: tokens * PRICE_PER_TOKEN }
  }

  async ask<Q extends Questions>(req: JudgeRequest<Q>): Promise<Judged<Q>> {
    const hit = this.cached(req)
    if (hit) {
      this.hits++
      return { result: hit, cached: true, ms: 0 }
    }
    if (!this.client) throw new Error('TYPESAFE_API_KEY is not set')
    const t0 = performance.now()
    const result = await this.client.systemOne({ model: req.model, state: req.state, questions: req.questions })
    const ms = performance.now() - t0
    this.calls++
    this.spent += result.usage.input_tokens * PRICE_PER_TOKEN
    writeFileSync(join(this.opts.cacheDir, `${this.keyOf(req)}.json`), JSON.stringify(result))
    return { result: result as SystemOneResult<Q>, cached: false, ms }
  }

  /** Ask many, a few at a time, after checking the batch fits the budget. */
  async askAll<Q extends Questions>(reqs: JudgeRequest<Q>[]): Promise<(Judged<Q> | Error)[]> {
    const { uncached, dollars } = this.preview(reqs)
    if (uncached > 0 && !this.client) throw new Error(`${uncached} uncached judge calls and TYPESAFE_API_KEY is not set`)
    if (dollars > this.opts.budget) {
      throw new Error(
        `${uncached} uncached calls, estimated $${dollars.toFixed(4)}, over the $${this.opts.budget} budget (--budget)`,
      )
    }
    const out: (Judged<Q> | Error)[] = new Array(reqs.length)
    let next = 0
    const worker = async () => {
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
}
