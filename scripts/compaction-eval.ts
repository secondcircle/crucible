// The compaction eval: the production compaction, run against a session file
// picked from history, and then a fresh agent on the compacted conversation
// answering questions whose answers the source conversation holds.
//
// A script rather than a test, like `prove:sdk`, because two of its four
// subcommands spend money, and an eval spends by nature: what it measures is
// how the model writes the compaction and how the model reads it, and neither
// exists without a model. The source file is never written to; every
// subcommand works on a copy.
//
//   read    <session.jsonl>                     the conversation, readable, free
//   plan    <session.jsonl> --out <dir>         what the model would be asked, free
//   compact <session.jsonl> --out <dir>         the production compaction, paid
//   probe   <dir> <probes.json>                 questions against the compacted copy, paid
//
// `plan` and `compact` take `--split <turn>` to compact twice: the branch is
// cut before that user turn, the first part compacted, the rest appended
// onto the compaction and compacted again. That is the second compaction a
// long session gets in production, the one that carries the first's skeleton
// and rewrites its account, and no session in history has grown far enough
// past its first compaction to have had one.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { AdapterEvent, ConversationAdapter } from '../src/shared/agent/adapter'
import type { TranscriptItem } from '../src/shared/agent/port'
import { estimateTokens } from '../src/shared/compaction/window.ts'
import { createSdkAdapter } from '../src/main/agent/sdk-adapter.ts'
import { storedCompactionOf } from '../src/main/agent/sdk-compaction.ts'
import { branchHistory, toTranscript, type StoredMessage } from '../src/main/agent/sdk-transcript.ts'
import { createPanelModel, memoryPanelPersistence } from '../src/main/panel/model.ts'
import { shippedSystemPrompt } from '../src/main/shipped.ts'

const APP = join(import.meta.dirname, '..')
const SESSION = 'compaction-eval'

// A probe is one fresh turn on the compacted conversation. `expect` is what
// the source conversation says, written by whoever read it; the reply is
// judged against it by a reader, not by code.
interface Probe {
  readonly ask: string
  readonly expect: string
}

function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

function headerCwd(sessionFile: string): string {
  const first = readFileSync(sessionFile, 'utf8').split('\n')[0] ?? ''
  const header = JSON.parse(first) as { cwd?: string }
  if (typeof header.cwd !== 'string') fail(`${sessionFile} has no session header with a cwd.`)
  return header.cwd
}

/** The file copied where nothing else will read it, so the source is never written to. */
function scratchCopy(sessionFile: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crucible-compaction-eval-${label}-`))
  const copy = join(dir, basename(sessionFile))
  copyFileSync(sessionFile, copy)
  return copy
}

async function sdk(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
  return import('@earendil-works/pi-coding-agent')
}

interface StoredEntry {
  readonly type?: string
  readonly id?: string
  readonly parentId?: string | null
  readonly message?: { readonly role?: string }
}

// The session's branch as raw lines: the header, then every entry from the
// root to the leaf in order. π takes the last entry of the file as the leaf,
// so a file of the branch alone is the same conversation.
function branchLines(sessionFile: string): { header: string; path: string[] } {
  const lines = readFileSync(sessionFile, 'utf8').split('\n').filter((line) => line !== '')
  const byId = new Map<string, { entry: StoredEntry; line: string }>()
  let leaf: StoredEntry | undefined
  for (const line of lines) {
    const entry = JSON.parse(line) as StoredEntry
    if (entry.id === undefined) continue
    byId.set(entry.id, { entry, line })
    leaf = entry
  }
  const path: string[] = []
  for (let held = leaf === undefined ? undefined : byId.get(leaf.id ?? ''); held !== undefined; ) {
    path.unshift(held.line)
    held = held.entry.parentId ? byId.get(held.entry.parentId) : undefined
  }
  return { header: lines[0] ?? '', path }
}

// The branch cut before its Nth user turn, numbered as `read` numbers them.
function splitAtTurn(sessionFile: string, turn: number): { before: string[]; after: string[]; header: string } {
  const { header, path } = branchLines(sessionFile)
  let seen = 0
  const at = path.findIndex((line) => {
    const entry = JSON.parse(line) as StoredEntry
    if (entry.type === 'message' && entry.message?.role === 'user') seen += 1
    return seen === turn
  })
  if (at <= 0) fail(`The branch has no user turn ${turn} to split before.`)
  return { header, before: path.slice(0, at), after: path.slice(at) }
}

// The rest of the branch hung off the compaction that now ends the file, so
// the leaf's chain runs through it exactly as it would had the compaction
// happened live.
function appendAfterCompaction(sessionFile: string, after: readonly string[]): void {
  const lines = readFileSync(sessionFile, 'utf8').split('\n').filter((line) => line !== '')
  const last = JSON.parse(lines[lines.length - 1] ?? 'null') as StoredEntry | null
  if (last?.type !== 'compaction' || last.id === undefined) fail('The compacted file does not end on a compaction.')
  const [first, ...rest] = after
  if (first === undefined) return
  const reparented = JSON.stringify({ ...(JSON.parse(first) as object), parentId: last.id })
  writeFileSync(sessionFile, [...lines, reparented, ...rest].join('\n') + '\n')
}

// Every message on the branch, in the transcript's own shape. The whole path,
// not the model's view of it: what a reader needs is what was said.
async function transcriptOf(sessionFile: string): Promise<readonly TranscriptItem[]> {
  const pi = await sdk()
  const manager = pi.SessionManager.open(sessionFile)
  const { messages, compactions } = branchHistory(
    manager.getBranch(),
    pi.sessionEntryToContextMessages as (entry: never) => readonly StoredMessage[],
    (details) => storedCompactionOf(details)?.record
  )
  return toTranscript(messages, undefined, undefined, compactions)
}

// The conversation as a person reads it: what was said kept whole, every
// tool call one line, thinking dropped. What a reader compares the
// compaction against.
function renderReadable(items: readonly TranscriptItem[]): string {
  const out: string[] = []
  let turn = 0
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        turn += 1
        out.push(`\n## Turn ${turn} · user\n\n${item.text}`)
        if (item.images !== undefined) out.push(`\n(${item.images.length} image(s) attached)`)
        break
      case 'assistant':
        out.push(`\n### agent\n\n${item.markdown}`)
        break
      case 'tool':
        out.push(
          `- [${item.name}] ${firstLine(item.summary)} → ${item.ok ? 'ok' : 'failed'} · ${estimateTokens(item.output).toLocaleString('en-US')} tok`
        )
        break
      case 'bashRun':
        out.push(`- [bash run] ${firstLine(item.command)}`)
        break
      case 'summary':
        out.push(`\n### compaction (${item.compaction?.trigger ?? 'branch summary'})\n\n${item.text}`)
        break
      case 'error':
        out.push(`- [error] ${firstLine(item.message)}`)
        break
      case 'thinking':
      case 'cacheMiss':
      case 'stopped':
        break
    }
  }
  return out.join('\n')
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

interface Harness {
  readonly adapter: ConversationAdapter
  readonly sessionFile: string
  readonly workspacePath: string
  /** Waits for the next terminal event of a turn and answers with what it said and did. */
  readonly turn: (text: string) => Promise<{ reply: string; calls: string[]; usage?: string }>
  readonly stop: () => Promise<void>
}

// The app's own adapter on a scratch copy of the session, composed as
// `prove:sdk` composes it: the shipped system prompt, the panel tools, and
// none of the tools that need a shell behind them.
async function harness(
  sessionFile: string,
  label: string,
  askCompaction?: Parameters<typeof createSdkAdapter>[0]['askCompaction']
): Promise<Harness> {
  const workspacePath = headerCwd(sessionFile)
  const copy = scratchCopy(sessionFile, label)
  const adapter = createSdkAdapter({
    panel: createPanelModel({ persistence: memoryPanelPersistence() }),
    systemPrompt: shippedSystemPrompt(APP),
    askCompaction
  })
  const binding = await adapter.bind({ sessionId: SESSION, workspacePath, token: copy })
  if (!binding.restored) fail(`The session at ${sessionFile} could not be restored.`)
  print(`session: ${copy}`)
  print(`cwd:     ${workspacePath}`)
  print(`model:   ${binding.model ?? 'none'} · thinking ${binding.thinkingLevel ?? 'none'}`)

  let turns = 0
  return {
    adapter,
    sessionFile: copy,
    workspacePath,
    turn: (text) =>
      new Promise((resolveTurn, reject) => {
        turns += 1
        const turnId = `${SESSION}-turn-${turns}`
        let reply = ''
        const calls: string[] = []
        let usage: string | undefined
        const off = adapter.onEvent((event: AdapterEvent) => {
          if ('turnId' in event && event.turnId !== turnId) return
          switch (event.type) {
            case 'text_delta':
              reply += event.delta
              return
            case 'tool_started':
              calls.push(`${event.name} ${firstLine(event.summary)}`)
              return
            case 'usage':
              usage = `${event.usedTokens.toLocaleString('en-US')} / ${event.contextWindow.toLocaleString('en-US')}`
              return
            case 'turn_ended':
              off()
              resolveTurn({ reply, calls, usage })
              return
            case 'turn_cancelled':
              off()
              reject(new Error('the turn was cancelled'))
              return
            case 'turn_error':
              off()
              reject(new Error(event.message))
          }
        })
        adapter.prompt(SESSION, turnId, text).catch(reject)
      }),
    stop: async () => {
      adapter.dispose()
      await new Promise((settle) => setTimeout(settle, 250))
    }
  }
}

async function read(args: readonly string[]): Promise<void> {
  const file = args[0] ?? fail('read needs a session file.')
  const text = renderReadable(await transcriptOf(resolve(file)))
  const out = flag(args, '--out')
  if (out === undefined) print(text)
  else {
    writeFileSync(out, text)
    print(`wrote ${out} (${estimateTokens(text).toLocaleString('en-US')} tok)`)
  }
}

// One compaction, real or dry. Dry answers the model's part with a
// placeholder and strikes nothing, so everything mechanical — the cut, the
// skeleton, the trim, the window — is exactly what production would produce
// around a real account.
async function compactCommand(args: readonly string[], dry: boolean): Promise<void> {
  const file = resolve(args[0] ?? fail('a session file is needed.'))
  const out = flag(args, '--out') ?? fail('--out <dir> is needed.')
  const split = flag(args, '--split')
  mkdirSync(out, { recursive: true })

  let subject = file
  if (split !== undefined) {
    const turn = Number(split)
    if (!Number.isInteger(turn) || turn < 2) fail('--split needs a user turn number of 2 or more.')
    const { header, before, after } = splitAtTurn(file, turn)
    const first = join(mkdtempSync(join(tmpdir(), 'crucible-compaction-eval-split-')), basename(file))
    writeFileSync(first, [header, ...before].join('\n') + '\n')
    print(`stage 1: the branch before turn ${turn} (${before.length} entries)`)
    const compacted = await compactOnce(first, join(out, 'stage1'), dry)
    appendAfterCompaction(compacted, after)
    // π reads a window's size off the last assistant message's usage, and the
    // appended messages carry the usage of the session they came from, so
    // stage 2's own `tokensBefore` is the whole original session. What the
    // window really holds is stage 1's result plus what was appended.
    const stage1 = JSON.parse(readFileSync(join(out, 'stage1', 'record.json'), 'utf8')) as { tokensAfter: number }
    const appended = after.reduce((total, line) => {
      const entry = JSON.parse(line) as StoredEntry
      return entry.type === 'message' ? total + estimateTokens(JSON.stringify(entry.message)) : total
    }, 0)
    print(`\nstage 2: turn ${turn} onward (${after.length} entries) appended onto the compaction`)
    print(`window ≈ ${(stage1.tokensAfter + appended).toLocaleString('en-US')} tok (stage 1 left ${stage1.tokensAfter.toLocaleString('en-US')}; π's own 'before' below repeats the source's last usage)`)
    subject = compacted
  }
  const compacted = await compactOnce(subject, out, dry)
  if (!dry) {
    // The compacted copy is what `probe` binds to; the source, readable, is
    // what a reader writes probes from and judges the replies against.
    copyFileSync(compacted, join(out, 'compacted.jsonl'))
    writeFileSync(join(out, 'source.md'), renderReadable(await transcriptOf(file)))
    print(`wrote:   ${out}/compacted.jsonl, ${out}/source.md`)
  }
}

/** The production compaction on a copy of `file`; answers with the compacted copy. */
async function compactOnce(file: string, out: string, dry: boolean): Promise<string> {
  mkdirSync(out, { recursive: true })
  let instruction: string | undefined
  const started = Date.now()
  const rig = await harness(file, dry ? 'plan' : 'compact', async (asked, signal, warm) => {
    instruction = asked
    writeFileSync(join(out, 'instruction.md'), asked)
    print(`instruction: ${estimateTokens(asked).toLocaleString('en-US')} tok, written to ${out}/instruction.md`)
    if (dry) return '<trajectory>\n(dry run: the model was not asked)\n</trajectory>\n<strike></strike>'
    print('asking the model on the whole conversation…')
    const reply = await warm(asked, signal)
    // The answer as the model wrote it, strike list included: the compaction
    // text shows what survived, not which numbers were named.
    writeFileSync(join(out, 'reply.md'), reply)
    return reply
  })

  let text: string | undefined
  const off = rig.adapter.onEvent((event) => {
    if (event.type === 'compacted' && event.compaction !== undefined) text = event.compaction.text
  })
  try {
    const record = await rig.adapter.compact(SESSION, 'threshold')
    off()
    if (record === undefined || text === undefined) fail('Nothing was compacted.')
    const seconds = Math.round((Date.now() - started) / 1000)
    writeFileSync(join(out, 'compaction.md'), text)
    writeFileSync(
      join(out, 'record.json'),
      JSON.stringify(
        {
          source: file,
          dry,
          seconds,
          instructionTokens: instruction === undefined ? 0 : estimateTokens(instruction),
          compactionTokens: estimateTokens(text),
          ...record
        },
        null,
        2
      )
    )
    print('')
    print(`before:  ${record.tokensBefore.toLocaleString('en-US')} tok`)
    print(`after:   ${record.tokensAfter.toLocaleString('en-US')} tok (compaction text ${estimateTokens(text).toLocaleString('en-US')})`)
    print(`took:    ${seconds}s`)
    print(`wrote:   ${out}/compaction.md`)
    return rig.sessionFile
  } finally {
    await rig.stop()
  }
}

// Every probe is its own fresh copy of the compacted session, so no probe's
// answer is in another's window and the order does not matter.
async function probe(args: readonly string[]): Promise<void> {
  const dir = resolve(args[0] ?? fail('probe needs the compaction directory.'))
  const probesFile = resolve(args[1] ?? fail('probe needs a probes file.'))
  const probes = JSON.parse(readFileSync(probesFile, 'utf8')) as readonly Probe[]
  const compacted = join(dir, 'compacted.jsonl')
  const only = flag(args, '--only')
  const report: string[] = [`# Probes against ${compacted}`, '']

  for (const [index, item] of probes.entries()) {
    if (only !== undefined && String(index + 1) !== only) continue
    print(`\n[${index + 1}/${probes.length}] ${item.ask}`)
    const rig = await harness(compacted, `probe-${index + 1}`)
    try {
      const { reply, calls, usage } = await rig.turn(item.ask)
      print(reply)
      report.push(
        `## ${index + 1}. ${item.ask}`,
        '',
        `**Expected (from the source):** ${item.expect}`,
        '',
        calls.length === 0 ? '_No tool calls._' : `Tool calls:\n${calls.map((call) => `- ${call}`).join('\n')}`,
        '',
        usage === undefined ? '' : `Window: ${usage}`,
        '',
        '**Reply:**',
        '',
        reply,
        '',
        '**Verdict:** _(fill in: pass / partial / fail, and why)_',
        '',
        '---',
        ''
      )
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      print(`failed: ${message}`)
      report.push(`## ${index + 1}. ${item.ask}`, '', `**Failed:** ${message}`, '', '---', '')
    } finally {
      await rig.stop()
    }
    writeFileSync(join(dir, 'probes.md'), report.join('\n'))
  }
  print(`\nwrote ${dir}/probes.md`)
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'read':
    await read(rest)
    break
  case 'plan':
    await compactCommand(rest, true)
    break
  case 'compact':
    await compactCommand(rest, false)
    break
  case 'probe':
    await probe(rest)
    break
  default:
    fail('usage: compaction-eval <read|plan|compact|probe> …')
}
process.exit(0)
