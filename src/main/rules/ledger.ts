import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  parseLedgerLine,
  RULES_LEDGER_VERSION,
  type LedgerLine
} from '../../shared/rules/ledger'

// One ledger per workspace, under Crucible's own state directory and never
// inside the repository: the repository owns its rules, Crucible owns what
// they did. Appends are serialized so the file reads in the order things
// happened, and a write that fails must never fail a turn.

/** A line as its writer composes it; the ledger stamps the version. */
export type Unstamped<Line> = Line extends LedgerLine ? Omit<Line, 'v'> : never

export type NewLine = Unstamped<LedgerLine>

export interface RulesLedger {
  /** Where the file is, for an agent asked to read it; absent for one kept in memory. */
  readonly path?: string
  /** Never rejects. */
  append(lines: readonly NewLine[]): Promise<void>
  read(): Promise<readonly LedgerLine[]>
}

/** `<stateDir>/rules/ledgers/<folder name>-<hash of the path>.jsonl`. */
export function rulesLedgerPath(stateDir: string, workspacePath: string): string {
  const hash = createHash('sha1').update(workspacePath).digest('hex').slice(0, 10)
  const name = basename(workspacePath).replace(/[^A-Za-z0-9._-]/g, '_') || 'workspace'
  return join(stateDir, 'rules', 'ledgers', `${name}-${hash}.jsonl`)
}

export function stamp(lines: readonly NewLine[]): LedgerLine[] {
  return lines.map((line) => ({ v: RULES_LEDGER_VERSION, ...line }) as LedgerLine)
}

export function createFileLedger(path: string, onFailure: (cause: unknown) => void): RulesLedger {
  let tail: Promise<void> = Promise.resolve()

  return {
    path,
    append(lines) {
      if (lines.length === 0) return tail
      const text = stamp(lines)
        .map((line) => JSON.stringify(line))
        .join('\n')
      tail = tail.then(async () => {
        try {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, `${text}\n`, 'utf8')
        } catch (cause) {
          onFailure(cause)
        }
      })
      return tail
    },
    async read() {
      await tail
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch {
        return []
      }
      return text
        .split('\n')
        .map(parseLedgerLine)
        .filter((line): line is LedgerLine => line !== undefined)
    }
  }
}

/** The same ledger held in memory: the fake flavor's, and what tests read back. */
export function createMemoryLedger(seed: readonly LedgerLine[] = []): RulesLedger {
  const lines: LedgerLine[] = [...seed]
  return {
    async append(added) {
      lines.push(...stamp(added))
    },
    async read() {
      return [...lines]
    }
  }
}
