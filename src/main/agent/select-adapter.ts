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
  /**
   * The composed system prompt, asked for only when the sdk flavor is the one
   * chosen. It throws rather than answering with less: a fake-flavor launch
   * needs no prompt and must start without one, and an sdk-flavor launch that
   * cannot read what it ships must not fall back to π's own prompt.
   */
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
