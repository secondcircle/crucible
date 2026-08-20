import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  AgentPort,
  HistoryMatch,
  QueuedKind,
  SessionId,
  SessionTree as Tree,
  ThinkingLevel,
  WorkspaceId
} from '../../shared/agent/port'
import type {
  RunId,
  WorkspaceEvent,
  WorkspaceService
} from '../../shared/workspace/service'
import { BashDrawer, type RunView } from './components/BashDrawer'
import { type Attachment, Composer, useElapsedSeconds } from './components/Composer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { entriesOf, QueuedStrip } from './components/QueuedStrip'
import { ResumeOverlay } from './components/ResumeOverlay'
import { SessionTree } from './components/SessionTree'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { readAttachment, refuse } from './images'
import { knownEmpty, NOTHING_YET, reduce } from './state/shell-state'
import './shell.css'

// The port arrives as a prop, which is the seam a component test drives, and
// why no component reaches for `window.crucible` itself. The workspace service
// arrives the same way, beside it and never behind it.

/** At most one is open at a time. */
type Popover = 'none' | 'model' | 'thinking' | 'sessionMenu' | 'resume'

type Question =
  | { readonly kind: 'reset'; readonly sessionId: SessionId }
  | { readonly kind: 'thinking'; readonly sessionId: SessionId; readonly level: ThinkingLevel }

/** Two Escapes this far apart are the tree's accelerator. */
const DOUBLE_ESCAPE_MS = 500

/** A confirmation, not an error: it says what just happened and goes away. */
const TOAST_MS = 3200

const JUMPED =
  'Jumped — the transcript now shows the path to this point; your message is back in the composer.'

const JUMPED_WITH_SUMMARY =
  'Jumped with summary — the abandoned branch was summarized into context.'

export function Shell({
  port,
  workspace: service
}: {
  readonly port: AgentPort
  readonly workspace: WorkspaceService
}): React.JSX.Element {
  const [state, dispatch] = useReducer(reduce, NOTHING_YET)
  const [popover, setPopover] = useState<Popover>('none')
  const [question, setQuestion] = useState<Question | undefined>(undefined)
  const [drafts, setDrafts] = useState<Readonly<Record<SessionId, string>>>({})
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // Chips belong to the session's draft and last as long as the draft does.
  const [attachments, setAttachments] = useState<
    Readonly<Record<SessionId, readonly Attachment[]>>
  >({})
  const [veil, setVeil] = useState(false)
  const [tree, setTree] = useState<Tree | undefined>(undefined)
  const [treeOpen, setTreeOpen] = useState(false)
  const [toast, setToast] = useState<string | undefined>(undefined)
  // The file popover's token, and the answer the workspace service gave for it.
  const [fileToken, setFileToken] = useState<string | undefined>(undefined)
  const [files, setFiles] = useState<
    { readonly of: string; readonly paths: readonly string[] } | undefined
  >(undefined)
  // A run belongs to the workspace it was started in, not to a session.
  const [runs, setRuns] = useState<Readonly<Record<WorkspaceId, RunView>>>({})
  /** Sessions whose settled history this document has already asked for. */
  const fetched = useRef<Set<SessionId>>(new Set())
  // Restoring a queued message puts the caret back where the words are.
  const box = useRef<HTMLTextAreaElement>(null)
  // Output can arrive before the id of the run it belongs to does.
  const owners = useRef<Record<RunId, WorkspaceId>>({})
  const orphans = useRef<Map<RunId, WorkspaceEvent[]>>(new Map())
  const escapes = useRef<number>(0)

  const { snapshot, models, views } = state
  const activeWorkspaceId = snapshot.activeWorkspaceId
  const activeSessionId = snapshot.activeSessionId
  const active = snapshot.workspaces.find((candidate) => candidate.id === activeWorkspaceId)
  const session = snapshot.sessions.find((candidate) => candidate.id === activeSessionId)
  const view = activeSessionId === undefined ? undefined : views[activeSessionId]
  const items = view?.items ?? []
  // Known to hold nothing, which is what lets a guard skip its question.
  const emptyConversation = knownEmpty(view)
  const working = session?.working ?? false
  const queue = session?.queue
  const model = models.find((candidate) => candidate.id === session?.model)
  const elapsedSeconds = useElapsedSeconds(working ? view?.turn?.startedAt : undefined)
  const chips = activeSessionId === undefined ? [] : (attachments[activeSessionId] ?? [])
  // Closed unless the caret is in a token the service has already answered for.
  const shownFiles = fileToken !== undefined && files?.of === fileToken ? files.paths : undefined
  const run = activeWorkspaceId === undefined ? undefined : runs[activeWorkspaceId]

  const report = useCallback((cause: unknown): void => {
    setFailure(cause instanceof Error ? cause.message : String(cause))
  }, [])

  // A draft being typed is never destroyed: restored text lands above it,
  // where the words that were interrupted belong.
  const restore = useCallback((sessionId: SessionId, ...texts: readonly string[]): void => {
    const joined = texts.filter((text) => text !== '').join('\n\n')
    if (joined === '') return
    setDrafts((current) => {
      const draft = current[sessionId] ?? ''
      return { ...current, [sessionId]: draft === '' ? joined : `${joined}\n\n${draft}` }
    })
  }, [])

  // Subscribed before anything is asked for: events can arrive before the
  // operation that caused them resolves, and there is no backlog to catch up.
  useEffect(() => {
    const stop = port.onEvent((event) => {
      // The clock is read here rather than in the reducer, which stays pure so
      // React may replay it under StrictMode.
      dispatch({ type: 'event', event, at: Date.now() })
      // Queued messages the port handed back rather than delivered go to the
      // composer of the session they were queued in, active or not.
      if (event.type === 'queue_flushed') {
        restore(event.sessionId, ...event.messages.map((message) => message.text))
      }
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
  }, [port, report, restore])

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

  // A run's output is routed by the id the service minted for it, which is the
  // only thing that ties a chunk to the workspace it came from.
  useEffect(() => {
    return service.onEvent((event) => {
      const workspaceId = owners.current[event.runId]
      if (workspaceId === undefined) {
        // The id has not come back from `startRun` yet; nothing is thrown away.
        orphans.current.set(event.runId, [...(orphans.current.get(event.runId) ?? []), event])
        return
      }
      setRuns((current) => applyRunEvent(current, workspaceId, event))
    })
  }, [service])

  // The `@` popover's results: the workspace service answers, never the port.
  // What is shown belongs to the token it was asked for, so a stale answer can
  // never be taken for the current one.
  useEffect(() => {
    if (fileToken === undefined || active === undefined) return
    let current = true
    void service
      .searchFiles(active.path, fileToken)
      .then((found) => {
        if (current) setFiles({ of: fileToken, paths: found })
      })
      .catch((cause: unknown) => {
        if (current) report(cause)
      })
    return () => {
      current = false
    }
  }, [fileToken, active, service, report])

  useEffect(() => {
    if (toast === undefined) return
    const clear = setTimeout(() => setToast(undefined), TOAST_MS)
    return () => clearTimeout(clear)
  }, [toast])

  const cancel = useCallback((): void => {
    if (activeSessionId === undefined || !working) return
    void port.cancel(activeSessionId).catch(report)
  }, [activeSessionId, working, port, report])

  const openTree = useCallback((): void => {
    const id = activeSessionId
    if (id === undefined) return
    // Fetched fresh on every open, so what is shown is where the session
    // stands now.
    setTree(undefined)
    setTreeOpen(true)
    void port
      .sessionTree(id)
      .then(setTree)
      .catch(report)
  }, [activeSessionId, port, report])

  // Precedence cannot live in the components, which each know only one of the
  // things Escape can close.
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
      if (fileToken !== undefined) {
        pressed.preventDefault()
        setFileToken(undefined)
        return
      }
      if (treeOpen) {
        pressed.preventDefault()
        setTreeOpen(false)
        return
      }
      if (activeSessionId !== undefined && working) {
        pressed.preventDefault()
        // Escape keeps meaning stop while the session works, so the
        // accelerator cannot fire mid-turn.
        escapes.current = 0
        cancel()
        return
      }
      // Only presses that fell through everything above count towards the
      // tree's accelerator.
      const now = Date.now()
      const second = now - escapes.current <= DOUBLE_ESCAPE_MS
      escapes.current = second ? 0 : now
      if (second) openTree()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [question, popover, fileToken, treeOpen, activeSessionId, working, cancel, openTree])

  // Paste and drag are the only ways in, and they do nothing with no session
  // to attach to.
  useEffect(() => {
    function onPaste(pasted: ClipboardEvent): void {
      if (activeSessionId === undefined) return
      const dropped = [...(pasted.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
      // Text paste is untouched: only a file on the clipboard is an
      // attachment.
      if (dropped.length === 0) return
      pasted.preventDefault()
      void attach(activeSessionId, dropped)
    }

    function onDragOver(dragged: DragEvent): void {
      dragged.preventDefault()
      if (activeSessionId === undefined) return
      setVeil(true)
    }

    function onDragLeave(): void {
      setVeil(false)
    }

    function onDrop(dropped: DragEvent): void {
      dropped.preventDefault()
      setVeil(false)
      if (activeSessionId === undefined) return
      void attach(activeSessionId, [...(dropped.dataTransfer?.files ?? [])])
    }

    document.addEventListener('paste', onPaste)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // `attach` is defined below and closes over nothing that changes between
    // renders except the session it is given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  const draft = activeSessionId === undefined ? '' : (drafts[activeSessionId] ?? '')

  function setDraft(text: string): void {
    if (activeSessionId === undefined) return
    setDrafts((current) => ({ ...current, [activeSessionId]: text }))
  }

  async function attach(sessionId: SessionId, files: readonly File[]): Promise<void> {
    for (const file of files) {
      const refused = refuse(file)
      if (refused !== undefined) {
        // Loud, inline, and naming the file: nothing is dropped silently.
        setFailure(refused)
        continue
      }
      try {
        const image = await readAttachment(file)
        setAttachments((current) => ({
          ...current,
          [sessionId]: [
            ...(current[sessionId] ?? []),
            { id: `${file.name}-${Date.now()}-${Math.random()}`, name: file.name, ...image }
          ]
        }))
      } catch (cause) {
        report(cause)
      }
    }
  }

  function removeAttachment(id: string): void {
    const sessionId = activeSessionId
    if (sessionId === undefined) return
    setAttachments((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).filter((attachment) => attachment.id !== id)
    }))
  }

  /** Enter: a prompt while idle, a steering message while the session works. */
  function send(): void {
    const id = activeSessionId
    if (id === undefined) return
    const text = draft.trim()
    if (text === '') return
    // Steering and follow-up carry text only in this cut, so a message with
    // chips waits rather than losing them.
    if (working && chips.length > 0) return
    setDrafts((current) => ({ ...current, [id]: '' }))
    setFailure(undefined)
    if (working) {
      // Nothing is echoed into the transcript: a queued message appears only
      // in the strip until the port says it was delivered.
      void port.steer(id, text).catch(report)
      return
    }
    const images = chips.map((chip) => ({ mimeType: chip.mimeType, data: chip.data }))
    setAttachments((current) => ({ ...current, [id]: [] }))
    // What was sent stands in the transcript at once; the turn it starts
    // arrives as events.
    dispatch({ type: 'sent', sessionId: id, text, images })
    void port.prompt(id, text, images.length === 0 ? undefined : images).catch(report)
  }

  /** Option+Enter: a follow-up while working, and exactly Enter while idle. */
  function followUp(): void {
    const id = activeSessionId
    if (id === undefined) return
    if (!working) {
      send()
      return
    }
    if (chips.length > 0) return
    const text = draft.trim()
    if (text === '') return
    setDrafts((current) => ({ ...current, [id]: '' }))
    setFailure(undefined)
    void port.followUp(id, text).catch(report)
  }

  function dequeue(kind: QueuedKind, text: string): void {
    const id = activeSessionId
    if (id === undefined) return
    void port
      .dequeue(id, kind, text)
      .then((removed) => {
        // A false answer means the message was delivered or flushed while the
        // click was in flight, and the state event already took the entry off.
        if (!removed) return
        restore(id, text)
        box.current?.focus()
      })
      .catch(report)
  }

  // π's binding: the bottom-most entry, which is the last follow-up if there
  // is one and the last steering message otherwise.
  function restoreLast(): void {
    const last = queue === undefined ? undefined : entriesOf(queue).at(-1)
    if (last === undefined) return
    dequeue(last.kind, last.text)
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
    setTreeOpen(false)
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

  // In place: same session, same sidebar identity, and no cache guard, because
  // invalidating the cache is the point of the action.
  function jump(ref: string, summarize: boolean): void {
    const id = activeSessionId
    if (id === undefined) return
    setFailure(undefined)
    void port
      .jump(id, ref, { summarize })
      .then(async ({ editorText }) => {
        setTreeOpen(false)
        setToast(summarize ? JUMPED_WITH_SUMMARY : JUMPED)
        if (editorText !== undefined) restore(id, editorText)
        // The conversation stands somewhere else now, so the whole view is
        // replaced by the path it stands on.
        const path = await port.transcript(id)
        dispatch({ type: 'jumped', sessionId: id, items: path })
      })
      .catch(report)
  }

  function label(ref: string, text?: string): void {
    const id = activeSessionId
    if (id === undefined) return
    void port
      .setLabel(id, ref, text)
      // The tree is read back rather than patched here, so what the overlay
      // shows is what the conversation says.
      .then(() => port.sessionTree(id))
      .then(setTree)
      .catch(report)
  }

  function runBash(command: string): void {
    const workspaceId = activeWorkspaceId
    if (workspaceId === undefined || active === undefined) return
    const live = runs[workspaceId]
    if (live?.state === 'running') {
      // No hidden processes and no implicit kill: the drawer says what to do.
      setRuns((current) => ({
        ...current,
        [workspaceId]: { ...live, note: 'A command is already running here — stop it first.' }
      }))
      return
    }
    setDraft('')
    setFailure(undefined)
    setRuns((current) => ({
      ...current,
      [workspaceId]: { command, output: '', state: 'running', sharing: false }
    }))
    void service
      .startRun(active.path, command)
      .then((runId) => {
        owners.current[runId] = workspaceId
        const waiting = orphans.current.get(runId) ?? []
        orphans.current.delete(runId)
        setRuns((current) => {
          const started = current[workspaceId]
          if (started === undefined) return current
          let next = { ...current, [workspaceId]: { ...started, runId } }
          for (const event of waiting) next = applyRunEvent(next, workspaceId, event)
          return next
        })
      })
      .catch((cause: unknown) => {
        setRuns((current) => {
          const failed = current[workspaceId]
          return failed === undefined
            ? current
            : { ...current, [workspaceId]: { ...failed, state: 'stopped', sharing: false } }
        })
        report(cause)
      })
  }

  function stopRun(): void {
    const runId = run?.runId
    if (runId === undefined) return
    void service.stopRun(runId).catch(report)
  }

  function closeRun(): void {
    const workspaceId = activeWorkspaceId
    if (workspaceId === undefined) return
    setRuns((current) => {
      const rest = { ...current }
      delete rest[workspaceId]
      return rest
    })
  }

  // The only way a run reaches the model, and always a choice made after the
  // output was seen.
  function shareRun(): void {
    const workspaceId = activeWorkspaceId
    const id = activeSessionId
    const sharing = workspaceId === undefined ? undefined : runs[workspaceId]
    if (workspaceId === undefined || id === undefined || sharing === undefined) return

    setRuns((current) => {
      const found = current[workspaceId]
      return found === undefined
        ? current
        : { ...current, [workspaceId]: { ...found, sharing: true, note: undefined } }
    })

    void port
      .shareBashRun(id, {
        command: sharing.command,
        output: sharing.output,
        ...(sharing.exitCode === undefined ? {} : { exitCode: sharing.exitCode })
      })
      .then((outcome) => {
        setRuns((current) => {
          const found = current[workspaceId]
          if (found === undefined) return current
          // Delivered: the row is already in the transcript, put there by the
          // event at its true delivery point.
          if (outcome === 'delivered') {
            const rest = { ...current }
            delete rest[workspaceId]
            return rest
          }
          return {
            ...current,
            [workspaceId]: {
              ...found,
              sharing: false,
              note: 'The turn stopped first — this run is still local.'
            }
          }
        })
      })
      .catch((cause: unknown) => {
        setRuns((current) => {
          const found = current[workspaceId]
          return found === undefined
            ? current
            : { ...current, [workspaceId]: { ...found, sharing: false } }
        })
        report(cause)
      })
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
        const inside = (clicked.target as HTMLElement).closest('.chipwrap, .sessionmenu, .filepop')
        if (inside === null && fileToken !== undefined) setFileToken(undefined)
        if (popover === 'none' || popover === 'resume') return
        if (inside !== null) return
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
          workspace={active}
          model={model}
          menuOpen={popover === 'sessionMenu'}
          treeOpen={treeOpen}
          onToggleMenu={() => setPopover(popover === 'sessionMenu' ? 'none' : 'sessionMenu')}
          onToggleTree={() => {
            if (treeOpen) setTreeOpen(false)
            else openTree()
          }}
          onResetSession={resetSession}
        />

        {/* The tree overlays this region and nothing else: the composer below
            stays where it is and keeps working. */}
        <div className="stage">
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

          {treeOpen && session !== undefined ? (
            tree === undefined ? (
              <div className="tree loading">
                <p className="nonodes">Reading this session's tree…</p>
              </div>
            ) : (
              <SessionTree
                tree={tree}
                working={working}
                onJump={jump}
                onLabel={label}
                onClose={() => setTreeOpen(false)}
              />
            )
          ) : null}

          {toast === undefined ? null : (
            <p className="toast" role="status">
              {toast}
            </p>
          )}
        </div>

        {failure === undefined ? null : (
          <p className="failure" role="alert">
            {failure}
          </p>
        )}

        {queue === undefined ? null : <QueuedStrip queue={queue} onDequeue={dequeue} />}

        {run === undefined ? null : (
          <BashDrawer run={run} onStop={stopRun} onShare={shareRun} onClose={closeRun} />
        )}

        <Composer
          draft={draft}
          disabled={session === undefined}
          working={working}
          boxRef={box}
          elapsedSeconds={elapsedSeconds}
          model={model}
          modelId={session?.model}
          models={models}
          modelPickerOpen={popover === 'model'}
          thinkingLevel={session?.thinkingLevel}
          thinkingMenuOpen={popover === 'thinking'}
          attachments={chips}
          files={shownFiles}
          workspaceName={active?.name}
          workspacePath={active?.path}
          onDraft={setDraft}
          onSend={send}
          onFollowUp={followUp}
          onRestoreLast={restoreLast}
          onStop={cancel}
          onToggleModelPicker={() => setPopover(popover === 'model' ? 'none' : 'model')}
          onSelectModel={selectModel}
          onToggleThinkingMenu={() => setPopover(popover === 'thinking' ? 'none' : 'thinking')}
          onSelectThinkingLevel={selectThinkingLevel}
          onRemoveAttachment={removeAttachment}
          onFileToken={setFileToken}
          onRunBash={runBash}
        />
      </main>

      {veil ? (
        <div className="veil" role="status">
          Drop images to attach
        </div>
      ) : null}

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

// Pure, because React may replay a state update: what a chunk or an ending
// does to a run is decided from the run itself and nothing else.
function applyRunEvent(
  runs: Readonly<Record<WorkspaceId, RunView>>,
  workspaceId: WorkspaceId,
  event: WorkspaceEvent
): Readonly<Record<WorkspaceId, RunView>> {
  const found = runs[workspaceId]
  if (found === undefined || found.runId !== event.runId) return runs
  if (event.type === 'run_output') {
    return { ...runs, [workspaceId]: { ...found, output: found.output + event.chunk } }
  }
  return {
    ...runs,
    [workspaceId]: {
      ...found,
      // No exit code means it was stopped rather than having exited, and
      // nothing is invented for it.
      state: event.exitCode === undefined ? 'stopped' : 'ended',
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode })
    }
  }
}
