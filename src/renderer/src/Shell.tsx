import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { MODEL_RING } from '../../shared/agent/known-models'
import type {
  AgentPort,
  HistoryMatch,
  ModelId,
  QueuedKind,
  SessionId,
  SessionState,
  SessionTree as Tree,
  ShellSnapshot,
  ThinkingLevel,
  WorkspaceId
} from '../../shared/agent/port'
import type { AppUpdateService } from '../../shared/app-update/service'
import type { CacheService } from '../../shared/cache/service'
import type { CommandInfo, CommandService } from '../../shared/commands/service'
import { commandFragment } from '../../shared/commands/template'
import type { NeedsYouService } from '../../shared/needs-you/service'
import { boardCounts } from '../../shared/workspace/classify-board'
import { issueCounts, withSessions } from '../../shared/workspace/classify-issues'
import type { QuotaService } from '../../shared/quota/service'
import type {
  BoardRow,
  IssueBoardAnswer,
  IssueRow,
  RunId,
  WorkspaceEvent,
  WorkspaceService
} from '../../shared/workspace/service'
import { runIsLive, type RunRecord, type WorkflowRunId } from '../../shared/workflows/run'
import type {
  ArtifactView,
  RunsSnapshot,
  WorkflowRunService
} from '../../shared/workflows/service'
import { useBranchBoards, useIssueBoards } from './board/use-boards'
import { BashDrawer, type RunView } from './components/BashDrawer'
import { BranchBoard } from './components/BranchBoard'
import { CacheHealthView } from './components/CacheHealthView'
import { IssueBoard, type IssueSession } from './components/IssueBoard'
import { type Attachment, Composer, useElapsedSeconds } from './components/Composer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ContextPanel, PanelEdge } from './components/ContextPanel'
import { entriesOf, QueuedStrip } from './components/QueuedStrip'
import { ResumeOverlay } from './components/ResumeOverlay'
import { SessionTree } from './components/SessionTree'
import { RunsOverview } from './components/RunsOverview'
import { RunStrip } from './components/RunStrip'
import { Settings, type SettingsTab } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { WorkflowRunView } from './components/WorkflowRunView'
import { TopBar } from './components/TopBar'
import { Transcript } from './components/Transcript'
import { investigationPrompt } from './cache/prompt'
import { useCacheHealth } from './cache/use-cache'
import { readAttachment, refuse } from './images'
import { contextPercent, UNTITLED } from './labels'
import { useQuota } from './quota/use-quota'
import { runActivity } from './runs/activity'
import { useAuth } from './settings/use-auth'
import {
  jumpCancellable,
  jumpNote,
  jumpOf,
  withJump,
  withoutJump,
  type Jumps
} from './state/jumps'
import {
  askingCount,
  finishedUnwatched,
  forgetGone,
  nextAsking,
  withMark,
  withoutMark,
  type Marks
} from './state/needs-you'
import { knownEmpty, NOTHING_YET, reduce } from './state/shell-state'
import './shell.css'

// The port and the workspace service arrive as props, which is the seam a
// component test drives and why no component names `window.crucible` itself.

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
  workspace: service,
  commands,
  appUpdate,
  quota,
  cache: cacheService,
  needsYou: needsYouService,
  workflowRuns
}: {
  readonly port: AgentPort
  readonly workspace: WorkspaceService
  // Beside the port, never behind it: a command is expanded here, and the
  // port never learns commands exist.
  readonly commands: CommandService
  // Absent everywhere but the installed app's window; without it no update
  // pill can ever render.
  readonly appUpdate?: AppUpdateService
  // Beside the port, never behind it: quota is global, session-free provider
  // data. Without this service no quota strip renders at all.
  readonly quota?: QuotaService
  // Beside the port too: the cache ledger is global, one file per
  // installation across every workspace, session and run. Without this
  // service no cache strip and no cache health view render at all.
  readonly cache?: CacheService
  // The two needs-you channels outside the window. Without it the sidebar mark
  // and the Tab walk work exactly as they do with it, and nothing reaches the
  // dock or the notification centre.
  readonly needsYou?: NeedsYouService
  // Beside the port, never behind it: runs are observed through their own
  // seam, and the tools that drive them live with the agent. Without this
  // service no run surface renders at all.
  readonly workflowRuns?: WorkflowRunService
}): React.JSX.Element {
  const [state, dispatch] = useReducer(reduce, NOTHING_YET)
  const quotaHold = useQuota(quota)
  const refreshQuota = quotaHold.refresh
  // The counter as main holds it, repainted whenever a miss lands anywhere.
  const cacheHealth = useCacheHealth(cacheService)
  const [cacheOpen, setCacheOpen] = useState(false)
  // The badge's jump: a counter the transcript watches, because the request
  // carries nothing but itself.
  const [missJump, setMissJump] = useState(0)
  // The waiting build's commit, once main has announced one.
  const [updateCommit, setUpdateCommit] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (appUpdate === undefined) return
    let alive = true
    // Asked once, so a pill main announced before this window subscribed is
    // not lost; refusals mean only that there is nothing to show.
    void appUpdate
      .pending()
      .then((commit) => {
        if (alive && commit !== null) setUpdateCommit(commit)
      })
      .catch(() => {})
    const unsubscribe = appUpdate.onEvent((event) => setUpdateCommit(event.commit))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [appUpdate])
  const [popover, setPopover] = useState<Popover>('none')
  const [question, setQuestion] = useState<Question | undefined>(undefined)
  // What the model ring just switched to, shown before the port has confirmed
  // it. Dropped when the snapshot agrees, and dropped again if the call fails.
  const [ringed, setRinged] = useState<
    { readonly sessionId: SessionId; readonly model: ModelId } | undefined
  >(undefined)
  const [drafts, setDrafts] = useState<Readonly<Record<SessionId, string>>>({})
  // A failure belongs to the session whose action raised it and renders
  // nowhere else. An absent session is the window with no session on screen,
  // which is the only place such a failure can be shown.
  const [failure, setFailure] = useState<
    { readonly sessionId: SessionId | undefined; readonly message: string } | undefined
  >(undefined)
  // Chips belong to the session's draft and last as long as the draft does.
  const [attachments, setAttachments] = useState<
    Readonly<Record<SessionId, readonly Attachment[]>>
  >({})
  const [veil, setVeil] = useState(false)
  const [tree, setTree] = useState<Tree | undefined>(undefined)
  const [treeOpen, setTreeOpen] = useState(false)
  // A summarizing jump pays for an LLM call, so the tree says it is working —
  // in the session that is paying, and in no other. A failure outlives the
  // call; every other kind clears when the jump settles.
  const [jumps, setJumps] = useState<Jumps>({})
  /** The session whose action produced it; it renders while that one is active. */
  const [toast, setToast] = useState<
    { readonly sessionId: SessionId | undefined; readonly text: string } | undefined
  >(undefined)
  // The whole of the board's open state: only the chip and ⌘B put a workspace
  // here, and everything that closes the board takes it back out.
  const [boardFor, setBoardFor] = useState<WorkspaceId | undefined>(undefined)
  /** The same, for the issue board. At most one of the two is ever open. */
  const [issuesFor, setIssuesFor] = useState<WorkspaceId | undefined>(undefined)
  // The issue an Align is starting a session on, while it is starting it. One
  // at a time: a second click would make a second session on the same issue.
  const [aligning, setAligning] = useState<string | undefined>(undefined)
  // The file popover's token, and the answer the workspace service gave for it.
  const [fileToken, setFileToken] = useState<string | undefined>(undefined)
  const [files, setFiles] = useState<
    { readonly of: string; readonly paths: readonly string[] } | undefined
  >(undefined)
  // A run belongs to the workspace it was started in, not to a session.
  const [runs, setRuns] = useState<Readonly<Record<WorkspaceId, RunView>>>({})
  // The context panel's collapse is per session and its width is one value for
  // the window. Both are this document's memory and neither outlives it.
  const [collapsed, setCollapsed] = useState<Readonly<Record<SessionId, boolean>>>({})
  const [panelWidth, setPanelWidth] = useState<number | undefined>(undefined)
  // Whether each workspace is a git working tree, as the workspace service
  // answered. Absent until the answer arrives, which is why nothing flashes.
  const [gitWorkspaces, setGitWorkspaces] = useState<Readonly<Record<WorkspaceId, boolean>>>({})
  // Sessions with a worktree flip under way, keyed by session: switching away
  // during a creation disturbs nothing.
  const [flipping, setFlipping] = useState<readonly SessionId[]>([])
  // The last failed creation, and the session it happened in. Transient: it
  // clears on the next attempt and does not survive a reload.
  const [worktreeOutput, setWorktreeOutput] = useState<
    { readonly sessionId: SessionId; readonly output: string } | undefined
  >(undefined)
  // The commands this workspace can reach, read fresh every time the popover
  // opens, and the Escape that closed it.
  const [commandList, setCommandList] = useState<readonly CommandInfo[] | undefined>(undefined)
  const [commandPopoverClosed, setCommandPopoverClosed] = useState(false)
  // The port never learns commands exist, so this memory is the document's and
  // lasts exactly as long as it does.
  const [invocations, setInvocations] = useState<
    Readonly<Record<SessionId, Readonly<Record<string, string>>>>
  >({})
  // Sessions whose turn ended while nobody was looking at them. This launch's
  // memory and no longer: nothing runs while Crucible is closed, so there is
  // nothing to remember across a restart.
  const [marks, setMarks] = useState<Marks>(() => new Set<SessionId>())
  /** The session the user is on, as of the last time that changed. */
  const [landedOn, setLandedOn] = useState<SessionId | undefined>(undefined)
  // Open, and which tab: renderer state, per window, never persisted.
  const [settings, setSettings] = useState<{
    readonly open: boolean
    readonly tab: SettingsTab
  }>({ open: false, tab: 'providers' })
  /** Sessions whose settled history this document has already asked for. */
  const fetched = useRef<Set<SessionId>>(new Set())
  /** Workspaces already asked about, so the question is asked once each. */
  const askedGit = useRef<Set<string>>(new Set())
  // Read by a creation that outlived the click: what the sidebar holds now,
  // rather than what it held when the flip started.
  const sessionsNow = useRef<readonly SessionState[]>([])
  // The bash drawers as they stand, for an arrival that has to stop a running
  // command before it closes the drawer holding it.
  const runsNow = useRef<Readonly<Record<WorkspaceId, RunView>>>({})
  // The same trick for the port's subscription, which is set up once and must
  // not be torn down and rebuilt every time the sidebar changes.
  const railNow = useRef<ShellSnapshot>(NOTHING_YET.snapshot)
  /** Whether a login flow is running, which is what the sheet stays open for. */
  const loginNow = useRef(false)
  // Whether this window has focus, which is what "not looking" is measured
  // against. Seeded true and corrected by the events rather than read from
  // `document.hasFocus()`: at mount the window has not been shown yet, and a
  // window nobody has left is a window the user is at.
  const windowFocused = useRef(true)
  /** Sessions with a send under way, still waiting on its expansion. */
  const sending = useRef<Set<SessionId>>(new Set())
  // The engine's records, whole on every event; and the two run overlays.
  const [runsSnapshot, setRunsSnapshot] = useState<RunsSnapshot | undefined>(undefined)
  const [openRunId, setOpenRunId] = useState<WorkflowRunId | undefined>(undefined)
  // Lives here rather than in the run view because Escape unwinds one surface
  // at a time and this is where that ladder is; the reader is a step of it.
  const [openArtifactPath, setOpenArtifactPath] = useState<string | undefined>(undefined)
  const [runsOverviewOpen, setRunsOverviewOpen] = useState(false)
  // Restoring a queued message puts the caret back where the words are.
  const box = useRef<HTMLTextAreaElement>(null)
  // Output can arrive before the id of the run it belongs to does.
  const owners = useRef<Record<RunId, WorkspaceId>>({})
  /** Where the caret goes once seeded composer text has rendered. */
  const seedCaret = useRef<number | undefined>(undefined)
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
  const flipInFlight = activeSessionId !== undefined && flipping.includes(activeSessionId)
  // This session's jump and no other's: what session A is summarizing puts
  // nothing at all on session B's screen.
  const activeJump = jumpOf(jumps, activeSessionId)
  // A reopened tree is a loading panel until its fetch lands, so being open is
  // not the same as being able to carry what the jump has to say.
  const treeShowing = treeOpen && session !== undefined && tree !== undefined
  const working = session?.working ?? false
  const queue = session?.queue
  // The ring's choice stands in for the snapshot's until the port confirms it,
  // so the chip changes in the same frame the key lands.
  const shownModel =
    ringed !== undefined && ringed.sessionId === activeSessionId ? ringed.model : session?.model
  const model = models.find((candidate) => candidate.id === shownModel)
  const elapsedSeconds = useElapsedSeconds(working ? view?.turn?.startedAt : undefined)
  const chips = activeSessionId === undefined ? [] : (attachments[activeSessionId] ?? [])
  const draft = activeSessionId === undefined ? '' : (drafts[activeSessionId] ?? '')
  /** The folder a command list belongs to, which is what a fetch depends on. */
  const workspacePath = active?.path
  // Where this session's work happens: its worktree, or its workspace's
  // checkout. Bash runs and file search follow it.
  const sessionDirectory = session?.worktree?.path ?? active?.path
  // The popover belongs to the name being typed, and Escape closes it until
  // the next edit reopens it.
  const browsingCommands =
    session !== undefined && !commandPopoverClosed && commandFragment(draft) !== undefined
  const shownInvocations = useMemo(() => {
    const remembered = activeSessionId === undefined ? {} : (invocations[activeSessionId] ?? {})
    return new Map(Object.entries(remembered))
  }, [activeSessionId, invocations])
  // The visible panel is the active session's and no other's: a background
  // session's tabs wait in that session until the user switches to it.
  const panel = session?.panel
  const panelCollapsed = activeSessionId !== undefined && collapsed[activeSessionId] === true
  // Closed unless the caret is in a token the service has already answered for.
  const shownFiles = fileToken !== undefined && files?.of === fileToken ? files.paths : undefined
  const run = activeWorkspaceId === undefined ? undefined : runs[activeWorkspaceId]
  const allRuns: readonly RunRecord[] = useMemo(() => runsSnapshot?.runs ?? [], [runsSnapshot])
  // Every workspace's runs count, because the rail lists every workspace's
  // sessions.
  const railRuns = useMemo(() => runActivity(allRuns), [allRuns])
  // The strip is session-scoped (Q11/Q18): only the active session's live
  // runs. Finished ones leave the strip — their news arrived in the chat, and
  // their records live on in ⌘R.
  const sessionRuns =
    activeSessionId === undefined
      ? []
      : allRuns.filter(
          (candidate) => candidate.sessionId === activeSessionId && runIsLive(candidate)
        )
  const openRun = openRunId === undefined ? undefined : allRuns.find((r) => r.id === openRunId)
  // A record can only vanish across a launch; the view must not outlive it.
  if (openRunId !== undefined && openRun === undefined) setOpenRunId(undefined)

  // Owned by the session that asked for whatever failed. A call site that
  // knows the session names it; one that does not gets the session that was
  // active when the failure arrived.
  const report = useCallback((cause: unknown, owner?: SessionId): void => {
    setFailure({
      sessionId: owner ?? railNow.current.activeSessionId,
      message: messageOf(cause)
    })
  }, [])

  /** Acting in a session clears what that session's last action had to say. */
  const clearFailure = useCallback((sessionId: SessionId | undefined): void => {
    setFailure((current) =>
      current === undefined || current.sessionId === sessionId ? undefined : current
    )
  }, [])

  /** A confirmation belongs to the session it was earned in, and to no other. */
  const announce = useCallback((text: string, owner?: SessionId): void => {
    setToast({ sessionId: owner ?? railNow.current.activeSessionId, text })
  }, [])

  // A turn ended in a session nobody was watching, so that session needs the
  // user. The mark is the document's; whether it also leaves the window is
  // main's call, because main is what knows whether this window has focus.
  const finished = useCallback(
    (sessionId: SessionId): void => {
      const rail = railNow.current
      const unwatched = finishedUnwatched(sessionId, {
        activeSessionId: rail.activeSessionId,
        windowFocused: windowFocused.current
      })
      if (!unwatched) return
      setMarks((current) => withMark(current, sessionId))
      if (needsYouService === undefined) return
      const done = rail.sessions.find((candidate) => candidate.id === sessionId)
      const where = rail.workspaces.find((candidate) => candidate.id === done?.workspaceId)
      if (done === undefined || where === undefined) return
      void needsYouService
        .announce({ sessionId, workspace: where.name, title: done.title ?? UNTITLED })
        .catch(() => {})
    },
    [needsYouService]
  )

  // A workspace whose session is working is left alone: no collection runs
  // against a repository an agent may be mid-turn in.
  const workingWorkspaces = useMemo(
    () =>
      new Set(
        snapshot.sessions
          .filter((candidate) => candidate.working)
          .map((candidate) => candidate.workspaceId)
      ),
    [snapshot.sessions]
  )

  const { boards, refresh: refreshBoard } = useBranchBoards({
    service,
    workspaces: snapshot.workspaces,
    activeWorkspaceId,
    working: workingWorkspaces,
    onFailure: report
  })

  const { boards: issueBoards, refresh: refreshIssues } = useIssueBoards({
    service,
    workspaces: snapshot.workspaces,
    activeWorkspaceId,
    working: workingWorkspaces,
    onFailure: report
  })

  const boardEntry = activeWorkspaceId === undefined ? undefined : boards[activeWorkspaceId]
  const closeBoard = useCallback((): void => setBoardFor(undefined), [])
  const closeIssues = useCallback((): void => setIssuesFor(undefined), [])
  const boardAnswer = boardEntry?.answer
  const board = boardAnswer?.kind === 'board' ? boardAnswer.board : undefined
  // Nothing renders that is not backed by real state: no chip before the first
  // answer, and none at all for a folder that is not a repository.
  const counts = board === undefined ? undefined : boardCounts(board)
  const boardNeedYou = useMemo(() => {
    const perWorkspace: Record<WorkspaceId, number> = {}
    for (const [id, entry] of Object.entries(boards)) {
      if (entry.answer?.kind !== 'board') continue
      perWorkspace[id] = boardCounts(entry.answer.board).needYou
    }
    return perWorkspace
  }, [boards])
  const issueEntry = activeWorkspaceId === undefined ? undefined : issueBoards[activeWorkspaceId]
  // Sessions started on an issue in this workspace, by the reference they were
  // started on: the board's other way of knowing an issue is picked up.
  const issueSessions = useMemo(() => {
    const found = new Map<string, IssueSession>()
    for (const candidate of snapshot.sessions) {
      if (candidate.workspaceId !== activeWorkspaceId || candidate.issue === undefined) continue
      // The first one wins, which is the session the issue was picked up in.
      if (found.has(candidate.issue)) continue
      found.set(candidate.issue, {
        id: candidate.id,
        ...(candidate.title === undefined ? {} : { title: candidate.title })
      })
    }
    return found
  }, [snapshot.sessions, activeWorkspaceId])
  // The host's answer with this workspace's sessions folded in, which is the
  // only version anything downstream sees.
  const issueAnswer: IssueBoardAnswer | undefined = useMemo(() => {
    const collected = issueEntry?.answer
    if (collected?.kind !== 'board') return collected
    return {
      kind: 'board',
      board: withSessions(collected.board, new Set(issueSessions.keys()))
    }
  }, [issueEntry?.answer, issueSessions])
  const issues = issueAnswer?.kind === 'board' ? issueCounts(issueAnswer.board) : undefined

  // A mark for a session that has left the sidebar is not a mark: what is
  // shown, counted and walked is what the snapshot still holds.
  const asking = useMemo(() => forgetGone(marks, snapshot.sessions), [marks, snapshot.sessions])
  const waitingCount = askingCount(snapshot.sessions, asking)
  // Landing on a session is the whole of what clears its mark, whether the
  // user typed anything there or not. Hovering it and scrolling past it do
  // not: a mark any glance-like signal clears is a mark nobody trusts.
  //
  // Landing is the arrival and not the standing: a turn that ends in the
  // session already on screen while Crucible is behind another app marks it,
  // and only the window taking focus takes that mark off again.
  //
  // Adjusted in the render the snapshot arrives in, as the board's open state
  // is, rather than in an effect that would show the mark for a frame on the
  // very session being opened.
  if (activeSessionId !== landedOn) {
    setLandedOn(activeSessionId)
    if (activeSessionId !== undefined) setMarks(withoutMark(marks, activeSessionId))
  }
  /** ⌘B does nothing where there is no board to open, and no chip exists. */
  const boardReachable = activeWorkspaceId !== undefined && boardAnswer?.kind !== 'noRepository'
  // A workspace that turns out not to be a repository has no board to show, so
  // the overlay is gone in the frame the answer says so.
  const boardOpen = boardFor !== undefined && boardFor === activeWorkspaceId && boardReachable
  // Cleared in the same render, so a close cannot come back true when the
  // workspace is switched away from and back to.
  if (boardFor !== undefined && !boardOpen) setBoardFor(undefined)

  /** ⌘I does nothing where the workspace has no issue host to read. */
  const issuesReachable =
    activeWorkspaceId !== undefined && issueAnswer?.kind !== 'noIssueHost'
  const issuesOpen = issuesFor !== undefined && issuesFor === activeWorkspaceId && issuesReachable
  if (issuesFor !== undefined && !issuesOpen) setIssuesFor(undefined)

  // What a completed login or logout changes above the port: the models the
  // credentials now reach.
  const refetchModels = useCallback((): void => {
    void port
      .listModels()
      .then((listed) => dispatch({ type: 'models', models: listed }))
      .catch(report)
  }, [port, report])

  const auth = useAuth(port, refetchModels)
  // Read out here so the effects below depend on what they use rather than on
  // an object that is new every render.
  const { login: liveLogin, closeLogin, refresh: refreshProviders } = auth

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

  // Arriving at a session means seeing that session: everything that covers
  // or crowds the chat goes, in the same frame as the click and without
  // waiting for any round trip. `landing` is the session being
  // arrived at where it is already known, so a failure or a toast that
  // belongs there is not wiped on the way in.
  //
  // The live login dialog is exempt: credentials are global, the flow is
  // modal, and it is not session state.
  const arrive = useCallback(
    (landing?: SessionId): void => {
      setPopover('none')
      setTreeOpen(false)
      setBoardFor(undefined)
      setIssuesFor(undefined)
      setRunsOverviewOpen(false)
      setOpenRunId(undefined)
      // The sheet closes, except while it is holding a live login: that
      // dialog is modal, its flow is running in main, and closing the sheet
      // under it would orphan both.
      setSettings((current) =>
        current.open && !loginNow.current ? { ...current, open: false } : current
      )
      setCacheOpen(false)
      setQuestion(undefined)
      setFileToken(undefined)
      // The composer's own popovers: the command list closes until the next
      // edit reopens it, exactly as Escape closes it.
      setCommandPopoverClosed(true)
      // A failed worktree creation belongs to the moment it was read in:
      // arriving somewhere is the user done with it.
      setWorktreeOutput(undefined)
      const owned = (sessionId: SessionId | undefined): boolean =>
        landing !== undefined && sessionId === landing
      setFailure((current) =>
        current !== undefined && owned(current.sessionId) ? current : undefined
      )
      setToast((current) =>
        current !== undefined && owned(current.sessionId) ? current : undefined
      )
      closeBash()
    },
    // `closeBash` is defined below and closes over nothing that changes
    // between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // The run seam: one snapshot, then whole snapshots on every change. ⌘R
  // arrives here too when main intercepted it before the menu could.
  useEffect(() => {
    if (workflowRuns === undefined) return
    const stop = workflowRuns.onEvent((event) => {
      if (event.type === 'runs') setRunsSnapshot(event.snapshot)
      if (event.type === 'toggle-overview') setRunsOverviewOpen((open) => !open)
    })
    void workflowRuns
      .snapshot()
      .then(setRunsSnapshot)
      .catch(() => {})
    return stop
  }, [workflowRuns])

  // Subscribed before anything is asked for: events can arrive before the
  // operation that caused them resolves, and there is no backlog to catch up.
  useEffect(() => {
    const stop = port.onEvent((event) => {
      // The clock is read here rather than in the reducer, which stays pure so
      // React may replay it under StrictMode.
      dispatch({ type: 'event', event, at: Date.now() })
      // Every arrival main decides for itself lands here: a created session,
      // an activated workspace landing on its remembered session, the session
      // that becomes active when the active one is removed. The wipe happens
      // in the frame the snapshot does, batched with it.
      if (
        event.type === 'state' &&
        event.snapshot.activeSessionId !== railNow.current.activeSessionId
      ) {
        arrive(event.snapshot.activeSessionId)
      }
      // π's own retry of a summary, narrated in the session paying for it.
      // A failure or a cancellation that already landed stands: this event
      // may still be in flight behind either.
      if (event.type === 'summarize_retry') {
        const retry = event
        setJumps((current) => {
          const held = current[retry.sessionId]
          if (held === undefined || held.kind === 'failed' || held.kind === 'cancelling') {
            return current
          }
          return withJump(current, retry.sessionId, {
            kind: 'retrying',
            ref: held.ref,
            attempt: retry.attempt,
            maxAttempts: retry.maxAttempts,
            message: retry.message
          })
        })
      }
      // Queued messages the port handed back rather than delivered go to the
      // composer of the session they were queued in, active or not.
      if (event.type === 'queue_flushed') {
        restore(event.sessionId, ...event.messages.map((message) => message.text))
      }
      // A show opens the panel of whichever session it happened in: the active
      // one at once, a background one by the time the user switches to it.
      if (event.type === 'panel_shown') {
        setCollapsed((current) => ({ ...current, [event.sessionId]: false }))
      }
      // A cancelled or failed turn spent quota too. The TTL decides whether
      // the ask becomes a fetch.
      if (
        event.type === 'turn_ended' ||
        event.type === 'turn_cancelled' ||
        event.type === 'turn_error'
      ) {
        refreshQuota()
      }
      // A session that starts working again is not finished, whatever it was a
      // moment ago: the mark comes off and is re-earned when this turn ends.
      if (event.type === 'turn_started') {
        setMarks((current) => withoutMark(current, event.sessionId))
      }
      // Finished is a turn that ended and a turn that errored. Not one the
      // user stopped with Escape: that one is already known about, and marking
      // it would leave something to go and clear after every deliberate stop.
      if (event.type === 'turn_ended' || event.type === 'turn_error') {
        finished(event.sessionId)
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
  }, [port, report, restore, refreshQuota, finished, arrive])

  useEffect(() => {
    sessionsNow.current = snapshot.sessions
    railNow.current = snapshot
  }, [snapshot])

  useEffect(() => {
    runsNow.current = runs
  }, [runs])

  useEffect(() => {
    loginNow.current = liveLogin !== undefined
  }, [liveLogin])

  // Not looking is per window, so a turn that ended behind another app marked
  // even the session on screen. Coming back is genuinely looking at it, and
  // that session's mark comes off with nothing else clicked.
  useEffect(() => {
    function onFocus(): void {
      windowFocused.current = true
      const looking = railNow.current.activeSessionId
      if (looking === undefined) return
      setMarks((current) => withoutMark(current, looking))
    }
    function onBlur(): void {
      windowFocused.current = false
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Two channels outside the window, and main decides whether either is heard:
  // it is what knows whether Crucible has focus, and what owns the dock.
  useEffect(() => {
    if (needsYouService === undefined) return
    // A refusal here changes nothing on screen: the sidebar mark is the
    // channel that matters and it never left the document.
    void needsYouService.waiting(waitingCount).catch(() => {})
  }, [needsYouService, waitingCount])

  // Asked once per workspace folder. A question that could not be answered
  // leaves the chip absent, which is what a non-git workspace looks like too.
  useEffect(() => {
    for (const workspace of snapshot.workspaces) {
      const asked = `${workspace.id}:${workspace.path}`
      if (askedGit.current.has(asked)) continue
      askedGit.current.add(asked)
      void service
        .isGitWorkspace(workspace.path)
        .then((git) => setGitWorkspaces((current) => ({ ...current, [workspace.id]: git })))
        .catch(() => {})
    }
  }, [snapshot.workspaces, service])

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

  // What is shown belongs to the token it was asked for, so a slow answer can
  // never be taken for the current one.
  useEffect(() => {
    if (fileToken === undefined || sessionDirectory === undefined) return
    let current = true
    void service
      .searchFiles(sessionDirectory, fileToken)
      .then((found) => {
        if (current) setFiles({ of: fileToken, paths: found })
      })
      .catch((cause: unknown) => {
        if (current) report(cause)
      })
    return () => {
      current = false
    }
  }, [fileToken, sessionDirectory, service, report])

  useEffect(() => {
    if (toast === undefined) return
    const clear = setTimeout(() => setToast(undefined), TOAST_MS)
    return () => clearTimeout(clear)
  }, [toast])

  // The caret can only be placed once the draft it belongs to has rendered,
  // which is why this waits a frame rather than happening at the seeding.
  useEffect(() => {
    const caret = seedCaret.current
    if (caret === undefined) return
    seedCaret.current = undefined
    box.current?.focus()
    box.current?.setSelectionRange(caret, caret)
  })

  // Read again every time the popover opens, so a command an agent wrote a
  // moment ago is in this very list.
  useEffect(() => {
    if (!browsingCommands || workspacePath === undefined) return
    let current = true
    void commands
      .list(workspacePath)
      .then((listed) => {
        if (current) setCommandList(listed)
      })
      .catch((cause: unknown) => {
        if (current) report(cause)
      })
    return () => {
      current = false
      setCommandList(undefined)
    }
  }, [browsingCommands, workspacePath, commands, report])

  // The providers are read when the tab that shows them is on screen, never
  // held between openings: a credential may have changed elsewhere.
  useEffect(() => {
    if (settings.open && settings.tab === 'providers') refreshProviders()
  }, [settings.open, settings.tab, refreshProviders])

  const cancel = useCallback((): void => {
    if (activeSessionId === undefined || !working) return
    void port.cancel(activeSessionId).catch(report)
  }, [activeSessionId, working, port, report])

  // Landing on a session, however it was reached: a click in the rail, the
  // Tab walk, Go to session, or the issue board. Clicking the session already
  // on screen is an arrival too.
  const activateSession = useCallback(
    (id: SessionId): void => {
      arrive(id)
      void port.activateSession(id).catch(report)
    },
    [arrive, port, report]
  )

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
      // A login dialog closes before the sheet behind it, and the sheet before
      // anything else Escape already does.
      if (liveLogin !== undefined) {
        pressed.preventDefault()
        closeLogin()
        return
      }
      if (settings.open) {
        pressed.preventDefault()
        setSettings((current) => ({ ...current, open: false }))
        return
      }
      if (question !== undefined) {
        pressed.preventDefault()
        setQuestion(undefined)
        return
      }
      if (cacheOpen) {
        pressed.preventDefault()
        setCacheOpen(false)
        return
      }
      if (popover !== 'none') {
        pressed.preventDefault()
        setPopover('none')
        return
      }
      if (browsingCommands) {
        pressed.preventDefault()
        setCommandPopoverClosed(true)
        return
      }
      if (fileToken !== undefined) {
        pressed.preventDefault()
        setFileToken(undefined)
        return
      }
      // The run overlays close after the popovers — the view above the
      // overview, so Esc from an opened run lands back where it was opened.
      if (openRunId !== undefined) {
        pressed.preventDefault()
        if (openArtifactPath !== undefined) setOpenArtifactPath(undefined)
        else setOpenRunId(undefined)
        return
      }
      if (runsOverviewOpen) {
        pressed.preventDefault()
        setRunsOverviewOpen(false)
        return
      }
      // The boards close after the dialogs, sheets and popovers, and before
      // the session tree. While one is open Escape never cancels a turn.
      if (boardOpen) {
        pressed.preventDefault()
        closeBoard()
        return
      }
      if (issuesOpen) {
        pressed.preventDefault()
        closeIssues()
        return
      }
      // A summarize is this session's own work and Escape stops it, whether
      // or not the tree that started it is still open. Only the active
      // session's: a background session's summarize is untouchable from here.
      if (
        activeSessionId !== undefined &&
        activeJump !== undefined &&
        jumpCancellable(activeJump)
      ) {
        pressed.preventDefault()
        const cancelling = activeSessionId
        // Acknowledged in this frame; the port answers `cancelled` after it.
        setJumps((current) =>
          withJump(current, cancelling, { kind: 'cancelling', ref: activeJump.ref })
        )
        void port.cancel(cancelling).catch((cause: unknown) => report(cause, cancelling))
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
  }, [
    question,
    cacheOpen,
    popover,
    fileToken,
    boardOpen,
    issuesOpen,
    treeOpen,
    activeSessionId,
    activeJump,
    working,
    cancel,
    openTree,
    liveLogin,
    closeLogin,
    port,
    report,
    settings.open,
    browsingCommands,
    closeBoard,
    closeIssues,
    openRunId,
    openArtifactPath,
    runsOverviewOpen
  ])

  // ⌘R is the global runs view (Q15). In the running app main intercepts the
  // chord before the menu could spend it on reload and announces it as an
  // event; this fallback covers a window main is not watching, and either
  // path lands on the same toggle.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key !== 'r' && pressed.key !== 'R') return
      if (!pressed.metaKey && !pressed.ctrlKey) return
      if (pressed.shiftKey || pressed.altKey) return
      if (workflowRuns === undefined) return
      pressed.preventDefault()
      setRunsOverviewOpen((open) => !open)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [workflowRuns])

  const openBoard = useCallback((): void => {
    if (activeWorkspaceId === undefined) return
    // The overlay is there in the same frame; the collection catches up under
    // it, and says "Reading branches…" until it does.
    setBoardFor(activeWorkspaceId)
    // One overlay at a time: the two cover the same region.
    setIssuesFor(undefined)
    refreshBoard(activeWorkspaceId)
  }, [activeWorkspaceId, refreshBoard])

  const openIssues = useCallback((): void => {
    if (activeWorkspaceId === undefined) return
    setIssuesFor(activeWorkspaceId)
    setBoardFor(undefined)
    refreshIssues(activeWorkspaceId)
  }, [activeWorkspaceId, refreshIssues])

  // ⌘B is the board's own key, and the affordance is absent rather than
  // silently broken where there is nothing to open.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key !== 'b' && pressed.key !== 'B') return
      if (!pressed.metaKey && !pressed.ctrlKey) return
      if (boardOpen) {
        pressed.preventDefault()
        closeBoard()
        return
      }
      // Only claim the key where there is a board to open. The shortcut is
      // global, so someone who learned it in a repository will press it in a
      // plain folder too, and swallowing it there leaves the app looking
      // broken rather than looking like it has no board (ADR 0010).
      if (!boardReachable) return
      pressed.preventDefault()
      openBoard()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [boardOpen, boardReachable, openBoard, closeBoard])

  // ⌘I, on exactly the same terms: claimed where there is an issue board to
  // open, and left to the OS where there is not (ADR 0010).
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key !== 'i' && pressed.key !== 'I') return
      if (!pressed.metaKey && !pressed.ctrlKey) return
      if (issuesOpen) {
        pressed.preventDefault()
        closeIssues()
        return
      }
      if (!issuesReachable) return
      pressed.preventDefault()
      openIssues()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [issuesOpen, issuesReachable, openIssues, closeIssues])
  // The model ring. Nothing on screen names the key, and it works mid-turn
  // because the switch only reaches the next turn.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key !== 'Tab' || !pressed.shiftKey) return
      const sessionId = activeSessionId
      if (sessionId === undefined) return
      // A modal surface owns the keyboard while it is up.
      if (liveLogin !== undefined || settings.open || question !== undefined) return
      if (cacheOpen || popover === 'resume') return
      // A ring model the adapter did not list is skipped; with none listed the
      // key is left exactly as it was, no toast and no error.
      const candidates = MODEL_RING.filter((id) =>
        models.some((candidate) => candidate.id === id)
      )
      if (candidates.length === 0) return
      // Counted from what the chip shows, so pressing twice in a row cycles
      // twice rather than asking for the same model again.
      const at = candidates.findIndex((id) => id === shownModel)
      const target = at === -1 ? candidates[0] : candidates[(at + 1) % candidates.length]
      if (target === undefined || target === shownModel) return
      // Taken here, so focus never traverses backwards behind the switch.
      pressed.preventDefault()
      setRinged({ sessionId, model: target })
      void port
        .setModel(sessionId, target)
        // A refusal is reported where every other refusal is, and the chip
        // falls back to whatever the snapshot says.
        .catch(report)
        // Settled either way: the snapshot has the last word from here, and it
        // already carries the switch when the call succeeded.
        .finally(() => {
          setRinged((current) =>
            current?.sessionId === sessionId && current.model === target ? undefined : current
          )
        })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    activeSessionId,
    shownModel,
    models,
    port,
    report,
    liveLogin,
    settings.open,
    question,
    cacheOpen,
    popover
  ])

  // The Tab walk. Plain Tab is Crucible's key now: it takes the topmost
  // session asking, in rail order, crossing into the next workspace when this
  // one is clear. Landing clears that session's mark, so pressing it again and
  // again empties the queue from the top down.
  //
  // The cost is keyboard focus traversal, which this takes from the document.
  // Every surface genuinely operated by focus keeps the key: a modal, the
  // sheet, a popover, the board, the tree, and the composer's own completions,
  // which have already called preventDefault by the time this runs.
  useEffect(() => {
    function onKeyDown(pressed: KeyboardEvent): void {
      if (pressed.key !== 'Tab') return
      // Shift-Tab is the model ring and stays exactly as it was.
      if (pressed.shiftKey || pressed.metaKey || pressed.ctrlKey || pressed.altKey) return
      if (pressed.defaultPrevented) return
      if (liveLogin !== undefined || settings.open || question !== undefined) return
      if (cacheOpen) return
      if (popover !== 'none' || browsingCommands || fileToken !== undefined) return
      if (boardOpen || issuesOpen || treeOpen) return
      pressed.preventDefault()
      const next = nextAsking(snapshot, asking)
      // Nothing asking, nothing happens: no wrap to an arbitrary session and
      // no beep.
      if (next === undefined) return
      // Cleared here rather than on arrival, so the pip is gone in the frame
      // the key was pressed and not a round trip later (ADR 0010).
      setMarks((current) => withoutMark(current, next.id))
      activateSession(next.id)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    snapshot,
    asking,
    activateSession,
    liveLogin,
    settings.open,
    question,
    cacheOpen,
    popover,
    browsingCommands,
    fileToken,
    boardOpen,
    issuesOpen,
    treeOpen
  ])

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

  function setDraft(text: string): void {
    if (activeSessionId === undefined) return
    // Editing reopens a popover Escape closed, and clears whatever the last
    // send or expansion had to say.
    setCommandPopoverClosed(false)
    clearFailure(activeSessionId)
    setDrafts((current) => ({ ...current, [activeSessionId]: text }))
  }

  async function attach(sessionId: SessionId, files: readonly File[]): Promise<void> {
    for (const file of files) {
      const refused = refuse(file)
      if (refused !== undefined) {
        // Loud, inline, and naming the file: nothing is dropped silently.
        setFailure({ sessionId, message: refused })
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

  // What crosses is ordinary text: the queue, the transcript and the port see
  // the delivered words and nothing command-shaped.
  function expanded(id: SessionId, text: string, deliver: (text: string) => void): void {
    if (!text.startsWith('/') || active === undefined) {
      deliver(text)
      return
    }
    // Claimed before the expansion's round trip, in a ref because the next
    // keydown runs before React re-renders: a repeat must not send it twice.
    if (sending.current.has(id)) return
    sending.current.add(id)
    void commands
      .expand(active.path, text)
      .then((expansion) => {
        // A leading `/` that names no command is just text.
        if (expansion.kind === 'plain') {
          deliver(text)
          return
        }
        // Remembered here, keyed by what was delivered, which is the only
        // thing the transcript will ever see of it again.
        setInvocations((current) => ({
          ...current,
          [id]: { ...(current[id] ?? {}), [expansion.text]: text }
        }))
        deliver(expansion.text)
      })
      // Nothing sends, and the draft stays exactly where it is.
      .catch(report)
      // Delivered or refused, the draft may be sent again.
      .finally(() => {
        sending.current.delete(id)
      })
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
    expanded(id, text, (delivered) => {
      setDrafts((current) => ({ ...current, [id]: '' }))
      clearFailure(id)
      if (working) {
        // Nothing is echoed into the transcript: a queued message appears only
        // in the strip until the port says it was delivered.
        void port.steer(id, delivered).catch(report)
        return
      }
      const images = chips.map((chip) => ({ mimeType: chip.mimeType, data: chip.data }))
      setAttachments((current) => ({ ...current, [id]: [] }))
      // What was sent stands in the transcript at once; the turn it starts
      // arrives as events.
      dispatch({ type: 'sent', sessionId: id, text: delivered, images })
      void port.prompt(id, delivered, images.length === 0 ? undefined : images).catch(report)
    })
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
    expanded(id, text, (delivered) => {
      setDrafts((current) => ({ ...current, [id]: '' }))
      clearFailure(id)
      void port.followUp(id, delivered).catch(report)
    })
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

  // The full arrival wipe in the frame the button is pressed, and the empty
  // composer of the new session as soon as the snapshot carries it.
  function newSession(): void {
    if (activeWorkspaceId === undefined) return
    arrive()
    void port.createSession(activeWorkspaceId).catch(report)
  }

  function addWorkspace(): void {
    void port.addWorkspace().catch(report)
  }

  // Activating a workspace lands on its remembered active session, which is
  // an arrival like any other.
  function activateWorkspace(id: WorkspaceId): void {
    arrive()
    void port.activateWorkspace(id).catch(report)
  }

  function removeWorkspace(id: WorkspaceId): void {
    setPopover('none')
    void port.removeWorkspace(id).catch(report)
  }

  // The two choices and nothing between them: the checkout, or a worktree made
  // on the spot. Only a fresh session gets here, and no worktree is ever
  // deleted — flipping back detaches and leaves the directory on disk.
  function toggleWorktree(): void {
    const id = activeSessionId
    if (id === undefined || session === undefined || active === undefined) return
    if (!session.fresh || flipping.includes(id)) return

    // Same frame as the click: the chip is busy before anything is asked for.
    setWorktreeOutput(undefined)
    setFlipping((current) => [...current, id])
    const done = (): void =>
      setFlipping((current) => current.filter((waiting) => waiting !== id))

    if (session.worktree !== undefined) {
      void port
        .setWorktree(id)
        .catch((cause: unknown) => showWorktreeOutput(id, cause))
        .finally(done)
      return
    }

    void service
      .createWorktree(active.path)
      .then(async (created) => {
        if (!created.ok) {
          setWorktreeOutput({ sessionId: id, output: created.output })
          return
        }
        // The session may have been removed while the script ran: the result
        // is discarded and the worktree left exactly where it is.
        if (!sessionsNow.current.some((candidate) => candidate.id === id)) return
        await port.setWorktree(
          id,
          created.branch === undefined
            ? { path: created.path }
            : { path: created.path, branch: created.branch }
        )
      })
      .catch((cause: unknown) => showWorktreeOutput(id, cause))
      .finally(done)
  }

  function showWorktreeOutput(sessionId: SessionId, cause: unknown): void {
    setWorktreeOutput({
      sessionId,
      output: cause instanceof Error ? cause.message : String(cause)
    })
  }

  function removeSession(id: SessionId): void {
    setPopover('none')
    fetched.current.delete(id)
    // The session is going: what its last jump had to say goes with it.
    setJumps((current) => withoutJump(current, id))
    // Removing the session on screen lands on whichever becomes active next,
    // and landing anywhere is an arrival.
    if (id === activeSessionId) arrive()
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
        // held of the old one goes with it — a failed jump into a branch that
        // no longer exists included.
        setJumps((current) => withoutJump(current, id))
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
  // invalidating the cache is the point of the action. The whole of it is
  // owned by the session that asked for it, which is free to run in the
  // background while the user works somewhere else.
  function jump(ref: string, summarize: boolean): void {
    const id = activeSessionId
    if (id === undefined) return
    clearFailure(id)
    // A fresh attempt is the last failure gone: what it said is about a jump
    // the user has moved past.
    setJumps((current) =>
      withJump(current, id, { kind: summarize ? 'summarizing' : 'jumping', ref })
    )
    void port
      .jump(id, ref, { summarize })
      .then(async (outcome) => {
        // The user stopped it themselves: the leaf did not move, so the
        // transcript, the composer and the tree stand exactly as they were.
        if (outcome.cancelled) return
        // The overlay belongs to whoever is on screen: a jump that landed
        // while the user was elsewhere closes nothing where they are now.
        if (railNow.current.activeSessionId === id) setTreeOpen(false)
        announce(summarize ? JUMPED_WITH_SUMMARY : JUMPED, id)
        if (outcome.editorText !== undefined) restore(id, outcome.editorText)
        // The conversation stands somewhere else now, so the whole view is
        // replaced by the path it stands on — in its own session, active or
        // not.
        try {
          const path = await port.transcript(id)
          dispatch({ type: 'jumped', sessionId: id, items: path })
        } catch (cause) {
          report(cause, id)
        }
      })
      .catch((cause: unknown) => {
        // π's retries are spent and nothing moved. The summary's
        // failure stays with its session until the next attempt clears it;
        // a plain jump has no narration to leave behind and reports as any
        // other refusal does.
        if (summarize) {
          setJumps((current) =>
            withJump(current, id, { kind: 'failed', ref, message: messageOf(cause) })
          )
          return
        }
        report(cause, id)
      })
      .finally(() => {
        // A failure outlives the call it came from; every other kind is over
        // when the jump settles.
        setJumps((current) =>
          current[id]?.kind === 'failed' ? current : withoutJump(current, id)
        )
      })
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
    if (workspaceId === undefined || sessionDirectory === undefined) return
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
    clearFailure(activeSessionId)
    setRuns((current) => ({
      ...current,
      [workspaceId]: { command, output: '', state: 'running', sharing: false }
    }))
    void service
      .startRun(sessionDirectory, command)
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

  // The drawer offers no close while running and no reopen after close, so a
  // drawer that went with a live command in it would leave a process running
  // with no surface that knows about it: the command is stopped first, exactly
  // as the Stop button stops it, and nothing enters any conversation.
  //
  // Every drawer, not only the one on screen: an arrival may cross into
  // another workspace, and the drawer left behind is exactly the one nobody
  // would ever see again.
  function closeBash(): void {
    const open = runsNow.current
    runsNow.current = {}
    for (const view of Object.values(open)) {
      if (view.state !== 'running' || view.runId === undefined) continue
      void service.stopRun(view.runId).catch(() => {})
    }
    setRuns((current) => (Object.keys(current).length === 0 ? current : {}))
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

  // Nothing the board can do touches the repository.

  function openPullRequest(row: BoardRow): void {
    const pr = row.pr
    if (pr === undefined) return
    announce(`Opening #${pr.number} in your browser`)
    void service.openUrl(pr.url).catch(report)
  }

  function copyBranchName(name: string): void {
    announce(`Copied ${name}`)
    void navigator.clipboard?.writeText(name).catch(report)
  }

  /** Seeds the composer with what was selected. Nothing is sent. */
  function askAboutBranches(names: readonly string[]): void {
    const id = activeSessionId
    if (id === undefined) return
    closeBoard()
    const seeded = `${names.join('\n')}\n`
    setDrafts((current) => {
      const drafted = current[id] ?? ''
      // A draft being typed is never destroyed: it stays below the names, the
      // way a restored queued message does.
      return { ...current, [id]: drafted === '' ? seeded : `${seeded}\n${drafted}` }
    })
    seedCaret.current = seeded.length
  }

  // Nothing the issue board can do writes to the issue host. What it writes is
  // a session of the user's own.

  function openIssue(row: IssueRow): void {
    announce(`Opening ${row.reference} in your browser`)
    void service.openUrl(row.url).catch(report)
  }

  function copyReference(reference: string): void {
    announce(`Copied ${reference}`)
    void navigator.clipboard?.writeText(reference).catch(report)
  }

  // One click: a new session in this workspace, in a new worktree, with the
  // interview already sent. The command is Crucible's own and expands in main
  // before it crosses the port (ADR 0007).
  function alignOn(row: IssueRow, kind: 'align' | 'quick-align'): void {
    const workspaceId = activeWorkspaceId
    const workspace = active
    if (workspaceId === undefined || workspace === undefined || aligning !== undefined) return

    setAligning(row.reference)
    clearFailure(activeSessionId)
    setWorktreeOutput(undefined)
    closeIssues()

    void (async () => {
      const sessionId = await port.createSession(workspaceId, { issue: row.reference })
      // The chip says the worktree is being made, in the session it is being
      // made for, which is the one now on screen.
      setFlipping((current) => [...current, sessionId])
      try {
        const created = await service.createWorktree(workspace.path)
        if (!created.ok) {
          // The session stays open holding the script's whole output, and the
          // command is not sent. No silent fall back to the checkout: an
          // interview would then run in the live working directory (ADR 0013).
          setWorktreeOutput({ sessionId, output: created.output })
          return
        }
        await port.setWorktree(
          sessionId,
          created.branch === undefined
            ? { path: created.path }
            : { path: created.path, branch: created.branch }
        )
      } finally {
        setFlipping((current) => current.filter((waiting) => waiting !== sessionId))
      }

      // Reference, title and URL, and nothing else: the body goes stale, and
      // the agent can read it with gh whenever it wants it.
      const text = `/${kind} ${row.reference} — ${row.title}\n${row.url}`
      expanded(sessionId, text, (delivered) => {
        dispatch({ type: 'sent', sessionId, text: delivered, images: [] })
        void port.prompt(sessionId, delivered).catch(report)
      })
    })()
      .catch(report)
      .finally(() => setAligning(undefined))
  }

  const openWorkflowRun = useCallback((id: WorkflowRunId): void => {
    setOpenRunId(id)
    // A run is entered on its node detail, never on whatever was last read.
    setOpenArtifactPath(undefined)
  }, [])

  // The door out of a run surface: land in the orchestrator's chat, which
  // closes the run surfaces with everything else the arrival closes.
  const goToRunSession = useCallback(
    (sessionId: SessionId): void => {
      activateSession(sessionId)
    },
    [activateSession]
  )

  /** A fresh chat in a session-less run's workspace (the future unattended kind). */
  const startRunSession = useCallback(
    (workspaceId: WorkspaceId): void => {
      arrive()
      void port.createSession(workspaceId).catch(report)
    },
    [arrive, port, report]
  )

  const runTranscript = useCallback(
    (nodeId: string) =>
      workflowRuns === undefined || openRunId === undefined
        ? Promise.resolve([] as const)
        : workflowRuns.nodeTranscript(openRunId, nodeId),
    [workflowRuns, openRunId]
  )

  const runArtifact = useCallback(
    (path: string): Promise<ArtifactView> =>
      workflowRuns === undefined || openRunId === undefined
        ? Promise.reject(new Error('That run is no longer open.'))
        : workflowRuns.artifact(openRunId, path),
    [workflowRuns, openRunId]
  )

  // The app starts the investigation: a new session in the active workspace,
  // activated, with the opening prompt already sent. Whatever the ledger says
  // is in that prompt, so the agent needs nothing else to begin.
  async function investigateCache(): Promise<void> {
    const workspaceId = activeWorkspaceId
    if (workspaceId === undefined || cacheHealth === undefined) {
      throw new Error('Open a workspace first — an investigation runs in a session of its own.')
    }
    const text = investigationPrompt(cacheHealth)
    const sessionId = await port.createSession(workspaceId)
    await port.activateSession(sessionId)
    // Echoed in the transcript as any prompt is; the working state is the
    // wait indicator from here.
    dispatch({ type: 'sent', sessionId, text, images: [] })
    await port.prompt(sessionId, text)
    setCacheOpen(false)
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
        needsYou={asking}
        runActivity={railRuns}
        boardNeedYou={boardNeedYou}
        onNewSession={newSession}
        onAddWorkspace={addWorkspace}
        onActivateWorkspace={activateWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onActivateSession={activateSession}
        onRemoveSession={removeSession}
        onResume={() => setPopover('resume')}
        cache={
          cacheService === undefined
            ? undefined
            : { health: cacheHealth, onOpen: () => setCacheOpen(true) }
        }
        quota={
          quota === undefined
            ? undefined
            : { snapshot: quotaHold.snapshot, now: quotaHold.now }
        }
      />

      <main className="main">
        <TopBar
          session={session}
          menuOpen={popover === 'sessionMenu'}
          treeOpen={treeOpen}
          onToggleMenu={() => setPopover(popover === 'sessionMenu' ? 'none' : 'sessionMenu')}
          onToggleTree={() => {
            if (treeOpen) setTreeOpen(false)
            else openTree()
          }}
          onResetSession={resetSession}
          onOpenSettings={() => setSettings({ open: true, tab: 'providers' })}
          onOpenUsage={() => setSettings({ open: true, tab: 'usage' })}
          onJumpToCacheMiss={() => setMissJump((asked) => asked + 1)}
          issues={
            issues === undefined
              ? undefined
              : { open: issues.open, yours: issues.yours, onOpen: openIssues }
          }
          board={
            counts === undefined
              ? undefined
              : { landed: counts.landed, needYou: counts.needYou, onOpen: openBoard }
          }
          update={
            updateCommit === undefined || appUpdate === undefined
              ? undefined
              : {
                  commit: updateCommit,
                  onRestart: () => {
                    void appUpdate.restart().catch(() => {})
                  }
                }
          }
        />

        <RunStrip runs={sessionRuns} onOpen={openWorkflowRun} />

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
            <Transcript
              items={items}
              sessionId={session.id}
              invocations={shownInvocations}
              missJump={missJump}
            />
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
                jump={activeJump}
                onJump={jump}
                onLabel={label}
                onClose={() => setTreeOpen(false)}
              />
            )
          ) : null}

          {toast === undefined || toast.sessionId !== activeSessionId ? null : (
            <p className="toast" role="status">
              {toast.text}
            </p>
          )}
        </div>

        {failure === undefined || failure.sessionId !== activeSessionId ? null : (
          <p className="failure" role="alert">
            {failure.message}
          </p>
        )}

        {/* A summarize keeps running behind a closed overlay, and a session
            that looks idle while it pays for a call is a wait nobody can see.
            The failure outlives the call, so it is read the moment the user
            arrives, before they reopen anything. */}
        {activeJump === undefined || treeShowing ? null : activeJump.kind === 'failed' ? (
          <p className="failure" role="alert">
            {jumpNote(activeJump)}
          </p>
        ) : (
          <p className="jumpline" role="status">
            <span className="spin" aria-hidden="true" />
            {jumpNote(activeJump)}
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
          modelId={shownModel}
          models={models}
          modelPickerOpen={popover === 'model'}
          thinkingLevel={session?.thinkingLevel}
          thinkingMenuOpen={popover === 'thinking'}
          attachments={chips}
          files={shownFiles}
          commands={browsingCommands ? commandList : undefined}
          workspaceName={active?.name}
          sessionDirectory={sessionDirectory}
          worktree={session?.worktree}
          worktreeShown={active !== undefined && gitWorkspaces[active.id] === true}
          worktreeBusy={flipInFlight}
          worktreeLocked={session !== undefined && !session.fresh}
          worktreeOutput={
            worktreeOutput !== undefined && worktreeOutput.sessionId === activeSessionId
              ? worktreeOutput.output
              : undefined
          }
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
          onToggleWorktree={toggleWorktree}
        />

        {/* Over the whole main column, top bar and composer included, and
            never over the sidebar. */}
        {boardOpen ? (
          <BranchBoard
            board={board}
            refreshing={boardEntry?.refreshing ?? false}
            failure={boardEntry?.failure}
            hasSession={session !== undefined}
            onRefresh={() => {
              if (activeWorkspaceId !== undefined) refreshBoard(activeWorkspaceId)
            }}
            onOpenPr={openPullRequest}
            onCopy={copyBranchName}
            onAsk={askAboutBranches}
            onClose={closeBoard}
          />
        ) : null}

        {runsOverviewOpen ? (
          <RunsOverview
            runs={allRuns}
            workspaces={snapshot.workspaces}
            sessions={snapshot.sessions}
            onOpenRun={openWorkflowRun}
            onGoToSession={goToRunSession}
            onStartSession={startRunSession}
            onClose={() => setRunsOverviewOpen(false)}
          />
        ) : null}

        {/* Rendered after the overview so an opened run sits above it and Esc
            unwinds in the order the surfaces were entered. */}
        {openRun !== undefined && workflowRuns !== undefined ? (
          <WorkflowRunView
            run={openRun}
            canGoToSession={
              openRun.sessionId !== undefined &&
              snapshot.sessions.some((candidate) => candidate.id === openRun.sessionId)
            }
            transcript={runTranscript}
            artifact={runArtifact}
            openArtifact={openArtifactPath}
            onOpenArtifact={setOpenArtifactPath}
            onRevealArtifact={(path) =>
              void workflowRuns.revealArtifact(openRun.id, path).catch(report)
            }
            onCopyPath={(path) => void navigator.clipboard?.writeText(path).catch(report)}
            onGoToSession={() => {
              if (openRun.sessionId !== undefined) goToRunSession(openRun.sessionId)
            }}
            onPause={() => void workflowRuns.pause(openRun.id).catch(report)}
            onResume={() => void workflowRuns.resume(openRun.id).catch(report)}
            onCancel={() => void workflowRuns.cancel(openRun.id).catch(report)}
            onClose={() => setOpenRunId(undefined)}
          />
        ) : null}

        {issuesOpen ? (
          <IssueBoard
            answer={issueAnswer}
            refreshing={issueEntry?.refreshing ?? false}
            failure={issueEntry?.failure}
            sessions={issueSessions}
            aligning={aligning}
            onRefresh={() => {
              if (activeWorkspaceId !== undefined) refreshIssues(activeWorkspaceId)
            }}
            onAlign={alignOn}
            onOpenSession={(sessionId) => {
              closeIssues()
              activateSession(sessionId)
            }}
            onOpenIssue={openIssue}
            onCopy={copyReference}
            onClose={closeIssues}
          />
        ) : null}
      </main>

      {/* Nothing at all when the session has no tabs: the chat is full-width,
          and there is no empty panel and no edge strip to explain. */}
      {panel === undefined || activeSessionId === undefined ? null : panelCollapsed ? (
        <PanelEdge
          count={panel.tabs.length}
          onOpen={() => setCollapsed((current) => ({ ...current, [activeSessionId]: false }))}
        />
      ) : (
        <ContextPanel
          panel={panel}
          sessionId={activeSessionId}
          width={panelWidth}
          port={port}
          onResize={setPanelWidth}
          onCollapse={() => setCollapsed((current) => ({ ...current, [activeSessionId]: true }))}
        />
      )}

      {veil ? (
        <div className="veil" role="status">
          Drop images to attach
        </div>
      ) : null}

      {popover === 'resume' ? (
        <ResumeOverlay onSearch={search} onChoose={resume} onClose={() => setPopover('none')} />
      ) : null}

      {settings.open ? (
        <Settings
          tab={settings.tab}
          onTab={(tab) => setSettings((current) => ({ ...current, tab }))}
          onClose={() => setSettings((current) => ({ ...current, open: false }))}
          port={port}
          auth={auth}
          workspace={active}
          sessions={snapshot.sessions.filter(
            (candidate) => candidate.workspaceId === activeWorkspaceId
          )}
          activeSessionId={activeSessionId}
          contextPercent={contextPercent(session?.usage)}
        />
      ) : null}

      {cacheOpen && cacheService !== undefined && cacheHealth !== undefined ? (
        <CacheHealthView
          health={cacheHealth}
          workspaceOpen={activeWorkspaceId !== undefined}
          // Appends a reset line and nothing else: the misses underneath
          // survive it, which is what makes reset cheap enough to need no
          // confirmation.
          onReset={() => cacheService.reset().then(() => {})}
          onInvestigate={investigateCache}
          // The button says it copied; a toast over the transcript would be a
          // second answer to one click.
          onCopy={(path) => void navigator.clipboard?.writeText(path).catch(report)}
          onClose={() => setCacheOpen(false)}
        />
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

/** Display-safe text of a refusal, which is all a banner ever shows. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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
