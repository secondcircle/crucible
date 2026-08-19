import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { LogSink } from '../log/sink'
import { createSdkAdapter } from './sdk-adapter'

/** Which adapter answered this launch — the launch flavor, in one word. */
export type Flavor = 'fake' | 'sdk'

/** The adapter a launch runs on, and the name every log record carries. */
export interface SelectedAdapter {
  readonly adapter: ConversationAdapter
  readonly flavor: Flavor
}

/**
 * Which adapter a launch puts behind the agent port.
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
 * The sink is passed in (one sink, built at startup, handed to everything); the
 * flavor is not, because it is not the caller's to choose. The SDK adapter's
 * module is imported statically here but its π SDK imports are dynamic, so a
 * fake-flavor launch never loads the SDK, and `npm test` constructs no SDK
 * adapter at all (SA-8).
 */
export function selectAdapter(log: LogSink): SelectedAdapter {
  const requested = process.env.CRUCIBLE_AGENT
  const asked = requested === undefined || requested === '' ? null : requested

  // `sdk` is the only value that buys anything, and it buys paid calls — so it
  // has to be spelled exactly. Everything else is the fake.
  const flavor: Flavor = asked === 'sdk' ? 'sdk' : 'fake'
  const reason =
    flavor === 'sdk' || asked === null || asked === 'fake'
      ? null
      : `CRUCIBLE_AGENT=${asked} is not a launch flavor, so the fake adapter answers`

  log.append({ source: 'main', event: 'adapter_selected', adapter: flavor, requested: asked, reason })

  return {
    flavor,
    adapter: flavor === 'sdk' ? createSdkAdapter() : createFakeAdapter()
  }
}
