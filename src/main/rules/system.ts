import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuleGate } from '../../shared/rules/gate'
import type { CatalogRule } from '../../shared/rules/ledger'
import { createLedgerRulesService, type LedgerRulesService } from '../../shared/rules/ledger-service'
import { mainCheckoutOf } from './checkout'
import { createRuleGate } from './gate'
import type { JudgeConfig } from './host/engine'
import { supervisedRuleHost, type RuleHost, type SpawnRuleHost } from './host/host'
import { createFileLedger, rulesLedgerPath, type RulesLedger } from './ledger'
import { RULES_DIR } from './load'
import { readAllowedJudges, readJudgeCredential } from './settings'

// Everything main holds for rules, in one place: a rule host per workspace,
// a ledger per workspace, the gate every agent loop calls, and the read-only
// service the board is drawn from. Both flavors run the same engine; the fake
// one answers judged items from a canned judge, so a fake launch walks the
// whole path a firing takes without a key or a bill.

/** Dollars a workspace's host may spend on uncached judge calls in one launch. */
export const LAUNCH_BUDGET = 2

/** How often a request may re-read a workspace's rules. */
const CATALOG_EVERY_MS = 3000

export interface RulesWiring {
  /** Crucible's own state directory: ledgers and the judge cache live under it. */
  readonly stateDir: string
  /** Where the shipped `crucible:rule` modules are. */
  readonly libDir: string
  readonly spawn: SpawnRuleHost
  readonly judge: 'jev' | 'canned'
  /** The user's home, where Crucible's own settings are. */
  readonly home: string
  readonly log: (event: string, fields: Record<string, unknown>) => void
}

export interface RulesSystem {
  readonly gate: RuleGate
  readonly service: LedgerRulesService
  /** The workspace an agent working in this directory belongs to. */
  workspaceOf(cwd: string): Promise<string>
  dispose(): void
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createRulesSystem(wiring: RulesWiring): RulesSystem {
  const hosts = new Map<string, RuleHost>()
  const ledgers = new Map<string, RulesLedger>()
  const catalogs = new Map<string, readonly CatalogRule[]>()
  const refreshed = new Map<string, { at: number; work: Promise<void> }>()
  const watchers = new Map<string, FSWatcher>()
  const checkouts = new Map<string, Promise<string>>()

  function hostOf(workspacePath: string): RuleHost {
    let host = hosts.get(workspacePath)
    if (host === undefined) {
      host = supervisedRuleHost({
        spawn: wiring.spawn,
        workspacePath,
        libDir: wiring.libDir,
        onDeath: (said) => wiring.log('rule_host_died', { workspacePath, message: said })
      })
      hosts.set(workspacePath, host)
    }
    return host
  }

  function ledgerOf(workspacePath: string): RulesLedger {
    let ledger = ledgers.get(workspacePath)
    if (ledger === undefined) {
      ledger = createFileLedger(rulesLedgerPath(wiring.stateDir, workspacePath), (cause) =>
        wiring.log('rules_ledger_write_failed', { workspacePath, message: message(cause) })
      )
      ledgers.set(workspacePath, ledger)
    }
    return ledger
  }

  async function judgeOf(workspacePath: string): Promise<JudgeConfig> {
    const cacheDir = join(wiring.stateDir, 'rules', 'judge-cache', wiring.judge)
    if (wiring.judge === 'canned') return { via: { kind: 'canned' }, allowed: [], cacheDir, budget: LAUNCH_BUDGET }
    const apiKey = readJudgeCredential(wiring.home)
    return {
      via: apiKey === undefined ? { kind: 'jev' } : { kind: 'jev', apiKey },
      allowed: readAllowedJudges(wiring.home, workspacePath),
      cacheDir,
      budget: LAUNCH_BUDGET
    }
  }

  const service = createLedgerRulesService({
    // Resolved as the gate resolves an agent's directory, so a worktree opened
    // as a workspace reads the rules and ledger its agents feed.
    async lines(opened) {
      const workspacePath = await workspaceOf(opened)
      if (!existsSync(join(workspacePath, RULES_DIR))) return undefined
      watchRules(workspacePath)
      await refresh(workspacePath)
      return ledgerOf(workspacePath).read()
    }
  })

  // The rules as the host now loads them, written to the ledger whenever they
  // differ from what it last recorded, so the board reads them from there.
  function refresh(workspacePath: string, force = false): Promise<void> {
    const last = refreshed.get(workspacePath)
    if (!force && last !== undefined && Date.now() - last.at < CATALOG_EVERY_MS) return last.work
    const work = (async () => {
      try {
        const host = hostOf(workspacePath)
        await host.configure(await judgeOf(workspacePath))
        const rules = await host.load()
        catalogs.set(workspacePath, rules)
        const ledger = ledgerOf(workspacePath)
        const lines = await ledger.read()
        const recorded = [...lines].reverse().find((line) => line.type === 'catalog')
        if (recorded !== undefined && JSON.stringify(recorded.rules) === JSON.stringify(rules)) return
        await ledger.append([{ type: 'catalog', at: new Date().toISOString(), rules }])
        service.changed(workspacePath)
      } catch (cause) {
        wiring.log('rules_load_failed', { workspacePath, message: message(cause) })
      }
    })()
    refreshed.set(workspacePath, { at: Date.now(), work })
    return work
  }

  // Mode is the file's and is hot-loaded: an edit to a rule shows on the
  // board without anyone asking.
  function watchRules(workspacePath: string): void {
    if (watchers.has(workspacePath)) return
    try {
      const watcher = watch(join(workspacePath, RULES_DIR), () => {
        void refresh(workspacePath, true)
      })
      watcher.on('error', () => watcher.close())
      watchers.set(workspacePath, watcher)
    } catch {
      // A folder that cannot be watched is still read on every request.
    }
  }

  function workspaceOf(cwd: string): Promise<string> {
    let found = checkouts.get(cwd)
    if (found === undefined) {
      found = mainCheckoutOf(cwd)
      checkouts.set(cwd, found)
    }
    return found
  }

  const gate = createRuleGate({
    workspaceOf,
    hasRules: (workspacePath) => {
      if (!existsSync(join(workspacePath, RULES_DIR))) return false
      void refresh(workspacePath)
      return true
    },
    host: hostOf,
    ledger: ledgerOf,
    judge: judgeOf,
    catalog: (workspacePath) => catalogs.get(workspacePath) ?? [],
    readText: (path) => readFile(path, 'utf8').catch(() => null),
    appended: (workspacePath) => service.changed(workspacePath),
    onFailure: (cause) => wiring.log('rule_gate_failed', { message: message(cause) })
  })

  return {
    gate,
    service,
    workspaceOf,
    dispose() {
      for (const watcher of watchers.values()) watcher.close()
      for (const host of hosts.values()) host.dispose()
      hosts.clear()
    }
  }
}
