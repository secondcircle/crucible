import { useState } from 'react'
import type { RunRecord } from '../../../shared/workflows/run'

// One component for every place Investigate is offered — the ⌘R rows and the
// run view header — so the two cannot drift on what the button does while it
// is working or says when it cannot act. Disabled spans the whole flight, so
// a double-click cannot mint two sessions.

export function InvestigateButton({
  run,
  workspaceOpen,
  primary = false,
  onInvestigate
}: {
  readonly run: RunRecord
  /** Whether the run's own workspace is open; a session is made in it. */
  readonly workspaceOpen: boolean
  // True only where Investigate took the primary slot: the session-less row,
  // where it replaced Start session and inherited its emphasis.
  readonly primary?: boolean
  /** Creates the session, adopts the run, activates and prompts it. */
  readonly onInvestigate: () => Promise<void>
}): React.JSX.Element {
  const [flying, setFlying] = useState(false)

  return (
    <button
      className={`btn${primary ? ' primary' : ''}`}
      disabled={flying || !workspaceOpen}
      title={
        workspaceOpen
          ? `Start a session on run ${run.id} and ask what happened`
          : `Add ${run.workspaceName} to the sidebar first — an investigation runs in a session of its own.`
      }
      onClick={() => {
        if (flying || !workspaceOpen) return
        setFlying(true)
        // The flight ends with the user in the new session, so on success
        // this button is already gone with the surface that held it.
        void onInvestigate().finally(() => setFlying(false))
      }}
    >
      Investigate
    </button>
  )
}
