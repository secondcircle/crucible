import type { ConversationAdapter } from '../../shared/agent/adapter'
import { createFakeAdapter, type FakePanel } from '../../shared/agent/fake-adapter'
import type { LogSink } from '../log/sink'
import { createSdkAdapter } from './sdk-adapter'

/** The launch flavor, in one word. */
export type Flavor = 'fake' | 'sdk'

export interface SelectedAdapter {
  readonly adapter: ConversationAdapter
  readonly flavor: Flavor
}

export interface SdkOptions {
  // Called only for the sdk flavor, so a launch on the fake still starts when
  // no prompt can be read.
  readonly systemPrompt: () => string
  /** Opening the OS browser during a login; only main can do it. */
  readonly openExternal?: (url: string) => void
}

// The only reader of `CRUCIBLE_AGENT`, so no caller has to know the variable
// exists. The fallback to the fake is silent, so every launch records it.
export function selectAdapter(log: LogSink, panel: FakePanel, sdk: SdkOptions): SelectedAdapter {
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
    adapter:
      flavor === 'sdk'
        ? createSdkAdapter({
            panel: panel.tools,
            systemPrompt: sdk.systemPrompt(),
            ...(sdk.openExternal === undefined ? {} : { openExternal: sdk.openExternal })
          })
        : createFakeAdapter({ panel })
  }
}
