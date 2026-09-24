import type { CatalogRule } from '../../../shared/rules/ledger.ts'
import type { EvaluateRequest, JudgeConfig, RuleRun } from './engine.ts'

// What main asks of a workspace's rule host. The host asks nothing back: a
// rule reads the repository and its judge, never the engine.
export type RuleHostRequests = {
  configure: { params: JudgeConfig; result: undefined }
  load: { params: Record<string, never>; result: readonly CatalogRule[] }
  evaluate: { params: EvaluateRequest; result: readonly RuleRun[] }
  present: {
    params: { rule: string; path: string; text: string }
    result: readonly string[] | undefined
  }
  head: { params: { cwd: string }; result: string | undefined }
}

// The host makes no requests of main.
export type RuleMainRequests = Record<string, never>
