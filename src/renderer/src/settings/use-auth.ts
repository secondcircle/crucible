import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentPort,
  AuthMethod,
  AuthNotice,
  AuthPromptKind,
  AuthPromptOption,
  ProviderState
} from '../../../shared/agent/port'

// π owns the flow, the token exchange and the storage; Crucible owns the
// pixels. This hook is the renderer's whole memory of a login: the questions
// that arrived, the answers that went back, and how it ended.
//
// It lives above the settings sheet because Escape's precedence is the
// document's, and a component cannot see what else Escape could close.

export interface AskedPrompt {
  readonly promptId: string
  readonly kind: AuthPromptKind
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly AuthPromptOption[]
}

export interface LoginState {
  readonly provider: ProviderState
  readonly method: AuthMethod
  /** Questions still on screen, oldest first. */
  readonly prompts: readonly AskedPrompt[]
  /** Everything the flow said that was not a question. */
  readonly notices: readonly AuthNotice[]
  /** Display-safe; the detail went to the run log. */
  readonly failure?: string
  /** True between an answer and whatever the flow says next. */
  readonly waiting: boolean
}

export interface Auth {
  /** Absent until the first answer, which is not the same as an empty catalog. */
  readonly providers?: readonly ProviderState[]
  /** A refusal that belongs to the tab rather than to a dialog. */
  readonly failure?: string
  readonly login?: LoginState
  refresh(): void
  startLogin(provider: ProviderState, method: AuthMethod): void
  answer(promptId: string, value: string): void
  /** Closing the dialog cancels the flow; a cancel the user asked for is quiet. */
  closeLogin(): void
  logout(providerId: string): void
}

function said(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useAuth(port: AgentPort, onCredentialsChanged: () => void): Auth {
  const [providers, setProviders] = useState<readonly ProviderState[] | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [login, setLogin] = useState<LoginState | undefined>(undefined)
  // A cancel the user initiated is quiet, so the rejection it causes is told
  // apart from a flow that genuinely failed.
  const cancelling = useRef(false)

  const refresh = useCallback((): void => {
    void port
      .listProviders()
      .then((listed) => {
        setProviders(listed)
        setFailure(undefined)
      })
      .catch((cause: unknown) => setFailure(said(cause)))
  }, [port])

  // Subscribed for the life of the document: a flow's questions can arrive
  // before the call that started it resolves.
  useEffect(() => {
    return port.onEvent((event) => {
      if (event.type === 'auth_prompt') {
        const { promptId, kind, message, placeholder, options } = event
        setLogin((current) =>
          current === undefined
            ? current
            : {
                ...current,
                waiting: false,
                prompts: [
                  ...current.prompts,
                  {
                    promptId,
                    kind,
                    message,
                    ...(placeholder === undefined ? {} : { placeholder }),
                    ...(options === undefined ? {} : { options })
                  }
                ]
              }
        )
        return
      }
      // Resolved out of band: the input goes away without being answered.
      if (event.type === 'auth_prompt_closed') {
        setLogin((current) =>
          current === undefined
            ? current
            : {
                ...current,
                prompts: current.prompts.filter((asked) => asked.promptId !== event.promptId)
              }
        )
        return
      }
      if (event.type === 'auth_notice') {
        setLogin((current) =>
          current === undefined
            ? current
            : { ...current, notices: [...current.notices, event.notice] }
        )
      }
    })
  }, [port])

  const startLogin = useCallback(
    (provider: ProviderState, method: AuthMethod): void => {
      // One at a time, said plainly rather than starting a second flow behind
      // the first (PROV-6).
      if (login !== undefined) {
        setFailure('A login is already under way. Finish or cancel it first.')
        return
      }
      setFailure(undefined)
      cancelling.current = false
      setLogin({ provider, method, prompts: [], notices: [], waiting: true })

      void port
        .login(provider.id, method)
        .then(() => {
          setLogin(undefined)
          refresh()
          // The models a credential unlocks are reachable now, so the picker
          // is refetched rather than left showing yesterday's list (PROV-4).
          onCredentialsChanged()
        })
        .catch((cause: unknown) => {
          if (cancelling.current) {
            cancelling.current = false
            setLogin(undefined)
            return
          }
          setLogin((current) =>
            current === undefined
              ? current
              : { ...current, waiting: false, prompts: [], failure: said(cause) }
          )
        })
    },
    [login, port, refresh, onCredentialsChanged]
  )

  const answer = useCallback(
    (promptId: string, value: string): void => {
      setLogin((current) =>
        current === undefined
          ? current
          : {
              ...current,
              waiting: true,
              prompts: current.prompts.filter((asked) => asked.promptId !== promptId)
            }
      )
      void port.answerAuthPrompt(promptId, value).catch((cause: unknown) => {
        setLogin((current) =>
          current === undefined ? current : { ...current, waiting: false, failure: said(cause) }
        )
      })
    },
    [port]
  )

  const closeLogin = useCallback((): void => {
    // A flow that already failed has nothing left to cancel: the dialog just
    // goes away.
    if (login?.failure === undefined) {
      cancelling.current = true
      void port.cancelLogin().catch(() => {
        // Nothing to say: the flow is going away either way.
      })
    }
    setLogin(undefined)
  }, [login, port])

  const logout = useCallback(
    (providerId: string): void => {
      setFailure(undefined)
      void port
        .logout(providerId)
        .then(() => {
          refresh()
          onCredentialsChanged()
        })
        .catch((cause: unknown) => setFailure(said(cause)))
    },
    [port, refresh, onCredentialsChanged]
  )

  return {
    ...(providers === undefined ? {} : { providers }),
    ...(failure === undefined ? {} : { failure }),
    ...(login === undefined ? {} : { login }),
    refresh,
    startLogin,
    answer,
    closeLogin,
    logout
  }
}
