import { createLedgerRulesService, type LedgerRulesService } from '../../../shared/rules/ledger-service'
import {
  RULES_LEDGER_VERSION,
  ruleMessage,
  type CatalogRule,
  type Firing,
  type LedgerLine
} from '../../../shared/rules/ledger'

// The rules seam as main answers it, over lines a test writes instead of a
// file: the same service and the same derivation, so every board, chip and
// mark behavior is proved against what the ledger alone says.

export interface ScriptedRules extends LedgerRulesService {
  /** Adds lines to a workspace's ledger and announces the change, as an append does. */
  append(workspacePath: string, lines: readonly LedgerLine[]): void
}

/** `ledgers` maps a workspace with `.crucible/rules/` to its lines; any other has none. */
export function createScriptedRules(ledgers: Readonly<Record<string, readonly LedgerLine[]>>): ScriptedRules {
  const held = new Map(Object.entries(ledgers).map(([path, lines]) => [path, [...lines]]))
  const service = createLedgerRulesService({ lines: async (workspacePath) => held.get(workspacePath) })
  return {
    ...service,
    append(workspacePath, lines) {
      held.set(workspacePath, [...(held.get(workspacePath) ?? []), ...lines])
      service.changed(workspacePath)
    }
  }
}

const MINUTE = 60_000

export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString()
}

export function catalogLine(rules: readonly CatalogRule[], at = minutesAgo(600)): LedgerLine {
  return { v: RULES_LEDGER_VERSION, type: 'catalog', at, rules }
}

export function firingLine(firing: Firing): LedgerLine {
  return { v: RULES_LEDGER_VERSION, type: 'firing', ...firing }
}

export const COMMENTS: CatalogRule = {
  name: 'comments',
  summary: 'a comment says why, never what',
  source: 'AGENTS.md#comments',
  on: 'edit',
  mode: 'enforce',
  running: 'enforce',
  judge: 'jev-1.13.0',
  agents: 'both'
}

export const PROMPTS: CatalogRule = {
  name: 'prompts-live-in-files',
  summary: 'a prompt is a file, not a string',
  source: 'docs/adr/0007.md',
  on: 'edit',
  mode: 'shadow',
  running: 'shadow',
  judge: 'jev-1.13.0',
  agents: 'sessions'
}

export const NO_CONSOLE: CatalogRule = {
  name: 'no-console',
  summary: 'the run log, not the console',
  source: 'AGENTS.md#logging',
  on: 'edit',
  mode: 'enforce',
  running: 'enforce',
  agents: 'both'
}

export const PINNED: CatalogRule = {
  name: 'pinned-deps',
  summary: 'dependencies are pinned',
  source: 'AGENTS.md#deps',
  on: 'commit',
  mode: 'off',
  running: 'off',
  agents: 'both'
}

export const NOTE_TEXT =
  'src/shared/agent/port.ts:98 describes what the code does. Delete it, or say why the code does something a reader would find strange.'

const judged = {
  model: 'jev-1.13.0',
  answers: {
    kind: {
      type: 'choice',
      choice: 'narrates',
      confidence: 0.91,
      probabilities: { narrates: 0.91, explains_why: 0.06, other: 0.03 }
    }
  },
  tokens: 412,
  dollars: 0.00041,
  ms: 380,
  cached: false
}

/** An inline note on call `c1` that the agent fixed at its next edit. */
export function notedAndFixed(sessionId: string): LedgerLine[] {
  const firing: Firing = {
    id: 'f-noted',
    at: minutesAgo(30),
    rule: 'comments',
    mode: 'enforce',
    trigger: 'edit',
    agent: { kind: 'session', sessionId },
    toolCallId: 'c1',
    where: 'src/shared/agent/port.ts',
    item: {
      key: 'a1b2c3d4e5f6a7b8',
      path: 'src/shared/agent/port.ts',
      line: 98,
      state: '// Loop over the listeners and call each one',
      excerpt: {
        before: 'export function emit(event: Event): void {',
        focus: '  // Loop over the listeners and call each one',
        after: '  for (const listener of listeners) listener(event)'
      }
    },
    judged,
    action: 'note',
    feedback: NOTE_TEXT,
    read: ruleMessage('comments', COMMENTS.source, NOTE_TEXT),
    delivery: 'inline',
    tookMs: 410,
    change: { tool: 'edit', added: 3, removed: 0 }
  }
  return [
    { v: RULES_LEDGER_VERSION, type: 'admitted', at: firing.at, rule: 'comments', agent: firing.agent, trigger: 'edit', items: 1 },
    firingLine(firing),
    {
      v: RULES_LEDGER_VERSION,
      type: 'reaction',
      at: minutesAgo(29),
      firing: firing.id,
      afterMs: 1400,
      said: 'Dropping that comment: the loop already says what it does.',
      then: { tool: 'edit', path: 'src/shared/agent/port.ts', diff: '- // Loop over the listeners and call each one' }
    },
    {
      v: RULES_LEDGER_VERSION,
      type: 'outcome',
      at: minutesAgo(29),
      firing: firing.id,
      outcome: 'fixed',
      how: 'at the next edit of this file'
    }
  ]
}

/** A shadow firing on the same call: judged, nothing delivered. */
export function shadowPass(sessionId: string): LedgerLine[] {
  return [
    firingLine({
      id: 'f-shadow',
      at: minutesAgo(30),
      rule: 'prompts-live-in-files',
      mode: 'shadow',
      trigger: 'edit',
      agent: { kind: 'session', sessionId },
      toolCallId: 'c1',
      where: 'src/shared/agent/port.ts',
      item: { key: 'ffeeddccbbaa9988', path: 'src/shared/agent/port.ts', line: 12, state: 'const SYSTEM = "You are…"' },
      judged,
      action: 'note',
      feedback: 'That string is a prompt; move it into a file under resources/.',
      delivery: 'none',
      tookMs: 390
    })
  ]
}

/** A note that missed call `c2`'s result and was steered in, still open. */
export function steeredOpen(sessionId: string): LedgerLine[] {
  const feedback = 'src/shared/agent/port.ts:120 restates the type below it.'
  return [
    firingLine({
      id: 'f-steered',
      at: minutesAgo(20),
      rule: 'comments',
      mode: 'enforce',
      trigger: 'edit',
      agent: { kind: 'session', sessionId },
      toolCallId: 'c2',
      where: 'src/shared/agent/port.ts',
      item: { key: '0011223344556677', path: 'src/shared/agent/port.ts', line: 120, state: '// The listener type' },
      judged,
      action: 'note',
      feedback,
      read: ruleMessage('comments', COMMENTS.source, feedback),
      delivery: 'steered',
      tookMs: 2100
    })
  ]
}

/** A rule that threw on call `c2`: a skip that means something is wrong. */
export function threw(sessionId: string): LedgerLine[] {
  return [
    firingLine({
      id: 'f-threw',
      at: minutesAgo(19),
      rule: 'no-console',
      mode: 'enforce',
      trigger: 'edit',
      agent: { kind: 'session', sessionId },
      toolCallId: 'c2',
      where: 'src/shared/agent/port.ts',
      action: 'log',
      delivery: 'none',
      tookMs: 3,
      skip: { kind: 'threw', message: "Cannot read properties of undefined (reading 'text')" }
    })
  ]
}

/** An escalation nobody has answered: counted on the chip, never lighting it. */
export function escalatedOpen(sessionId: string): LedgerLine[] {
  return [
    firingLine({
      id: 'f-escalated',
      at: minutesAgo(15),
      rule: 'comments',
      mode: 'enforce',
      trigger: 'edit',
      agent: { kind: 'session', sessionId },
      toolCallId: 'c3',
      where: 'src/shared/agent/port.ts',
      item: { key: '8899aabbccddeeff', path: 'src/shared/agent/port.ts', line: 140, state: '// increments i' },
      judged,
      action: 'escalate',
      bounced: true,
      feedback: 'noted twice already',
      delivery: 'none',
      tookMs: 400
    })
  ]
}

/** A firing ten days old, in another session: inside 30 days, outside 7. */
export function tenDaysOld(sessionId: string): LedgerLine[] {
  return [
    firingLine({
      id: 'f-old',
      at: minutesAgo(10 * 24 * 60),
      rule: 'comments',
      mode: 'enforce',
      trigger: 'edit',
      agent: { kind: 'session', sessionId },
      toolCallId: 'old-1',
      where: 'src/main/index.ts',
      item: { key: '1234123412341234', path: 'src/main/index.ts', line: 7, state: '// start the app' },
      judged,
      action: 'note',
      feedback: 'src/main/index.ts:7 narrates.',
      read: ruleMessage('comments', COMMENTS.source, 'src/main/index.ts:7 narrates.'),
      delivery: 'inline',
      tookMs: 350
    })
  ]
}

/** A firing in one node of a run, on its call `n1`. */
export function inNode(runId: string, nodeId: string, id = 'f-node', callId = 'n1'): LedgerLine[] {
  const feedback = 'src/renderer/src/runs/flow.ts:4 narrates the loop.'
  return [
    firingLine({
      id,
      at: minutesAgo(10),
      rule: 'comments',
      mode: 'enforce',
      trigger: 'edit',
      agent: { kind: 'node', runId, nodeId, workflow: 'build' },
      toolCallId: callId,
      where: 'src/renderer/src/runs/flow.ts',
      item: { key: `${id}-key-0000000`, path: 'src/renderer/src/runs/flow.ts', line: 4, state: '// Loop over the nodes' },
      judged,
      action: 'note',
      feedback,
      read: ruleMessage('comments', COMMENTS.source, feedback),
      delivery: 'inline',
      tookMs: 420
    })
  ]
}
