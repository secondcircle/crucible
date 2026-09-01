// @vitest-environment node
//
// The four research verbs against a scripted process seam: no spawn, no
// network, no credential, and no clock to wait on.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REDACTION, type Redacted } from '../../shared/workspace/research'
import { createResearchOperations, type ResearchOperations } from './research'
import {
  researchEnv,
  type ProcessOutcome,
  type ResearchAttempt,
  type ResearchProcesses
} from './research-processes'

function fixture(name: string): string {
  return readFileSync(new URL(`./research-fixtures/${name}`, import.meta.url), 'utf8')
}

const CONNECTED: ProcessOutcome = {
  kind: 'exited',
  code: 0,
  stdout: fixture('doctor-connected.json'),
  stderr: ''
}

const NOT_CONNECTED: ProcessOutcome = {
  kind: 'exited',
  code: 1,
  stdout: fixture('doctor-not-connected.json'),
  stderr: ''
}

const DONE: ProcessOutcome = { kind: 'exited', code: 0, stdout: '', stderr: '' }

interface Scripted extends ResearchProcesses {
  /** Every capture, in order: the arguments and the timeout it was given. */
  readonly captured: ReadonlyArray<{ readonly args: readonly string[]; readonly timeoutMs: number }>
  /** Every attempt begun, oldest first. */
  readonly begun: ReadonlyArray<{ readonly args: readonly string[] }>
  /** What the next capture answers; the last one stands for the rest. */
  answers: ProcessOutcome[]
  /** Ends the attempt at that position the way the process would have. */
  finish(index: number, outcome: ProcessOutcome): void
  /** What the attempt at that position printed. */
  say(index: number, chunk: string): void
}

function scripted(answers: ProcessOutcome[] = [NOT_CONNECTED]): Scripted {
  const captured: { args: readonly string[]; timeoutMs: number }[] = []
  const begun: { args: readonly string[] }[] = []
  const attempts: {
    settle(outcome: ProcessOutcome): void
    output(chunk: string): void
    cancelled: boolean
  }[] = []

  const processes: Scripted = {
    captured,
    begun,
    answers,

    async capture(args, timeoutMs) {
      captured.push({ args, timeoutMs })
      return processes.answers.length > 1
        ? (processes.answers.shift() as ProcessOutcome)
        : (processes.answers[0] ?? DONE)
    },

    begin(args, onOutput): ResearchAttempt {
      begun.push({ args })
      let settle: (outcome: ProcessOutcome) => void = () => {}
      const finished = new Promise<ProcessOutcome>((resolve) => {
        settle = resolve
      })
      const mine = { settle, output: onOutput, cancelled: false }
      attempts.push(mine)
      return {
        finished,
        cancel(): void {
          mine.cancelled = true
          mine.settle({ kind: 'cancelled' })
        }
      }
    },

    finish(index, outcome) {
      const attempt = attempts[index]
      if (attempt === undefined) throw new Error(`no attempt ${index}`)
      attempt.settle(outcome)
    },

    say(index, chunk) {
      const attempt = attempts[index]
      if (attempt === undefined) throw new Error(`no attempt ${index}`)
      attempt.output(chunk)
    }
  }

  return processes
}

function operations(processes: ResearchProcesses): {
  readonly ops: ResearchOperations
  readonly said: readonly Redacted[]
} {
  const said: Redacted[] = []
  return {
    ops: createResearchOperations({ processes, onOutput: (chunk) => said.push(chunk) }),
    said
  }
}

describe('reading the status', () => {
  it('asks the CLI for its own machine-readable answer, under a timeout', async () => {
    const processes = scripted([CONNECTED])
    const { ops } = operations(processes)

    await expect(ops.status()).resolves.toEqual({
      kind: 'signedIn',
      version: '1.23.3',
      credits: 12_500
    })
    expect(processes.captured[0]?.args).toEqual(['doctor', '--json'])
    expect(processes.captured[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it('turns what the process did into a status rather than rejecting', async () => {
    const { ops } = operations(scripted([{ kind: 'noBinary' }]))

    await expect(ops.status()).resolves.toEqual({ kind: 'notInstalled' })
  })
})

describe('connecting', () => {
  it('starts the browser login with no key at all', async () => {
    const processes = scripted([CONNECTED])
    const { ops } = operations(processes)

    const attempt = ops.connect()
    expect(processes.begun[0]?.args).toEqual(['login', '--browser'])

    processes.finish(0, DONE)
    // The status read after it is the one source of truth for the rows.
    await expect(attempt).resolves.toEqual({
      kind: 'settled',
      status: { kind: 'signedIn', version: '1.23.3', credits: 12_500 }
    })
  })

  it('hands a pasted key to the non-interactive login and to nothing else', async () => {
    const processes = scripted([CONNECTED])
    const { ops } = operations(processes)

    const attempt = ops.connect('fc-pasted-by-a-person')
    processes.finish(0, DONE)
    await attempt

    expect(processes.begun).toEqual([
      { args: ['login', '--api-key', 'fc-pasted-by-a-person'] }
    ])
    // Not in the status read that followed, and nowhere else either.
    for (const { args } of processes.captured) {
      expect(args.join(' ')).not.toContain('fc-pasted-by-a-person')
    }
  })

  it('streams what the CLI printed, redacted', async () => {
    const processes = scripted()
    const { ops, said } = operations(processes)

    void ops.connect()
    processes.say(0, '\nOpening browser for authorization…\n')
    processes.say(0, 'visit: https://example.invalid/cli-auth?key=fc-9f2a7b0c4d5e6f70\n')

    expect(said[0]).toBe('\nOpening browser for authorization…\n')
    expect(said[1]).toBe(`visit: https://example.invalid/cli-auth?key=${REDACTION}\n`)
  })

  it('reports the CLI’s own refusal, redacted, when the login failed', async () => {
    const processes = scripted()
    const { ops } = operations(processes)

    const attempt = ops.connect('fc-nope')
    processes.finish(0, {
      kind: 'exited',
      code: 1,
      stdout: '',
      stderr: 'Error: Invalid API key format. API keys should start with "fc-"\n'
    })

    await expect(attempt).resolves.toEqual({
      kind: 'refused',
      message: 'Error: Invalid API key format. API keys should start with "fc-"'
    })
  })
})

describe('an attempt ended from outside', () => {
  it('ends the first when a second starts, and reports only the second', async () => {
    const processes = scripted([CONNECTED])
    const { ops } = operations(processes)

    const first = ops.connect()
    const second = ops.connect('fc-pasted-by-a-person')

    await expect(first).resolves.toEqual({ kind: 'abandoned' })
    processes.finish(1, DONE)
    await expect(second).resolves.toMatchObject({ kind: 'settled' })
  })

  it('says nothing for a cancelled attempt, whatever the process then did', async () => {
    const processes = scripted()
    const { ops } = operations(processes)

    const attempt = ops.connect()
    await ops.cancelConnect()

    await expect(attempt).resolves.toEqual({ kind: 'abandoned' })
  })

  it('is harmless with no attempt waiting', async () => {
    const { ops } = operations(scripted())

    await expect(ops.cancelConnect()).resolves.toBeUndefined()
  })

  it('keeps a superseded attempt out of the dialog it no longer owns', async () => {
    const processes = scripted()
    const { ops, said } = operations(processes)

    void ops.connect()
    void ops.connect()
    processes.say(0, 'the first attempt, still dying\n')
    processes.say(1, 'the second attempt\n')

    expect(said).toEqual(['the second attempt\n'])
  })
})

describe('logging out', () => {
  it('clears the credential and answers with the status after it', async () => {
    const processes = scripted([DONE, NOT_CONNECTED])
    const { ops } = operations(processes)

    await expect(ops.disconnect()).resolves.toEqual({
      kind: 'settled',
      status: { kind: 'signedOut', version: '1.23.3' }
    })
    expect(processes.captured.map((call) => call.args)).toEqual([
      ['logout'],
      ['doctor', '--json']
    ])
  })

  it('reports a refusal in the CLI’s words, and reads no status after it', async () => {
    const processes = scripted([{ kind: 'exited', code: 1, stdout: '', stderr: 'nope\n' }])
    const { ops } = operations(processes)

    await expect(ops.disconnect()).resolves.toEqual({ kind: 'refused', message: 'nope' })
    expect(processes.captured).toHaveLength(1)
  })
})

describe('the environment every research call runs in', () => {
  it('drops every FIRECRAWL_ variable and keeps everything else', () => {
    const child = researchEnv({
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      FIRECRAWL_API_KEY: 'fc-exported-in-a-shell-somewhere',
      FIRECRAWL_API_URL: 'https://api.example.invalid',
      FIRECRAWL_NO_TELEMETRY: '1'
    })

    expect(child).toEqual({ PATH: '/usr/bin', HOME: '/Users/someone' })
  })

  it('leaves a variable that merely mentions the vendor alone', () => {
    expect(researchEnv({ MY_FIRECRAWL_NOTES: 'kept' })).toEqual({ MY_FIRECRAWL_NOTES: 'kept' })
  })
})
