import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mainCheckoutOf } from './checkout.ts'
import { runRules, USAGE } from './runner.ts'

// The `crucible` command an agent's bash reaches: `crucible rules …`. Main
// puts a shim for it on every agent's PATH, which hands in where the shipped
// rule library and Crucible's state directory are.
//
// env: CRUCIBLE_RULE_LIB, CRUCIBLE_STATE_DIR

// Built, this script sits two levels under the package root; from source,
// three. Either way the shipped library is the nearest one above it.
function shippedLibNear(script: string): string {
  for (let dir = dirname(script); dir !== dirname(dir); dir = dirname(dir)) {
    const lib = join(dir, 'resources', 'rule-lib')
    if (existsSync(join(lib, 'rule.ts'))) return lib
  }
  throw new Error('No resources/rule-lib above this script: set CRUCIBLE_RULE_LIB.')
}

async function main(): Promise<number> {
  const [area, ...rest] = process.argv.slice(2)
  if (area !== 'rules') {
    process.stdout.write(`${USAGE}\n`)
    return 2
  }
  const home = homedir()
  const cwd = process.cwd()
  return runRules(rest, {
    cwd,
    lib: { dir: process.env.CRUCIBLE_RULE_LIB ?? shippedLibNear(process.argv[1] ?? cwd) },
    home,
    stateDir: process.env.CRUCIBLE_STATE_DIR ?? join(home, '.crucible', 'rules-state'),
    workspace: await mainCheckoutOf(cwd),
    out: (line) => process.stdout.write(`${line}\n`)
  })
}

void main().then((code) => process.exit(code))
