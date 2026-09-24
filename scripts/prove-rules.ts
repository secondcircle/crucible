// A script rather than a skipped test, which invites someone to un-skip it and
// spend money. It sends one judged item to the real judge through the same
// gate, rule host and ledger the app runs, then reads the firing back the way
// the rules board does. Nothing it prints could carry a credential.
//
// env: CRUCIBLE_STATE_DIR (where the ledger goes; default a fresh temp dir),
//      CRUCIBLE_PROVE_JUDGE (the judge this run may send code to; default jev-1.13.0)
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainCheckoutOf } from '../src/main/rules/checkout'
import { rulesLedgerPath } from '../src/main/rules/ledger'
import { RULES_DIR } from '../src/main/rules/load'
import { judgeCredentialPath, readJudgeCredential } from '../src/main/rules/settings'
import { createRulesSystem } from '../src/main/rules/system'
import { forkRuleHost } from '../src/main/rules/testing/host-fork'
import { formatDollars, formatTook } from '../src/shared/rules/board'
import { FAKE_EDITS } from '../src/shared/rules/fake-edits'

const JUDGE = process.env.CRUCIBLE_PROVE_JUDGE ?? 'jev-1.13.0'
const DEADLINE_MS = 60_000

function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

const workspace = await mainCheckoutOf(process.cwd())
const stateDir = process.env.CRUCIBLE_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'crucible-prove-rules-'))
const sessionId = `prove-rules-${Date.now()}`

print('prove:rules — a firing judged by the real judge, through the app’s own rules path')
print(`date:      ${new Date().toISOString()}`)
print(`node:      ${process.version}`)
print(`workspace: ${workspace}`)
print(`ledger:    ${rulesLedgerPath(stateDir, workspace)}`)
print(`judge:     ${JUDGE}`)

if (!existsSync(join(workspace, RULES_DIR))) {
  print(`FAIL — ${workspace} has no ${RULES_DIR}/`)
  process.exit(1)
}
if (readJudgeCredential(homedir()) === undefined) {
  print(`FAIL — no TYPESAFE_API_KEY in ${judgeCredentialPath(homedir())}`)
  process.exit(1)
}

// Running this script is the allowance: a scratch home reads the one real
// credential through its symlink and allows this workspace one judge, so the
// user's own judges.json is neither needed nor touched.
const home = mkdtempSync(join(tmpdir(), 'crucible-prove-home-'))
mkdirSync(join(home, '.crucible'))
symlinkSync(judgeCredentialPath(homedir()), judgeCredentialPath(home))
writeFileSync(join(home, '.crucible', 'judges.json'), JSON.stringify({ [workspace]: [JUDGE] }))

const system = createRulesSystem({
  stateDir,
  libDir: join(import.meta.dirname, '..', 'resources', 'rule-lib'),
  spawn: forkRuleHost,
  judge: 'jev',
  home,
  log: (event, fields) => print(`[log] ${event} ${JSON.stringify(fields)}`)
})

const catalog = await system.service.board(workspace, { kind: 'workspace' }, 'all')
for (const row of catalog.rules) {
  const { rule } = row
  print(`rule:      ${rule.name} · ${rule.mode}${rule.running === rule.mode ? '' : ` (running ${rule.running})`}${rule.held ? ` · ${rule.held.message}` : ''}`)
}
print('')

const steered: string[] = []
const watch = system.gate.watch(
  { kind: 'session', sessionId, cwd: workspace },
  { steer: (note) => steered.push(note.text) }
)
await watch.turnStarted()
for (const [at, edit] of FAKE_EDITS.entries()) {
  const callId = `${sessionId}-edit-${at + 1}`
  const started = Date.now()
  const output = await edit.run(watch, callId)
  print(`[${callId}] ${edit.summary} → returned in ${formatTook(Date.now() - started)}`)
  print(`  tool result: ${JSON.stringify(output)}`)
}
await watch.checkpoint('turn-end')

// A judged item that missed its tool result is written when the judge answers.
const deadline = Date.now() + DEADLINE_MS
let firings = await system.service.firings(workspace, { kind: 'session', sessionId })
while (!firings.some((view) => view.firing.judged !== undefined) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  firings = await system.service.firings(workspace, { kind: 'session', sessionId })
}
for (const text of steered) print(`  steered: ${JSON.stringify(text)}`)

print('')
let spent = 0
for (const { firing, came, reaction } of [...firings].reverse()) {
  print(`firing ${firing.id}`)
  print(`  rule ${firing.rule} · ${firing.mode} · ${firing.action} · delivery ${firing.delivery} · took ${formatTook(firing.tookMs)}`)
  print(`  at ${firing.item?.path ?? firing.where}:${firing.item?.line ?? ''} key ${firing.item?.key ?? '—'}`)
  if (firing.skip !== undefined) print(`  skipped: ${firing.skip.kind} · ${firing.skip.message}`)
  if (firing.judged !== undefined) {
    const { model, answers, tokens, dollars, ms, cached } = firing.judged
    print(`  judged by ${model} · ${tokens} tokens · ${formatDollars(dollars)} · ${formatTook(ms)}${cached ? ' · cached' : ''}`)
    print(`  answers ${JSON.stringify(answers)}`)
    if (!cached) spent += dollars
  }
  if (firing.read !== undefined) print(`  read: ${JSON.stringify(firing.read)}`)
  if (came !== undefined) print(`  outcome: ${came.outcome}${came.how === undefined ? '' : ` · ${came.how}`}`)
  if (reaction?.said !== undefined) print(`  next words: ${JSON.stringify(reaction.said)}`)
}

const judged = firings.filter((view) => view.firing.judged !== undefined && view.firing.skip === undefined)
print('')
print(`spent:     ${formatDollars(spent)}`)
print(
  judged.length > 0
    ? `PASS — ${judged.length} firing${judged.length === 1 ? '' : 's'} judged by ${JUDGE} and read back from the ledger`
    : 'FAIL — no firing was judged'
)

system.dispose()
process.exit(judged.length > 0 ? 0 : 1)
