import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createJiti } from 'jiti'
import type { Rule } from '../../../resources/rule-lib/rule.ts'
import type { Scenario } from '../../../resources/rule-lib/test.ts'

// Rule files are a repository's TypeScript, read through jiti with the three
// `crucible:rule` modules aliased to the copies Crucible ships. A rule file
// is an ES module whatever the repository's package.json says, which jiti
// gives for free.

/** Where the shipped rule library lives: the directory holding rule.ts, extract.ts and test.ts. */
export interface RuleLib {
  readonly dir: string
}

export const RULES_DIR = join('.crucible', 'rules')

function jitiFor(lib: RuleLib): ReturnType<typeof createJiti> {
  return createJiti(import.meta.url, {
    moduleCache: false,
    interopDefault: true,
    alias: {
      'crucible:rule/extract': join(lib.dir, 'extract.ts'),
      'crucible:rule/test': join(lib.dir, 'test.ts'),
      'crucible:rule': join(lib.dir, 'rule.ts')
    }
  })
}

/** A rule's name is its file name. */
export function ruleNameOf(file: string): string {
  return basename(file).replace(/\.ts$/, '')
}

/** Every rule file in a checkout's `.crucible/rules/`, test files aside. */
export function ruleFiles(repo: string): string[] {
  const dir = join(repo, RULES_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .sort()
    .map((name) => join(dir, name))
}

export function testFileOf(ruleFile: string): string {
  return ruleFile.replace(/\.ts$/, '.test.ts')
}

/** Changes to either file mean the rule is read again. */
export function stampOf(ruleFile: string): string {
  const stamp = (file: string): string => {
    try {
      const stat = statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return '-'
    }
  }
  return `${stamp(ruleFile)}|${stamp(testFileOf(ruleFile))}`
}

export async function loadRule(file: string, lib: RuleLib): Promise<Rule> {
  const loaded: unknown = await jitiFor(lib).import(file, { default: true })
  return { ...checkRule(file, loaded), name: ruleNameOf(file) }
}

/** The scenarios a rule's test file declares; none when it has no test file. */
export async function loadScenarios(ruleFile: string, lib: RuleLib): Promise<Scenario[]> {
  const testFile = testFileOf(ruleFile)
  try {
    statSync(testFile)
  } catch {
    return []
  }
  const holder = globalThis as { [key: symbol]: Scenario[] | undefined }
  const key = Symbol.for('crucible.rule.scenarios')
  holder[key] = []
  await jitiFor(lib).import(testFile)
  const declared = [...(holder[key] ?? [])]
  holder[key] = []
  return declared
}

/** The floor a default export must meet before it is admitted as a rule. */
function checkRule(file: string, loaded: unknown): Rule {
  const candidate = loaded as Partial<Rule> | null | undefined
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(`${file} does not default-export a rule.`)
  }
  const missing = (['source', 'summary', 'on', 'mode'] as const).filter(
    (field) => typeof candidate[field] !== 'string'
  )
  if (missing.length > 0) throw new Error(`The rule at ${file} has no ${missing.join(', ')}.`)
  if (!['edit', 'bash', 'commit', 'checkpoint'].includes(candidate.on as string)) {
    throw new Error(`The rule at ${file} is on "${candidate.on}", which is not a trigger.`)
  }
  if (!['off', 'shadow', 'enforce'].includes(candidate.mode as string)) {
    throw new Error(`The rule at ${file} has mode "${candidate.mode}", which is not a mode.`)
  }
  for (const fn of ['extract', 'decide', 'feedback'] as const) {
    if (typeof candidate[fn] !== 'function') throw new Error(`The rule at ${file} has no ${fn}().`)
  }
  return candidate as Rule
}
