/**
 * `npm run prove:sdk` — the one-shot proof that the SDK adapter really talks to
 * the real π SDK (D12).
 *
 * It is committed, run only with explicit human authorization, and never part
 * of `npm test`: a skipped test invites CI or an agent to un-skip it and spend
 * money, while this script requires a deliberate operator decision. The human
 * may run it or direct an agent to execute and record it. One turn, tools off,
 * no caller retry loop, so the spend is one short completion (the SDK may still
 * retry transient provider failures internally).
 *
 * It passes only if it sees `turn_started`, then at least one `text_delta`,
 * then `turn_ended`, within 60 seconds; anything else — an `error` event, a
 * silent turn, the deadline — exits non-zero. Its stdout is what goes into the
 * evidence file, so it prints the model id and the date and nothing that could
 * carry a credential: the prompt, the port events, the reply text.
 */
import { createSdkAdapter, SDK_MODEL } from '../src/main/agent/sdk-adapter.ts'
import type { PortEvent } from '../src/shared/agent/port'

const PROMPT = 'Say hello in five words.'
const DEADLINE_MS = 60_000

function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

const adapter = createSdkAdapter()

print(`prove:sdk — Crucible SDK adapter against the real π SDK`)
print(`date:   ${new Date().toISOString()}`)
print(`model:  ${SDK_MODEL.provider}/${SDK_MODEL.id}`)
print(`node:   ${process.version}`)
print(`prompt: ${JSON.stringify(PROMPT)}`)
print('')

let started = false
let deltas = 0
let reply = ''

const outcome = new Promise<{ ok: boolean; why: string }>((resolve) => {
  const deadline = setTimeout(() => {
    resolve({ ok: false, why: `no terminal event within ${DEADLINE_MS / 1000}s` })
  }, DEADLINE_MS)

  adapter.onEvent((event: PortEvent) => {
    switch (event.type) {
      case 'turn_started':
        started = true
        print(`[${event.turnId}] turn_started`)
        return
      case 'text_delta':
        deltas += 1
        reply += event.delta
        print(`[${event.turnId}] text_delta ${JSON.stringify(event.delta)}`)
        return
      case 'turn_ended':
        print(`[${event.turnId}] turn_ended`)
        clearTimeout(deadline)
        resolve(
          started && deltas > 0
            ? { ok: true, why: `turn_started, ${deltas} text_delta, turn_ended` }
            : { ok: false, why: 'the turn ended without streaming any text' }
        )
        return
      case 'error':
        print(`[${event.turnId}] error (${event.code}) ${event.message}`)
        clearTimeout(deadline)
        resolve({ ok: false, why: `the turn failed: ${event.message}` })
    }
  })
})

const turnId = await adapter.prompt(PROMPT)
print(`prompt accepted as ${turnId}`)

const { ok, why } = await outcome

print('')
print(`reply:  ${JSON.stringify(reply)}`)
print(ok ? `PASS — ${why}` : `FAIL — ${why}`)

// Whatever is still running is stopped rather than left running unseen: the
// same disposal the window's close takes.
adapter.dispose()
await new Promise((resolve) => setTimeout(resolve, 250))
process.exit(ok ? 0 : 1)
