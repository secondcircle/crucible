import { useEffect, useState } from 'react'
import {
  redactKeys,
  type Redacted,
  type ResearchStatus
} from '../../../shared/workspace/research'
import type { WorkspaceService } from '../../../shared/workspace/service'

// Everything the CLI is called by lives here, in the pane: no vendor string
// travels in the status type except what the CLI itself printed.

const CLI_NAME = 'firecrawl CLI'
const INSTALL_COMMAND = 'npm i -g firecrawl-cli'

// The section does one thing at a time, so its activity is one value rather
// than a set of flags that can contradict each other.
type ResearchActivity =
  | { readonly kind: 'idle' }
  /** `note` is everything the CLI has printed, in arrival order. */
  | { readonly kind: 'connecting'; readonly note: Redacted }
  /** The dialog is open on a refusal; Cancel reads Close. */
  | { readonly kind: 'connectFailed'; readonly message: Redacted }
  /** Log out is waiting: its button waits, and Connect cannot appear. */
  | { readonly kind: 'leaving' }
  /** A log-out refused: the pane's own alert line, no dialog. */
  | { readonly kind: 'leaveFailed'; readonly message: Redacted }

type ResearchView =
  /** The first read is in flight; the rows say Checking…. */
  | { readonly kind: 'reading' }
  | {
      readonly kind: 'known'
      readonly status: ResearchStatus
      readonly activity: ResearchActivity
    }

/**
 * A carriage return rewrites the line it lands on, which is how the login draws
 * the dots it counts while it waits.
 */
function noticeLines(note: string): readonly string[] {
  return note
    .split('\n')
    .map((line) => line.split('\r').at(-1)?.trimEnd() ?? '')
    .filter((line) => line !== '')
}

/** The id the masked field's form answers to, so Enter and Continue are one act. */
const KEY_FORM = 'research-key'

export function ResearchPane({
  workspace
}: {
  readonly workspace: WorkspaceService
}): React.JSX.Element {
  const [view, setView] = useState<ResearchView>({ kind: 'reading' })

  // Read once when the section becomes the shown one, which is this mount, and
  // again after every connect or log-out that resolved.
  useEffect(() => {
    let current = true

    function land(status: ResearchStatus): void {
      if (current) setView({ kind: 'known', status, activity: { kind: 'idle' } })
    }

    workspace
      .researchStatus()
      .then(land)
      // The one honest reading of "we asked and got nothing": the channel's own
      // message, through the same redaction everything else crosses.
      .catch((cause: unknown) => land({ kind: 'unreadable', reason: reasonOf(cause) }))

    return () => {
      current = false
      // A flow that outlived its dialog would wait as long as the CLI does, so
      // leaving ends whatever is waiting; ending nothing is harmless.
      void workspace.researchCancelConnect().catch(() => {})
    }
  }, [workspace])

  useEffect(
    () =>
      workspace.onEvent((event) => {
        if (event.type !== 'research_output') return
        setView((shown) =>
          shown.kind === 'known' && shown.activity.kind === 'connecting'
            ? {
                ...shown,
                activity: {
                  kind: 'connecting',
                  note: redactKeys(`${shown.activity.note}${event.chunk}`)
                }
              }
            : shown
        )
      }),
    [workspace]
  )

  const status = view.kind === 'known' ? view.status : undefined
  const activity: ResearchActivity =
    view.kind === 'known' ? view.activity : { kind: 'idle' }

  function settleWith(next: ResearchStatus): void {
    setView({ kind: 'known', status: next, activity: { kind: 'idle' } })
  }

  function keepStatus(activity: ResearchActivity): void {
    setView((shown) => (shown.kind === 'known' ? { ...shown, activity } : shown))
  }

  function connect(apiKey?: string): void {
    keepStatus({ kind: 'connecting', note: redactKeys('') })
    workspace
      .researchConnect(apiKey)
      .then((outcome) => {
        // Cancelled, or superseded by the key this dialog then pasted: nobody
        // is owed a message, so nothing here paints one.
        if (outcome.kind === 'abandoned') return
        if (outcome.kind === 'refused') {
          keepStatus({ kind: 'connectFailed', message: outcome.message })
          return
        }
        settleWith(outcome.status)
      })
      .catch((cause: unknown) => {
        keepStatus({ kind: 'connectFailed', message: reasonOf(cause) })
      })
  }

  function cancelConnect(): void {
    keepStatus({ kind: 'idle' })
    void workspace.researchCancelConnect().catch(() => {})
  }

  function logOut(): void {
    keepStatus({ kind: 'leaving' })
    workspace
      .researchDisconnect()
      .then((outcome) => {
        if (outcome.kind === 'refused') {
          keepStatus({ kind: 'leaveFailed', message: outcome.message })
          return
        }
        settleWith(outcome.status)
      })
      .catch((cause: unknown) => {
        keepStatus({ kind: 'leaveFailed', message: reasonOf(cause) })
      })
  }

  return (
    <div className="pane">
      <div className="prov">
        <span className="pname">Firecrawl CLI</span>
        <span className="pmeta">
          {/* Established is the green mark; not yet, not connected and not
              established are all the same faint one. */}
          <span
            className={`dot ${status !== undefined && installed(status) ? 'in' : 'out'}`}
            aria-hidden="true"
          />
          {status === undefined ? (
            'Checking…'
          ) : status.kind === 'notInstalled' ? (
            <>
              Not installed — <code className="cmd">{INSTALL_COMMAND}</code>
            </>
          ) : status.kind === 'unreadable' ? (
            `Status could not be read — ${status.reason}`
          ) : (
            `Installed — ${status.version}`
          )}
        </span>
      </div>

      <div className="prov">
        <span className="pname">Connection</span>
        <span className="pmeta">
          <span
            className={`dot ${status?.kind === 'signedIn' ? 'in' : 'out'}`}
            aria-hidden="true"
          />
          {connectionLine(status)}
        </span>
        {status?.kind === 'signedIn' ? (
          <button
            className="pbtn"
            disabled={activity.kind === 'leaving'}
            aria-label={`Log out of ${CLI_NAME}`}
            onClick={logOut}
          >
            {activity.kind === 'leaving' ? 'Logging out…' : 'Log out'}
          </button>
        ) : (
          <ConnectButton
            status={status}
            live={activity.kind === 'connecting' || activity.kind === 'connectFailed'}
            onConnect={() => connect()}
          />
        )}
      </div>

      <div className="prov">
        <span className="pname">Credits</span>
        <span className="pmeta">
          <span
            className={`dot ${
              status?.kind === 'signedIn' && status.credits !== undefined ? 'in' : 'out'
            }`}
            aria-hidden="true"
          />
          {creditsLine(status)}
        </span>
      </div>

      {activity.kind === 'leaveFailed' ? (
        <p className="pfail" role="alert">
          {activity.message}
        </p>
      ) : null}

      <p className="note">
        The {CLI_NAME} holds its own login and stores the credential on this machine; Crucible
        only renders the flow. No key is stored here, read here, or put into anything an agent
        runs.
      </p>

      {activity.kind === 'connecting' || activity.kind === 'connectFailed' ? (
        <ConnectDialog
          activity={activity}
          onCancel={cancelConnect}
          onKey={(apiKey) => connect(apiKey)}
        />
      ) : null}
    </div>
  )
}

function installed(status: ResearchStatus): boolean {
  return status.kind === 'signedIn' || status.kind === 'signedOut'
}

function connectionLine(status: ResearchStatus | undefined): string {
  if (status === undefined) return 'Checking…'
  switch (status.kind) {
    case 'notInstalled':
      return 'Needs the CLI'
    case 'unreadable':
      return 'Unknown'
    case 'signedOut':
      return 'Not connected'
    case 'signedIn':
      return 'Connected'
  }
}

/** A dash where nobody has reported a figure, the way every other card here does. */
function creditsLine(status: ResearchStatus | undefined): string {
  if (status?.kind !== 'signedIn' || status.credits === undefined) return '—'
  return `${status.credits.toLocaleString()} credits remaining`
}

// A control that cannot act says so rather than ignoring the click, so the
// disabled Connect carries the reason as its title and its accessible name.
function ConnectButton({
  status,
  live,
  onConnect
}: {
  readonly status: ResearchStatus | undefined
  readonly live: boolean
  readonly onConnect: () => void
}): React.JSX.Element {
  const blocked = status === undefined ? 'Checking the CLI’s status…' : whyNot(status)

  if (blocked !== undefined) {
    return (
      <button className="pbtn" disabled aria-label={blocked} title={blocked}>
        Connect
      </button>
    )
  }

  return (
    <button
      className="pbtn primary"
      disabled={live}
      aria-label={`Connect the ${CLI_NAME}`}
      onClick={onConnect}
    >
      Connect
    </button>
  )
}

/** The reason Connect cannot act, or nothing where it can. */
function whyNot(status: ResearchStatus): string | undefined {
  switch (status.kind) {
    case 'notInstalled':
      return `Connecting needs the ${CLI_NAME}, which is not installed — ${INSTALL_COMMAND}`
    case 'unreadable':
      return `Connecting needs the CLI’s status, which could not be read — ${status.reason}`
    case 'signedIn':
    case 'signedOut':
      return undefined
  }
}

// The CLI is the only thing that knows whether a browser opened, or whether it
// wants a URL pasted by hand, so its own words are what this shows.
function ConnectDialog({
  activity,
  onCancel,
  onKey
}: {
  readonly activity:
    | { readonly kind: 'connecting'; readonly note: Redacted }
    | { readonly kind: 'connectFailed'; readonly message: Redacted }
  readonly onCancel: () => void
  readonly onKey: (apiKey: string) => void
}): React.JSX.Element {
  const [key, setKey] = useState('')

  return (
    <div className="logveil" role="presentation">
      <div className="login" role="dialog" aria-modal="true" aria-label="Connect research">
        <h3>Connect the {CLI_NAME}</h3>

        <p className="notice">
          Your browser was opened for authorization. Finish there, or paste an API key below.
        </p>

        {activity.kind === 'connecting'
          ? noticeLines(activity.note).map((line, index) => (
              <p className="notice out" key={`${index}-${line}`}>
                {line}
              </p>
            ))
          : null}

        <form
          id={KEY_FORM}
          onSubmit={(sent) => {
            sent.preventDefault()
            const pasted = key.trim()
            if (pasted === '') return
            setKey('')
            onKey(pasted)
          }}
        >
          <input
            aria-label="Paste an API key instead"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(changed) => setKey(changed.target.value)}
          />
        </form>

        {activity.kind === 'connectFailed' ? (
          <p className="pfail" role="alert">
            {activity.message}
          </p>
        ) : null}

        <p className="fineprint">
          The CLI stores whatever it accepts, on this machine and nowhere else. Crucible passes a
          pasted key straight to it and keeps no copy.
        </p>

        <div className="row">
          <button className="pbtn" onClick={onCancel}>
            {activity.kind === 'connectFailed' ? 'Close' : 'Cancel'}
          </button>
          <button className="pbtn primary" form={KEY_FORM} type="submit" disabled={key.trim() === ''}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

function reasonOf(cause: unknown): Redacted {
  return redactKeys(cause instanceof Error ? cause.message : String(cause))
}
