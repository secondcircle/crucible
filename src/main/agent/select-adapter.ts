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
  // Read by the caller: the SDK adapter puts it into every session's system
  // context.
  readonly agentDoc?: string
  /** Opening the OS browser during a login; only main can do it. */
  readonly openExternal?: (url: string) => void
}

export interface FlavorDecision {
  readonly flavor: Flavor
  readonly requested: string | null
  readonly reason: string | null
}

// Pure, so the packaged rule is testable without constructing an adapter.
// A packaged launch is the installed app in the human's Dock: it always runs
// the SDK adapter, because the fake exists only for agent-driven checks and a
// human using the app needs a real environment.
export function decideFlavor(requested: string | undefined, packaged: boolean): FlavorDecision {
  const asked = requested === undefined || requested === '' ? null : requested

  if (packaged) {
    return {
      flavor: 'sdk',
      requested: asked,
      reason:
        asked === null || asked === 'sdk'
          ? null
          : `a packaged launch always runs the SDK adapter, so CRUCIBLE_AGENT=${asked} is ignored`
    }
  }

  // `sdk` buys paid calls, so it has to be spelled exactly; everything else is
  // the fake.
  const flavor: Flavor = asked === 'sdk' ? 'sdk' : 'fake'
  return {
    flavor,
    requested: asked,
    reason:
      flavor === 'sdk' || asked === null || asked === 'fake'
        ? null
        : `CRUCIBLE_AGENT=${asked} is not a launch flavor, so the fake adapter answers`
  }
}

// The only reader of `CRUCIBLE_AGENT`, so no caller has to know the variable
// exists. The fallback to the fake is silent, so every launch records it.
export function selectAdapter(
  log: LogSink,
  panel: FakePanel,
  sdk: SdkOptions = {},
  packaged = false
): SelectedAdapter {
  const { flavor, requested, reason } = decideFlavor(process.env.CRUCIBLE_AGENT, packaged)

  log.append({ source: 'main', event: 'adapter_selected', adapter: flavor, requested, reason })

  return {
    flavor,
    adapter:
      flavor === 'sdk'
        ? createSdkAdapter({
            panel: panel.tools,
            ...(sdk.agentDoc === undefined ? {} : { agentDoc: sdk.agentDoc }),
            ...(sdk.openExternal === undefined ? {} : { openExternal: sdk.openExternal })
          })
        : createFakeAdapter({ panel })
  }
}
