import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter } from '../../shared/agent/fake-adapter'
import type { LogSink } from '../log/sink'
import { createSdkAdapter } from './sdk-adapter'

/** The launch flavor, in one word. */
export type Flavor = 'fake' | 'sdk'

export interface SelectedAdapter {
  readonly adapter: ConversationAdapter
  readonly flavor: Flavor
}

// The only reader of `CRUCIBLE_AGENT`, so no caller has to know the variable
// exists. Falling back to the fake is silent by construction, which is why
// every launch records what was asked for and what answered.
export function selectAdapter(log: LogSink): SelectedAdapter {
  const requested = process.env.CRUCIBLE_AGENT
  const asked = requested === undefined || requested === '' ? null : requested

  // `sdk` buys paid calls, so it has to be spelled exactly; everything else is
  // the fake.
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
