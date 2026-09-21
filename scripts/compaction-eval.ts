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
  mkdirSync(out, { recursive: true })

  let instruction: string | undefined
  const started = Date.now()
  const rig = await harness(file, dry ? 'plan' : 'compact', async (asked, signal, warm) => {
    instruction = asked
    writeFileSync(join(out, 'instruction.md'), asked)
    print(`instruction: ${estimateTokens(asked).toLocaleString('en-US')} tok, written to ${out}/instruction.md`)
    if (dry) return '<trajectory>\n(dry run: the model was not asked)\n</trajectory>\n<strike></strike>'
    print('asking the model on the whole conversation…')
    return warm(asked, signal)
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
    if (!dry) {
      // The compacted copy is what `probe` binds to.
      copyFileSync(rig.sessionFile, join(out, 'compacted.jsonl'))
      writeFileSync(join(out, 'source.md'), renderReadable(await transcriptOf(file)))
    }
    print('')
    print(`before:  ${record.tokensBefore.toLocaleString('en-US')} tok`)
    print(`after:   ${record.tokensAfter.toLocaleString('en-US')} tok (compaction text ${estimateTokens(text).toLocaleString('en-US')})`)
    print(`took:    ${seconds}s`)
    print(`wrote:   ${out}/compaction.md${dry ? '' : `, ${out}/compacted.jsonl, ${out}/source.md`}`)
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
