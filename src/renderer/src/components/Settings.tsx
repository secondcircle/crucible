import { useEffect, useState } from 'react'
import type {
  AgentPort,
  AuthMethod,
  ProviderState,
  SessionId,
  SessionState,
  SessionUsage,
  WorkspaceState
} from '../../../shared/agent/port'
import { sessionLabel, tokens } from '../labels'
import type { AskedPrompt, Auth } from '../settings/use-auth'
import './settings.css'

// The settings surface: providers as π's ModelRuntime reports them, and usage
// as Crucible sums it from π's per-message numbers. π keeps no ledger, and
// neither does Crucible: everything here is recomputed on demand.

export type SettingsTab = 'providers' | 'usage'

/** Two decimals, or a dash while nothing has been reported (the meter's rule). */
function money(value: number | undefined): string {
  return value === undefined ? '—' : `$${value.toFixed(2)}`
}

function count(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString()
}

export function Settings({
  tab,
  onTab,
  onClose,
  port,
  auth,
  workspace,
  sessions,
  activeSessionId,
  contextPercent
}: {
  readonly tab: SettingsTab
  readonly onTab: (tab: SettingsTab) => void
  readonly onClose: () => void
  readonly port: AgentPort
  /** The login flow's whole state, held above so Escape can order the closes. */
  readonly auth: Auth
  readonly workspace?: WorkspaceState
  /** Curated sessions of the active workspace, in sidebar order. */
  readonly sessions: readonly SessionState[]
  readonly activeSessionId?: SessionId
  /** The meter's own percentage, which stays path-based. */
  readonly contextPercent?: number
}): React.JSX.Element {
  return (
    <div className="setveil" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheethead">
          <span className="t">Settings</span>
          <button
            className={`tab${tab === 'providers' ? ' on' : ''}`}
            aria-current={tab === 'providers' ? 'true' : undefined}
            onClick={() => onTab('providers')}
          >
            Providers
          </button>
          <button
            className={`tab${tab === 'usage' ? ' on' : ''}`}
            aria-current={tab === 'usage' ? 'true' : undefined}
            onClick={() => onTab('usage')}
          >
            Usage
          </button>
          <button className="x" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="sheetbody">
          {tab === 'providers' ? (
            <ProvidersPane auth={auth} />
          ) : (
            <UsagePane
              port={port}
              workspace={workspace}
              sessions={sessions}
              activeSessionId={activeSessionId}
              contextPercent={contextPercent}
            />
          )}
        </div>
      </div>

      {auth.login === undefined ? null : <LoginDialog auth={auth} />}
    </div>
  )
}

/** Signed-in providers only; the rest of π's catalog lives behind the picker. */
function ProvidersPane({ auth }: { readonly auth: Auth }): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const providers = auth.providers
  const credentialed = (providers ?? []).filter((provider) => provider.status.kind !== 'none')
  const rest = (providers ?? []).filter((provider) => provider.status.kind === 'none')

  return (
    <div className="pane">
      {providers === undefined ? (
        <p className="pempty">Reading the providers…</p>
      ) : credentialed.length === 0 ? (
        <p className="pempty">No provider has credentials yet.</p>
      ) : (
        credentialed.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} auth={auth} />
        ))
      )}

      {auth.failure === undefined ? null : (
        <p className="pfail" role="alert">
          {auth.failure}
        </p>
      )}

      <div className="addrow">
        <button className="pbtn primary" onClick={() => setPicking(!picking)}>
          Add provider
        </button>
      </div>

      {picking ? (
        <ProviderPicker
          providers={rest}
          onChoose={(provider, method) => {
            setPicking(false)
            auth.startLogin(provider, method)
          }}
        />
      ) : null}

      <p className="note">
        Provider list, auth method and status come from π; login and logout call π directly,
        which stores the credentials and refreshes the tokens. Crucible only renders the flow.
      </p>
    </div>
  )
}

function ProviderRow({
  provider,
  auth
}: {
  readonly provider: ProviderState
  readonly auth: Auth
}): React.JSX.Element {
  const { status } = provider
  const environment = status.kind === 'env'

  return (
    <div className="prov">
      <span className="pname">{provider.name}</span>
      <span className="pmeta">
        <span className="dot in" aria-hidden="true" />
        {statusLine(status)}
      </span>
      {environment ? (
        <button
          className="pbtn"
          disabled
          aria-label={`${provider.name} is managed outside Crucible`}
          title="Environment keys are managed outside Crucible"
        >
          —
        </button>
      ) : (
        <button
          className="pbtn"
          aria-label={`Log out of ${provider.name}`}
          onClick={() => auth.logout(provider.id)}
        >
          Log out
        </button>
      )}
    </div>
  )
}

/** What the status kinds say, in the words the settings surface uses for them. */
function statusLine(status: ProviderState['status']): string {
  switch (status.kind) {
    case 'oauth':
      return status.detail === undefined ? 'Signed in' : `Signed in — ${status.detail}`
    case 'api-key':
      return 'API key stored'
    case 'env':
      // Shown, never editable: the variable is set outside Crucible and
      // changed outside it too.
      return status.variable === undefined
        ? 'API key from the environment — managed outside Crucible'
        : `API key from environment (${status.variable}) — managed outside Crucible`
    case 'none':
      return 'Not signed in'
  }
}

// Everything π's catalog has that Crucible has no credential for. A provider
// offering both methods asks which before the flow starts.
function ProviderPicker({
  providers,
  onChoose
}: {
  readonly providers: readonly ProviderState[]
  readonly onChoose: (provider: ProviderState, method: AuthMethod) => void
}): React.JSX.Element {
  const [chosen, setChosen] = useState<ProviderState | undefined>(undefined)

  if (chosen !== undefined) {
    return (
      <div className="picker" role="dialog" aria-label={`How to sign in to ${chosen.name}`}>
        <p className="pickhead">How do you want to sign in to {chosen.name}?</p>
        {chosen.methods.map((method) => (
          <button
            key={method}
            className="pickrow"
            onClick={() => {
              setChosen(undefined)
              onChoose(chosen, method)
            }}
          >
            <span className="pname">
              {method === 'oauth' ? 'Sign in with OAuth' : 'Use an API key'}
            </span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="picker" role="dialog" aria-label="Add provider">
      {providers.length === 0 ? (
        <p className="pempty">Every provider π knows already has credentials.</p>
      ) : (
        providers.map((provider) => (
          <button
            key={provider.id}
            className="pickrow"
            disabled={provider.methods.length === 0}
            onClick={() => {
              if (provider.methods.length > 1) {
                setChosen(provider)
                return
              }
              const only = provider.methods[0]
              if (only !== undefined) onChoose(provider, only)
            }}
          >
            <span className="pname">{provider.name}</span>
            <span className="pmethods">
              {provider.methods.length === 0
                ? 'no login from Crucible'
                : provider.methods
                    .map((method) => (method === 'oauth' ? 'OAuth' : 'API key'))
                    .join(' · ')}
            </span>
          </button>
        ))
      )}
    </div>
  )
}

// π asks, Crucible renders. Closing the dialog cancels the flow, which is the
// escape hatch instead of a timeout.
function LoginDialog({ auth }: { readonly auth: Auth }): React.JSX.Element {
  const login = auth.login
  const asked = login?.prompts[0]

  if (login === undefined) return <></>

  return (
    <div className="logveil" role="presentation">
      <div
        className="login"
        role="dialog"
        aria-modal="true"
        aria-label={`Log in to ${login.provider.name}`}
      >
        <h3>Log in to {login.provider.name}</h3>

        {login.notices.map((notice, index) => (
          <p className="notice" key={`${notice.kind}-${index}`}>
            {notice.message}
            {notice.kind === 'auth-url' ? <span className="url">{notice.url}</span> : null}
            {notice.kind === 'device-code' ? (
              <span className="url">
                {notice.userCode} · {notice.verificationUri}
              </span>
            ) : null}
          </p>
        ))}

        {asked === undefined ? (
          login.failure === undefined ? (
            <p className="notice">Working…</p>
          ) : null
        ) : (
          <>
            <p className="asked">{asked.message}</p>
            {asked.kind === 'select' ? (
              (asked.options ?? []).map((option) => (
                <button
                  key={option.id}
                  className="pickrow"
                  onClick={() => auth.answer(asked.promptId, option.id)}
                >
                  <span className="pname">{option.label}</span>
                  {option.description === undefined ? null : (
                    <span className="pmethods">{option.description}</span>
                  )}
                </button>
              ))
            ) : (
              // Keyed by the question it answers, so a fresh one arrives with
              // an empty field and nothing typed for one prompt is ever
              // submitted for another.
              <PromptField
                key={asked.promptId}
                asked={asked}
                onAnswer={(value) => auth.answer(asked.promptId, value)}
              />
            )}
          </>
        )}

        {login.failure === undefined ? null : (
          <p className="pfail" role="alert">
            {login.failure}
          </p>
        )}

        <p className="fineprint">
          This dialog renders π's login flow — π owns the flow, the token exchange and the
          storage; Crucible owns only these pixels.
        </p>

        <div className="row">
          <button className="pbtn" onClick={auth.closeLogin}>
            {login.failure === undefined ? 'Cancel' : 'Close'}
          </button>
          {asked === undefined || asked.kind === 'select' ? null : (
            <button className="pbtn primary" form={asked.promptId} type="submit">
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// One question, one field. A secret is masked, and Enter answers exactly as
// the button does — they are the same form submission.
function PromptField({
  asked,
  onAnswer
}: {
  readonly asked: AskedPrompt
  readonly onAnswer: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')

  return (
    <form
      id={asked.promptId}
      onSubmit={(sent) => {
        sent.preventDefault()
        onAnswer(value)
      }}
    >
      <input
        aria-label={asked.message}
        type={asked.kind === 'secret' ? 'password' : 'text'}
        placeholder={asked.placeholder ?? ''}
        autoFocus
        value={value}
        onChange={(changed) => setValue(changed.target.value)}
      />
    </form>
  )
}

// Fetched when the tab opens and again at every turn boundary in this
// workspace, because nothing about usage is persisted anywhere.
function UsagePane({
  port,
  workspace,
  sessions,
  activeSessionId,
  contextPercent
}: {
  readonly port: AgentPort
  readonly workspace?: WorkspaceState
  readonly sessions: readonly SessionState[]
  readonly activeSessionId?: SessionId
  readonly contextPercent?: number
}): React.JSX.Element {
  const [usage, setUsage] = useState<ReadonlyMap<SessionId, SessionUsage>>(new Map())
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const ids = sessions.map((session) => session.id).join(',')

  useEffect(() => {
    let current = true

    function read(): void {
      const wanted = ids === '' ? [] : ids.split(',')
      void Promise.all(
        wanted.map(async (id) => [id, await port.sessionUsage(id)] as const)
      )
        .then((answers) => {
          if (!current) return
          const fresh = new Map<SessionId, SessionUsage>()
          for (const [id, summed] of answers) {
            if (summed !== undefined) fresh.set(id, summed)
          }
          setUsage(fresh)
          setFailure(undefined)
        })
        .catch((cause: unknown) => {
          if (current) setFailure(cause instanceof Error ? cause.message : String(cause))
        })
    }

    read()

    // Only a turn that ended changes what was spent, and only in a session of
    // the workspace whose numbers are on screen.
    const stop = port.onEvent((event) => {
      if (
        event.type !== 'turn_ended' &&
        event.type !== 'turn_cancelled' &&
        event.type !== 'turn_error'
      ) {
        return
      }
      if (!ids.split(',').includes(event.sessionId)) return
      read()
    })

    return () => {
      current = false
      stop()
    }
  }, [port, ids])

  if (workspace === undefined) {
    return (
      <div className="pane">
        <p className="pempty">No workspace is open, so there is nothing to add up yet.</p>
      </div>
    )
  }

  const active = activeSessionId === undefined ? undefined : usage.get(activeSessionId)
  const rows = sessions.map((session) => ({ session, summed: usage.get(session.id) }))
  const totals = rows.reduce(
    (sum, row) => ({
      messages: sum.messages + (row.summed?.messages ?? 0),
      totalTokens: sum.totalTokens + (row.summed?.totalTokens ?? 0),
      totalCost: sum.totalCost + (row.summed?.totalCost ?? 0)
    }),
    { messages: 0, totalTokens: 0, totalCost: 0 }
  )
  const anything = rows.some((row) => row.summed !== undefined)

  return (
    <div className="pane">
      <h4>This session</h4>
      {activeSessionId === undefined ? (
        <p className="pempty">No session is active in this workspace.</p>
      ) : (
        <>
          <div className="cards">
            <Card label="Cost" value={money(active?.totalCost)} />
            <Card label="Tokens" value={count(active?.totalTokens)} />
            <Card label="Messages" value={count(active?.messages)} />
            <Card
              label="Context"
              value={contextPercent === undefined ? '—' : `${contextPercent}%`}
            />
          </div>

          <table aria-label="This session">
            <thead>
              <tr>
                <th />
                <th className="n">Tokens</th>
                <th className="n">Cost</th>
              </tr>
            </thead>
            <tbody>
              <UsageRow label="Input" line={active?.input} />
              <UsageRow label="Output" line={active?.output} />
              <UsageRow label="Cache read" line={active?.cacheRead} />
              <UsageRow label="Cache write" line={active?.cacheWrite} />
              <tr className="total">
                <td>Total</td>
                <td className="n">{count(active?.totalTokens)}</td>
                <td className="n">{money(active?.totalCost)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <h4>Sessions in this workspace</h4>
      {rows.length === 0 ? (
        <p className="pempty">This workspace has no sessions yet.</p>
      ) : (
        <table aria-label="Sessions in this workspace">
          <thead>
            <tr>
              <th>Session</th>
              <th className="n">Messages</th>
              <th className="n">Tokens</th>
              <th className="n">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ session, summed }) => (
              <tr key={session.id}>
                <td>{sessionLabel(session)}</td>
                <td className="n">{count(summed?.messages)}</td>
                <td className="n">{summed === undefined ? '—' : tokens(summed.totalTokens)}</td>
                <td className="n">{money(summed?.totalCost)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Workspace total</td>
              <td className="n">{anything ? count(totals.messages) : '—'}</td>
              <td className="n">{anything ? tokens(totals.totalTokens) : '—'}</td>
              <td className="n">{anything ? money(totals.totalCost) : '—'}</td>
            </tr>
          </tbody>
        </table>
      )}

      {failure === undefined ? null : (
        <p className="pfail" role="alert">
          {failure}
        </p>
      )}

      <p className="note">
        π reports usage per message — input, output, cache-read and cache-write tokens, each
        with its dollar cost. Everything above is Crucible summing those numbers for this
        workspace; nothing is stored.
      </p>
    </div>
  )
}

function Card({
  label,
  value
}: {
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  )
}

function UsageRow({
  label,
  line
}: {
  readonly label: string
  readonly line?: { readonly tokens: number; readonly cost: number }
}): React.JSX.Element {
  return (
    <tr>
      <td>{label}</td>
      <td className="n">{count(line?.tokens)}</td>
      <td className="n">{money(line?.cost)}</td>
    </tr>
  )
}
