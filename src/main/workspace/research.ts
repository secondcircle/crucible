import {
  redactKeys,
  type ConnectOutcome,
  type Redacted,
  type ResearchOutcome,
  type ResearchStatus
} from '../../shared/workspace/research'
import type { ResearchAttempt, ResearchProcesses } from './research-processes'
import { readResearchStatus, refusalMessage, RESEARCH_TIMEOUT_MS, STATUS_ARGS } from './research-status'

// The four research verbs, over a process seam that arrives as an argument, so
// everything below is drivable without spawning anything.

/** Starts the CLI's browser login: it prints a URL and waits on a person. */
const BROWSER_LOGIN: readonly string[] = ['login', '--browser']

/** The CLI's non-interactive login; the key is this call's argument and dies with it. */
function keyLogin(apiKey: string): readonly string[] {
  return ['login', '--api-key', apiKey]
}

const LOGOUT: readonly string[] = ['logout']

export interface ResearchOperations {
  status(): Promise<ResearchStatus>
  connect(apiKey?: string): Promise<ConnectOutcome>
  cancelConnect(): Promise<void>
  disconnect(): Promise<ResearchOutcome>
  /** Ends a waiting attempt on the way out. */
  dispose(): void
}

/** One connect attempt, and whether it was ended from outside. */
interface Live {
  readonly attempt: ResearchAttempt
  abandoned: boolean
}

export function createResearchOperations({
  processes,
  onOutput
}: {
  readonly processes: ResearchProcesses
  /** What the CLI printed while an attempt waits, already redacted. */
  readonly onOutput: (chunk: Redacted) => void
}): ResearchOperations {
  // At most one attempt exists at a time, and the one that holds this slot is
  // the only one anybody is owed an answer about.
  let live: Live | undefined

  function endLive(): void {
    const ending = live
    if (ending === undefined) return
    live = undefined
    ending.abandoned = true
    ending.attempt.cancel()
  }

  async function read(): Promise<ResearchStatus> {
    return readResearchStatus(await processes.capture(STATUS_ARGS, RESEARCH_TIMEOUT_MS))
  }

  return {
    status: read,

    async connect(apiKey?: string): Promise<ConnectOutcome> {
      // A second start ends the first rather than racing it; the first then
      // resolves `abandoned`, which nobody paints.
      endLive()

      const mine: Live = {
        attempt: processes.begin(
          apiKey === undefined ? BROWSER_LOGIN : keyLogin(apiKey),
          (chunk) => {
            // Only the live attempt has a dialog to speak into.
            if (live === mine) onOutput(redactKeys(chunk))
          }
        ),
        abandoned: false
      }
      live = mine

      const outcome = await mine.attempt.finished
      if (live === mine) live = undefined
      // Whatever the process did, an attempt ended from outside owes no answer.
      if (mine.abandoned || outcome.kind === 'cancelled') return { kind: 'abandoned' }
      if (outcome.kind === 'exited' && outcome.code === 0) {
        return { kind: 'settled', status: await read() }
      }
      return { kind: 'refused', message: refusalMessage(outcome) }
    },

    async cancelConnect(): Promise<void> {
      endLive()
    },

    async disconnect(): Promise<ResearchOutcome> {
      const outcome = await processes.capture(LOGOUT, RESEARCH_TIMEOUT_MS)
      if (outcome.kind === 'exited' && outcome.code === 0) {
        return { kind: 'settled', status: await read() }
      }
      return { kind: 'refused', message: refusalMessage(outcome) }
    },

    dispose(): void {
      endLive()
    }
  }
}
