import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { AgentAdapter } from '../../shared/agent/port'
import type { LogSink } from '../log/sink'
import { withLogging } from './with-logging'

/**
 * Which adapter a launch puts behind the agent port — the launch flavor (D5).
 *
 * This is the only reader of `CRUCIBLE_AGENT` — the environment variable is
 * read here and nowhere else, not even by the composition root that calls this,
 * so "which flavor is this launch?" is one module's question and no caller has
 * to know the variable exists. `npm run dev` leaves it unset and gets the fake
 * adapter. Unset, empty or unrecognized is the fake, so a misspelt `sdk` costs
 * nothing and pays for nothing — and because that is silent by construction,
 * every launch writes one record saying what was asked for, what answered, and
 * why they differ when they do.
 *
 * The sink is passed in (D9: one sink, built at startup, handed to everything);
 * the flavor is not, because it is not the caller's to choose. Whatever this
 * returns is wrapped in `withLogging` before it leaves — every port a launch
 * gets is a logged one, and this is the only place that can promise that (D8).
 */
export function selectAdapter(log: LogSink): AgentAdapter {
  const requested = process.env.CRUCIBLE_AGENT
  const asked = requested === undefined || requested === '' ? null : requested

  // The SDK adapter is not built yet — it arrives with its own slice, and this
  // is the one line that changes when it does. Until then `sdk` is honoured the
  // only way an unbuilt flavor can be: with the fake, and loudly in the log.
  const reason =
    asked === 'sdk'
      ? 'the SDK adapter is not built yet, so this launch runs on the fake adapter'
      : asked === null || asked === 'fake'
        ? null
        : `CRUCIBLE_AGENT=${asked} is not a launch flavor, so the fake adapter answers`

  const adapter = 'fake'
  log.append({ source: 'main', event: 'adapter_selected', adapter, requested: asked, reason })

  return withLogging(createFakeAdapter(), log, adapter)
}
