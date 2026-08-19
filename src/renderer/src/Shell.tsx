import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  AgentPort,
  HistoryMatch,
  SessionId,
  ThinkingLevel,
  WorkspaceId
} from '../../shared/agent/port'
import { Composer, useElapsedSeconds } from './components/Composer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ResumeOverlay } from './components/ResumeOverlay'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { knownEmpty, NOTHING_YET, reduce } from './state/shell-state'
import './shell.css'

// The port arrives as a prop, which is the seam a component test drives, and
// why nothing else under `src/renderer` names `window.crucible`.

/** At most one is open at a time. */
type Popover = 'none' | 'model' | 'thinking' | 'sessionMenu' | 'resume'

type Question =
  | { readonly kind: 'reset'; readonly sessionId: SessionId }
  | { readonly kind: 'thinking'; readonly sessionId: SessionId; readonly level: ThinkingLevel }

export function Shell({ port }: { port: AgentPort }): React.JSX.Element {
  const [state, dispatch] = useReducer(reduce, NOTHING_YET)
  const [popover, setPopover] = useState<Popover>('none')
  const [question, setQuestion] = useState<Question | undefined>(undefined)
  const [drafts, setDrafts] = useState<Readonly<Record<SessionId, string>>>({})
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** Sessions whose settled history this document has already asked for. */
  const fetched = useRef<Set<SessionId>>(new Set())

  const { snapshot, models, views } = state
  const activeWorkspaceId = snapshot.activeWorkspaceId
  const activeSessionId = snapshot.activeSessionId
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === activeWorkspaceId)
  const session = snapshot.sessions.find((candidate) => candidate.id === activeSessionId)
  const view = activeSessionId === undefined ? undefined : views[activeSessionId]
  const items = view?.items ?? []
  // Known to hold nothing, which is what lets a guard skip its question.
  const emptyConversation = knownEmpty(view)
  const working = session?.working ?? false
  const model = models.find((candidate) => candidate.id === session?.model)
  const elapsedSeconds = useElapsedSeconds(working ? view?.turn?.startedAt : undefined)

  const report = useCallback((cause: unknown): void => {
    setFailure(cause instanceof Error ? cause.message : String(cause))
  }, [])

  // Subscribe before anything is asked for: events may arrive before the
  // promise of the operation that caused them resolves, and there is no
  // backlog to catch up on afterwards.
  useEffect(() => {
    const stop = port.onEvent((event) => {
      // The clock is read here rather than in the reducer, which stays pure so
      // React may replay it under StrictMode.
      dispatch({ type: 'event', event, at: Date.now() })
    })
    void port
      .snapshot()
      .then((taken) => dispatch({ type: 'snapshot', snapshot: taken }))
      .catch(report)
    void port
      .listModels()
      .then((listed) => dispatch({ type: 'models', models: listed }))
      .catch(report)
    return stop
  }, [port, report])

  // Settled history, once per session this document has not watched live.
  useEffect(() => {
    if (activeSessionId === undefined || fetched.current.has(activeSessionId)) return
    const id = activeSessionId
    fetched.current.add(id)
    void port
      .transcript(id)
      .then((restored) => dispatch({ type: 'loaded', sessionId: id, items: restored }))
      .catch((cause: unknown) => {
        fetched.current.delete(id)
        report(cause)
      })
  }, [activeSessionId, port, report])

  const cancel = useCallback((): void => {
    if (activeSessionId === undefined || !working) return
    void port.cancel(activeSessionId).catch(report)
  }, [activeSessionId, working, port, report])

  // Precedence cannot live in the components, which each know only one of the
  // three things Escape can close.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key !== 'Escape') return
      if (question !== undefined) {
        pressed.preventDefault()
        setQuestion(undefined)
        return
      }
      if (popover !== 'none') {
        pressed.preventDefault()
        setPopover('none')
        return
      }
      if (activeSessionId !== undefined && working) {
        pressed.preventDefault()
        cancel()
      }
      // Escape with nothing open and nothing running does nothing.
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [question, popover, activeSessionId, working, cancel])

  const draft = activeSessionId === undefined ? '' : (drafts[activeSessionId] ?? '')

  function setDraft(text: string): void {
    if (activeSessionId === undefined) return
    setDrafts((current) => ({ ...current, [activeSessionId]: text }))
  }

  function send(): void {
    const id = activeSessionId
    if (id === undefined || working) return
    const text = draft.trim()
    if (text === '') return
    setDrafts((current) => ({ ...current, [id]: '' }))
    // What was sent stands in the transcript at once; the turn it starts
    // arrives as events.
    dispatch({ type: 'sent', sessionId: id, text })
    setFailure(undefined)
    void port.prompt(id, text).catch(report)
  }

  function newSession(): void {
    if (activeWorkspaceId === undefined) return
    void port.createSession(activeWorkspaceId).catch(report)
  }

  function addWorkspace(): void {
    void port.addWorkspace().catch(report)
  }

  function activateWorkspace(id: WorkspaceId): void {
    setPopover('none')
    void port.activateWorkspace(id).catch(report)
  }

  function removeWorkspace(id: WorkspaceId): void {
    setPopover('none')
    void port.removeWorkspace(id).catch(report)
  }

  function activateSession(id: SessionId): void {
    setPopover('none')
    void port.activateSession(id).catch(report)
  }

  function removeSession(id: SessionId): void {
    setPopover('none')
    fetched.current.delete(id)
    void port.removeSession(id).catch(report)
  }

  function resetSession(): void {
    const id = activeSessionId
    if (id === undefined) return
    setPopover('none')
    // A conversation still being fetched shows no items but is not empty, so
    // only a known-empty one skips the question.
    if (emptyConversation) {
      applyReset(id)
      return
    }
    setQuestion({ kind: 'reset', sessionId: id })
  }

  function applyReset(id: SessionId): void {
    void port
      .resetSession(id)
      .then(() => {
        // The conversation behind the identity is new, so what this document
        // held of the old one goes with it.
        dispatch({ type: 'reset', sessionId: id })
      })
      .catch(report)
  }

  function selectModel(id: string): void {
    const sessionId = activeSessionId
    setPopover('none')
    if (sessionId === undefined) return
    void port.setModel(sessionId, id).catch(report)
  }

  function selectThinkingLevel(level: ThinkingLevel): void {
    const sessionId = activeSessionId
    setPopover('none')
    if (sessionId === undefined) return
    if (emptyConversation) {
      void port.setThinkingLevel(sessionId, level).catch(report)
      return
    }
    // Changing the level mid-conversation invalidates the session's prompt
    // cache, which costs the user money, so it is asked about first.
    setQuestion({ kind: 'thinking', sessionId, level })
  }

  const search = useCallback(
    (query: string): Promise<readonly HistoryMatch[]> =>
      activeWorkspaceId === undefined
        ? Promise.resolve([])
        : port.searchHistory(activeWorkspaceId, query),
    [activeWorkspaceId, port]
  )

  function resume(ref: string): void {
    const workspaceId = activeWorkspaceId
    setPopover('none')
    if (workspaceId === undefined) return
    void port.resumeSession(workspaceId, ref).catch(report)
  }

  function answer(): void {
    if (question === undefined) return
    const asked = question
    setQuestion(undefined)
    if (asked.kind === 'reset') applyReset(asked.sessionId)
    else void port.setThinkingLevel(asked.sessionId, asked.level).catch(report)
  }

  return (
    <div
      className="shell"
      onMouseDown={(clicked) => {
        // A click outside an open chip popover or the session menu closes it.
        if (popover === 'none' || popover === 'resume') return
        if ((clicked.target as HTMLElement).closest('.chipwrap, .sessionmenu') !== null) return
        setPopover('none')
      }}
    >
      <Sidebar
        snapshot={snapshot}
        onNewSession={newSession}
        onAddWorkspace={addWorkspace}
        onActivateWorkspace={activateWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onActivateSession={activateSession}
        onRemoveSession={removeSession}
        onResume={() => setPopover('resume')}
      />

      <main className="main">
        <TopBar
          session={session}
          workspace={workspace}
          model={model}
          menuOpen={popover === 'sessionMenu'}
          onToggleMenu={() => setPopover(popover === 'sessionMenu' ? 'none' : 'sessionMenu')}
          onResetSession={resetSession}
        />

        {snapshot.workspaces.length === 0 ? (
          <div className="blank">
            <p>No workspace yet.</p>
            <button className="btn primary" onClick={addWorkspace}>
              Add workspace
            </button>
          </div>
        ) : session === undefined ? (
          <div className="blank">
            <p>No session in this workspace.</p>
            <button className="btn primary" onClick={newSession}>
              New session
            </button>
          </div>
        ) : (
          <Transcript items={items} sessionId={session.id} />
        )}

        {failure === undefined ? null : (
          <p className="failure" role="alert">
            {failure}
          </p>
        )}

        <Composer
          draft={draft}
          disabled={session === undefined}
          working={working}
          elapsedSeconds={elapsedSeconds}
          model={model}
          modelId={session?.model}
          models={models}
          modelPickerOpen={popover === 'model'}
          thinkingLevel={session?.thinkingLevel}
          thinkingMenuOpen={popover === 'thinking'}
          onDraft={setDraft}
          onSend={send}
          onStop={cancel}
          onToggleModelPicker={() => setPopover(popover === 'model' ? 'none' : 'model')}
          onSelectModel={selectModel}
          onToggleThinkingMenu={() => setPopover(popover === 'thinking' ? 'none' : 'thinking')}
          onSelectThinkingLevel={selectThinkingLevel}
        />
      </main>

      {popover === 'resume' ? (
        <ResumeOverlay onSearch={search} onChoose={resume} onClose={() => setPopover('none')} />
      ) : null}

      {question === undefined ? null : question.kind === 'reset' ? (
        <ConfirmDialog
          title="Reset this session?"
          body="The conversation is replaced with a fresh one. This session keeps its place in the sidebar, and the old conversation stays findable through Resume session."
          confirmLabel="Reset anyway"
          cancelLabel="Keep the conversation"
          onConfirm={answer}
          onCancel={() => setQuestion(undefined)}
        />
      ) : (
        <ConfirmDialog
          title="Invalidate this session's cache?"
          body={`Changing the thinking level to ${question.level} mid-conversation invalidates this session's prompt cache, so the whole conversation is re-sent at full price on the next message.`}
          confirmLabel="Change anyway"
          cancelLabel="Keep current level"
          onConfirm={answer}
          onCancel={() => setQuestion(undefined)}
        />
      )}
    </div>
  )
}
