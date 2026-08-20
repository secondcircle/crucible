import type { NeedsYouService, WaitingSession } from '../../../shared/needs-you/service'
import { needsYouBridge } from '../bridge'

// The renderer's side of the needs-you channel. It holds no state: which
// sessions are asking is the document's own memory, and whether the dock or
// the notification centre ever hears about it is main's call.

export function createNeedsYouClient(): NeedsYouService {
  const needsYou = needsYouBridge()

  async function call(op: string, args: readonly unknown[]): Promise<void> {
    const result = await needsYou.request({ op, args })
    if (!result.ok) throw new Error(result.message)
  }

  return {
    waiting: (count: number) => call('waiting', [count]),
    announce: (session: WaitingSession) => call('announce', [session])
  }
}
