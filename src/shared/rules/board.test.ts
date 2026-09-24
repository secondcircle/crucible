// @vitest-environment node
//
// What the board, the chip and the marks say, derived from ledger lines
// alone: the same lines an agent asked to tune a rule would read.
import { describe, expect, it } from 'vitest'
import { didLabel, formatDollars, indexLedger, rulesBoard, rulesHealth } from './board'
import { RULES_LEDGER_VERSION, type CatalogRule, type Firing, type LedgerLine } from './ledger'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const HOUR = 3_600_000

const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString()

const JUDGED: CatalogRule = {
  name: 'comments',
  summary: 'why, not what',
  source: 'AGENTS.md',
  on: 'edit',
  mode: 'enforce',
  running: 'enforce',
  judge: 'jev-1.13.0',
  agents: 'both'
}

const PLAIN: CatalogRule = {
  name: 'no-console',
  summary: 'the run log, not the console',
  source: 'AGENTS.md',
  on: 'edit',
  mode: 'enforce',
  running: 'enforce',
  agents: 'both'
}

const catalog = (...rules: CatalogRule[]): LedgerLine => ({ v: RULES_LEDGER_VERSION, type: 'catalog', at: at(100), rules })

let minted = 0
function firing(overrides: Partial<Firing>): LedgerLine {
  minted += 1
  return {
    v: RULES_LEDGER_VERSION,
    type: 'firing',
    id: `f${minted}`,
    at: at(1),
    rule: 'comments',
    mode: 'enforce',
    trigger: 'edit',
    agent: { kind: 'session', sessionId: 's1' },
    where: 'src/a.ts',
    item: { key: `k${minted}`, path: 'src/a.ts', line: 3, state: '// narrates' },
    action: 'note',
    delivery: 'inline',
    tookMs: 400,
    ...overrides
  }
}

const admitted = (rule: string, items: number, hoursAgo = 1): LedgerLine => ({
  v: RULES_LEDGER_VERSION,
  type: 'admitted',
  at: at(hoursAgo),
  rule,
  agent: { kind: 'session', sessionId: 's1' },
  trigger: 'edit',
  items
})

const judged = (dollars: number, cached = false) => ({
  model: 'jev-1.13.0',
  answers: {},
  tokens: 100,
  dollars,
  ms: 300,
  cached
})

describe('the rule rows', () => {
  it('count nothing-to-judge on the admitted lines and never as firings', () => {
    const index = indexLedger([catalog(JUDGED), admitted('comments', 0), admitted('comments', 0), admitted('comments', 1), firing({ judged: judged(0.001) })])
    const [row] = rulesBoard(index, { kind: 'workspace' }, '7d', NOW).rules
    expect(row).toMatchObject({ admitted: 3, nothingToJudge: 2, judged: 1, decided: 1 })
    expect(row!.firings).toHaveLength(1)
  })

  it('bill only uncached judge calls, and project the window over a month', () => {
    const index = indexLedger([
      catalog(JUDGED),
      firing({ judged: judged(0.7) }),
      firing({ judged: judged(0.7, true) })
    ])
    const [row] = rulesBoard(index, { kind: 'workspace' }, '7d', NOW).rules
    expect(row!.cost.dollars).toBeCloseTo(0.7)
    expect(row!.cost.perMonth).toBeCloseTo(3)
    expect(formatDollars(0)).toBe('$0')
  })

  it('take p50 and p95 over what was decided, leaving skips out', () => {
    const lines = [catalog(JUDGED)]
    for (let ms = 100; ms <= 2000; ms += 100) lines.push(firing({ tookMs: ms }))
    lines.push(firing({ tookMs: 99_999, skip: { kind: 'over-budget', message: 'ran 30s' } }))
    const [row] = rulesBoard(indexLedger(lines), { kind: 'workspace' }, 'all', NOW).rules
    expect(row!.took).toEqual({ p50: 1100, p95: 2000 })
    expect(row!.broken).toBe(1)
  })

  it('keep a firing open until an outcome is written, and follow none for a pass', () => {
    const noted = firing({})
    const passed = firing({ action: 'pass', delivery: 'none' })
    const [row] = rulesBoard(indexLedger([catalog(JUDGED), noted, passed]), { kind: 'workspace' }, '7d', NOW).rules
    expect(row!.came).toEqual({ fixed: 0, reworded: 0, open: 1, ignored: 0 })

    const fixed: LedgerLine = { v: RULES_LEDGER_VERSION, type: 'outcome', at: at(0.5), firing: (noted as Firing).id, outcome: 'fixed', how: 'at the next edit' }
    const [after] = rulesBoard(indexLedger([catalog(JUDGED), noted, passed, fixed]), { kind: 'workspace' }, '7d', NOW).rules
    expect(after!.came.fixed).toBe(1)
    expect(after!.came.open).toBe(0)
  })

  it('filter by scope and by window', () => {
    const lines = [
      catalog(JUDGED),
      firing({ agent: { kind: 'session', sessionId: 's1' } }),
      firing({ agent: { kind: 'node', runId: 'r1', nodeId: 'builder', workflow: 'build' } }),
      firing({ at: at(24 * 10) })
    ]
    const index = indexLedger(lines)
    const count = (scope: Parameters<typeof rulesBoard>[1], window: Parameters<typeof rulesBoard>[2]): number =>
      rulesBoard(index, scope, window, NOW).rules[0]!.firings.length
    expect(count({ kind: 'workspace' }, '7d')).toBe(2)
    expect(count({ kind: 'workspace' }, '30d')).toBe(3)
    expect(count({ kind: 'session', sessionId: 's1' }, 'all')).toBe(2)
    expect(count({ kind: 'run', runId: 'r1' }, 'all')).toBe(1)
  })

  it('word a shadow firing as what it would have done', () => {
    expect(didLabel({ ...(firing({ mode: 'shadow', delivery: 'none' }) as unknown as Firing) })).toBe('would note')
    expect(didLabel({ ...(firing({ skip: { kind: 'threw', message: 'x' } }) as unknown as Firing) })).toBe('skipped')
  })
})

describe('attention and the chip', () => {
  it('holds a rule the loader kept off as broken, and lights the chip', () => {
    const held: CatalogRule = { ...PLAIN, running: 'off', held: { broken: true, message: 'stays off: scenario "x" failed' } }
    const index = indexLedger([catalog(JUDGED, held)])
    expect(rulesBoard(index, { kind: 'workspace' }, '7d', NOW).attention).toEqual([
      expect.objectContaining({ kind: 'rule', rule: 'no-console', message: 'stays off: scenario "x" failed', current: true })
    ])
    expect(rulesHealth(index)).toMatchObject({ rules: 2, broken: 1, lit: true })
  })

  it('does not count a judge the workspace has not allowed as broken', () => {
    const notAllowed: CatalogRule = { ...JUDGED, running: 'off', held: { broken: false, message: 'stays off: not allowed' } }
    const index = indexLedger([catalog(notAllowed)])
    expect(rulesBoard(index, { kind: 'workspace' }, '7d', NOW).attention).toEqual([])
    expect(rulesHealth(index).lit).toBe(false)
  })

  it('lights for a rule that threw until it runs cleanly again', () => {
    const threw = firing({ rule: 'no-console', action: 'log', delivery: 'none', skip: { kind: 'threw', message: 'boom' }, at: at(2) })
    const broken = indexLedger([catalog(JUDGED, PLAIN), threw])
    expect(rulesHealth(broken)).toMatchObject({ broken: 1, lit: true })

    const recovered = indexLedger([catalog(JUDGED, PLAIN), threw, admitted('no-console', 1, 1)])
    expect(rulesHealth(recovered).lit).toBe(false)
    expect(rulesBoard(recovered, { kind: 'workspace' }, '7d', NOW).attention).toEqual([
      expect.objectContaining({ rule: 'no-console', current: false })
    ])
  })

  it('lights for an unreachable judge until it answers again', () => {
    const down = firing({ action: 'log', delivery: 'none', skip: { kind: 'judge-unreachable', message: 'timed out' }, at: at(2) })
    expect(rulesHealth(indexLedger([catalog(JUDGED), down]))).toMatchObject({ judgeDown: true, lit: true })
    const answered = firing({ judged: judged(0.001), at: at(1) })
    expect(rulesHealth(indexLedger([catalog(JUDGED), down, answered]))).toMatchObject({ judgeDown: false, lit: false })
  })

  it('counts an open escalation without lighting', () => {
    const index = indexLedger([catalog(JUDGED), firing({ action: 'escalate', delivery: 'none' })])
    expect(rulesHealth(index)).toMatchObject({ escalated: 1, lit: false })
  })
})
