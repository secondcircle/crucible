/**
 * `npm run prove:sdk` — the one-shot proof that the SDK adapter really talks to
 * the real π SDK (LF-1).
 *
 * It is committed, run only with explicit human authorization, and never part
 * of `npm test`: a skipped test invites CI or an agent to un-skip it and spend
 * money, while this script requires a deliberate operator decision. The human
 * may run it or direct an agent to execute and record it. One prompt, one turn,
 * no caller retry loop, so the spend is one short completion — the SDK may
 * still retry a transient provider failure by itself.
 *
 * It drives the adapter contract exactly as main does: bind a session to a
 * workspace folder, subscribe, prompt, watch the events. It passes only if it
 * sees `turn_started`, then at least one `text_delta`, then `turn_ended`,
 * within 60 seconds; anything else — a `turn_error`, a `turn_cancelled`, a
 * silent turn, the deadline — exits non-zero. Its stdout is what goes into the
 * evidence file, so it prints the model the adapter actually chose and the
 * date, and nothing that could carry a credential.
 */
import type { AdapterEvent } from '../src/shared/agent/adapter'
import { createSdkAdapter } from '../src/main/agent/sdk-adapter.ts'

const PROMPT = 'Say hello in five words. Do not use any tools.'
const DEADLINE_MS = 60_000
const SESSION = 'prove-sdk'
const TURN = 'prove-sdk-turn'

function print(line: string): void {
  process.stdout.write(`${line}\n`)
}

const adapter = createSdkAdapter()

print('prove:sdk — Crucible SDK adapter against the real π SDK')
print(`date:   ${new Date().toISOString()}`)
print(`node:   ${process.version}`)
print(`cwd:    ${process.cwd()}`)
print(`prompt: ${JSON.stringify(PROMPT)}`)

const binding = await adapter.bind({ sessionId: SESSION, workspacePath: process.cwd() })
print(`model:  ${binding.model ?? 'none reported'}`)
print(`think:  ${binding.thinkingLevel ?? 'none reported'}`)
print('')

let started = false
let deltas = 0
let reply = ''

const outcome = new Promise<{ ok: boolean; why: string }>((resolve) => {
  const deadline = setTimeout(() => {
    resolve({ ok: false, why: `no terminal event within ${DEADLINE_MS / 1000}s` })
  }, DEADLINE_MS)

  adapter.onEvent((event: AdapterEvent) => {
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
      case 'thinking_delta':
        print(`[${event.turnId}] thinking_delta (${event.delta.length} chars)`)
        return
      case 'tool_started':
        print(`[${event.turnId}] tool_started ${event.name} ${event.summary}`)
        return
      case 'tool_ended':
        print(`[${event.turnId}] tool_ended ${event.callId} ok=${event.ok}`)
        return
      case 'usage':
        print(`[usage] ${event.usedTokens} / ${event.contextWindow}`)
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
      case 'turn_cancelled':
        print(`[${event.turnId}] turn_cancelled`)
        clearTimeout(deadline)
        resolve({ ok: false, why: 'the turn was cancelled' })
        return
      case 'turn_error':
        print(`[${event.turnId}] turn_error ${event.message}`)
        clearTimeout(deadline)
        resolve({ ok: false, why: `the turn failed: ${event.message}` })
    }
  })
})

void adapter.prompt(SESSION, TURN, PROMPT)

const { ok, why } = await outcome

print('')
print(`reply:  ${JSON.stringify(reply)}`)
print(ok ? `PASS — ${why}` : `FAIL — ${why}`)

// Whatever is still running is stopped rather than left running unseen: the
// same disposal a window's close takes.
adapter.dispose()
await new Promise((resolve) => setTimeout(resolve, 250))
process.exit(ok ? 0 : 1)
