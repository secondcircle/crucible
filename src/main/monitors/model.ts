import { randomBytes } from 'node:crypto'
import type { SessionId, Unsubscribe } from '../../shared/agent/port'
import {
  bindMonitorTools,
  monitorRequestFrom,
  type BoundMonitorTools,
  type MonitorRequest,
  type MonitorTools
} from '../../shared/agent/monitor-tools'
import {
  boundOutput,
  BROKE_STRIKES,
  RETAINED_OUTPUT_CHARS,
  timingInForce,
  type LastCheck,
  type LiveMonitor,
  type LostMonitor,
  type MonitorEnding,
  type MonitorId,
  type MonitorOwner,
  type MonitorScope
} from '../../shared/monitors/monitor'
import type {
  DeliverMonitorMessage,
  MainMonitorService,
  MonitorEvent,
  MonitorListener,
  MonitorsSnapshot,
  NodeMonitors,
  NodeWake
} from '../../shared/monitors/service'
import {
  composeWake,
  listAnswer,
  setAnswer,
  stopAnswer,
  stopRefusal,
  stoppedNote
} from '../../shared/monitors/wording'
import type { CheckRun, CheckRunner, CheckResult } from './check-runner'
import type { MonitorStore } from './store'

// The monitor model: the records, the check loop, the endings, the delivery
// and the load-time sweep, for both flavors. The only thing a flavor decides
// is the process seam behind it — real bash or a scripted runner — so the two
// cannot drift into meaning different things by a monitor.
//
// Ordering rules that are architectural, and live nowhere else:
//
//  - A monitor ends exactly once. `end` is the only transition out of `live`
//    and returns early on an already-ended id, so a process result, a deadline
//    and a stop racing each other settle to one ending and the losers are
//    dropped.
//  - Checks of one monitor never overlap: the next is scheduled from the
//    moment the previous one finished.
//  - A check that exits 0 ends the monitor in the same transition that records
//    it, so no live record ever holds a passing result.
//  - An ending emits the snapshot before it delivers, so the chip is gone from
//    the strip before the wake is in the transcript.

interface MonitorFacts {
  readonly id: MonitorId
  readonly owner: MonitorOwner
  readonly description: string
  readonly reason: string
  readonly command: string
  /** Fixed at set time; no transition writes it again. */
  readonly cwd: string
  readonly intervalMs: number
  readonly timeoutMs: number
  /** ISO. The deadline is `setAt + timeoutMs`, wall clock, never paused. */
  readonly setAt: string
  readonly checks: number
  readonly last?: LastCheck
}

export interface LiveMonitorRecord extends MonitorFacts {
  readonly status: 'live'
  // Consecutive non-zero exits whose stderr was identical (trimmed). Absent
  // means the last check exited 0, exited quietly, or failed in a new way.
  readonly strikes?: { readonly stderr: string; readonly count: number }
}

// What an ended record still owes somebody. A record that owes nothing is
// deleted, never stored: "ended, delivered" is not a state.
export type Owed =
  | { readonly kind: 'wake'; readonly ending: MonitorEnding }
  /** The user stopped it; the next user turn's context says so once. */
  | { readonly kind: 'note' }
  /** Crucible quit under it; the node hears on Resume. */
  | { readonly kind: 'lost' }

export interface EndedMonitorRecord extends MonitorFacts {
  readonly status: 'ended'
  readonly endedAt: string
  readonly owed: Owed
}

export type MonitorRecord = LiveMonitorRecord | EndedMonitorRecord

export interface MonitorModelOptions {
  readonly store: MonitorStore
  readonly checks: CheckRunner
  // How a session's wake travels. `'no-session'` means the owner is gone and
  // the wake is dropped; a rejection means "not now" — no shell yet — and the
  // record stays owed until the next flush.
  readonly deliver: DeliverMonitorMessage
  /** The shell store's answer: a record for a gone session is dropped silently. */
  readonly sessionExists: (sessionId: SessionId) => boolean
  /** Milliseconds; tests pin it. */
  readonly now?: () => number
  readonly mintId?: () => MonitorId
  readonly log?: (event: Record<string, unknown>) => void
}

/** How long a wake that could not be delivered waits before trying again. */
const DELIVERY_RETRY_MS = 5_000

/** How an ending was reached, which decides what the record then owes. */
type Ending =
  | { readonly kind: 'wake'; readonly ending: MonitorEnding }
  /** The user's ✕ or Stop: no wake, a note on the next user turn. */
  | { readonly kind: 'user' }
  /** The agent's own tool call: no wake, nothing owed. */
  | { readonly kind: 'agent' }
  /** The owner ceased to exist: silent, nothing owed, nothing said. */
  | { readonly kind: 'gone' }

interface Timers {
  deadline?: ReturnType<typeof setTimeout>
  next?: ReturnType<typeof setTimeout>
  run?: CheckRun
}

interface NodeWaiter {
  resolve(wake: NodeWake): void
  reject(cause: Error): void
}

export function createMonitorModel(options: MonitorModelOptions): MainMonitorService {
  const {
    store,
    checks: runner,
    deliver,
    sessionExists,
    now = () => Date.now(),
    mintId,
    log
  } = options

  const records: MonitorRecord[] = [...store.load()]
  const timers = new Map<MonitorId, Timers>()
  const waiters = new Map<string, NodeWaiter>()
  const listeners = new Set<MonitorListener>()
  // Wakes whose delivery is in flight. An owed record stays owed until the
  // road answers, and this is what keeps a flush from sending it a second
  // time while the first attempt is still out.
  const delivering = new Set<MonitorId>()
  let started = false
  let retrying: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  // The load sweep, at construction because a node's lost monitors must be
  // there for the first Resume whether or not a window ever opened: a node's
  // monitor does not survive a quit, so every node-owned live record becomes
  // the notice its node reads when the run is resumed, and anything a node was
  // merely owed dies with the run it belonged to.
  for (const record of [...records]) {
    if (record.owner.kind !== 'node') continue
    if (record.status === 'live') {
      replace({
        ...factsOf(record),
        status: 'ended',
        endedAt: record.last?.at ?? record.setAt,
        owed: { kind: 'lost' }
      })
      continue
    }
    if (record.owed.kind !== 'lost') drop(record.id)
  }
  store.save(records)

  function nowIso(): string {
    return new Date(now()).toISOString()
  }

  function emit(): void {
    const event: MonitorEvent = { type: 'monitors', snapshot: snapshotNow() }
    for (const listener of [...listeners]) listener(event)
  }

  function snapshotNow(): MonitorsSnapshot {
    return {
      monitors: records
        .filter(
          (record): record is LiveMonitorRecord =>
            record.status === 'live' && record.owner.kind === 'session'
        )
        .map(projected)
    }
  }

  function projected(record: LiveMonitorRecord): LiveMonitor {
    return {
      id: record.id,
      sessionId: record.owner.kind === 'session' ? record.owner.sessionId : '',
      description: record.description,
      reason: record.reason,
      command: record.command,
      cwd: record.cwd,
      intervalMs: record.intervalMs,
      timeoutMs: record.timeoutMs,
      setAt: record.setAt,
      checks: record.checks,
      ...(record.last === undefined ? {} : { last: record.last })
    }
  }

  function factsOf(record: MonitorRecord): MonitorFacts {
    const {
      id,
      owner,
      description,
      reason,
      command,
      cwd,
      intervalMs,
      timeoutMs,
      setAt,
      checks,
      last
    } = record
    return {
      id,
      owner,
      description,
      reason,
      command,
      cwd,
      intervalMs,
      timeoutMs,
      setAt,
      checks,
      ...(last === undefined ? {} : { last })
    }
  }

  function at(id: MonitorId): number {
    return records.findIndex((record) => record.id === id)
  }

  function held(id: MonitorId): MonitorRecord | undefined {
    return records.find((record) => record.id === id)
  }

  function liveRecord(id: MonitorId): LiveMonitorRecord | undefined {
    const record = held(id)
    return record?.status === 'live' ? record : undefined
  }

  function replace(record: MonitorRecord): void {
    const index = at(record.id)
    if (index === -1) records.push(record)
    else records[index] = record
  }

  function drop(id: MonitorId): void {
    const index = at(id)
    if (index >= 0) records.splice(index, 1)
  }

  function timersOf(id: MonitorId): Timers {
    const found = timers.get(id)
    if (found !== undefined) return found
    const fresh: Timers = {}
    timers.set(id, fresh)
    return fresh
  }

  function clearTimers(id: MonitorId): void {
    const found = timers.get(id)
    if (found === undefined) return
    if (found.deadline !== undefined) clearTimeout(found.deadline)
    if (found.next !== undefined) clearTimeout(found.next)
    found.run?.kill()
    timers.delete(id)
  }

  function ownerKey(owner: MonitorOwner): string {
    return owner.kind === 'session'
      ? `session:${owner.sessionId}`
      : `node:${owner.runId}:${owner.nodeId}`
  }

  function sameOwner(left: MonitorOwner, right: MonitorOwner): boolean {
    return ownerKey(left) === ownerKey(right)
  }

  function inScope(owner: MonitorOwner, scope: MonitorScope): boolean {
    if (scope.kind === 'run') return owner.kind === 'node' && owner.runId === scope.runId
    return sameOwner(owner, scope)
  }

  function mint(): MonitorId {
    for (;;) {
      const id = mintId === undefined ? `m-${randomBytes(2).toString('hex')}` : mintId()
      if (!records.some((record) => record.id === id)) return id
    }
  }

  // --- the loop -------------------------------------------------------------

  function armDeadline(record: LiveMonitorRecord): void {
    const deadline = Date.parse(record.setAt) + record.timeoutMs
    const timer = timersOf(record.id)
    if (timer.deadline !== undefined) clearTimeout(timer.deadline)
    timer.deadline = setTimeout(
      () => {
        // A check may be in flight; the deadline stops it and the monitor ends
        // timed out, because the clock is not waiting on a command.
        if (liveRecord(record.id) === undefined) return
        end(record.id, { kind: 'wake', ending: { reason: 'timedOut' } })
      },
      Math.max(0, deadline - now())
    )
  }

  function scheduleNext(id: MonitorId, delayMs: number): void {
    const record = liveRecord(id)
    if (record === undefined) return
    const deadline = Date.parse(record.setAt) + record.timeoutMs
    const startAt = now() + Math.max(0, delayMs)
    // Nothing is scheduled past the deadline: the deadline timer owns that
    // moment, and a check that could not finish before it would be answering a
    // monitor that has already ended.
    if (startAt > deadline) return
    const timer = timersOf(id)
    if (timer.next !== undefined) clearTimeout(timer.next)
    timer.next = setTimeout(() => {
      timer.next = undefined
      check(id)
    }, Math.max(0, delayMs))
  }

  function check(id: MonitorId): void {
    const record = liveRecord(id)
    if (record === undefined) return
    const timer = timersOf(id)
    const run = runner.run(record.command, record.cwd)
    timer.run = run
    void run.done.then((result) => {
      // A result for a run that was superseded or killed belongs to nobody.
      if (timers.get(id)?.run !== run) return
      timer.run = undefined
      if (result.kind === 'killed') return
      landed(id, result)
    })
  }

  function landed(id: MonitorId, result: Exclude<CheckResult, { kind: 'killed' }>): void {
    const record = liveRecord(id)
    if (record === undefined) return

    const finishedAt = now()
    const text = result.kind === 'exited' ? result.output : result.message
    const last: LastCheck = {
      at: new Date(finishedAt).toISOString(),
      output: boundOutput(text, RETAINED_OUTPUT_CHARS),
      result:
        result.kind === 'exited'
          ? { kind: 'exited', exitCode: result.exitCode }
          : { kind: 'failed', message: result.message }
    }

    // A process that never ran breaks the monitor at once: retrying to the
    // timeout would tell the agent nothing it does not already know.
    if (result.kind === 'failed') {
      replace({ ...record, checks: record.checks + 1, last })
      end(id, { kind: 'wake', ending: { reason: 'broke', error: result.message } })
      return
    }

    const stderr = result.stderr.trim()

    if (result.exitCode === 126 || result.exitCode === 127) {
      replace({ ...record, checks: record.checks + 1, last })
      end(id, {
        kind: 'wake',
        ending: {
          reason: 'broke',
          error:
            stderr === ''
              ? `the command could not be run (exit ${result.exitCode})`
              : stderr
        }
      })
      return
    }

    if (result.exitCode === 0) {
      replace({ ...record, checks: record.checks + 1, last })
      end(id, { kind: 'wake', ending: { reason: 'met' } })
      return
    }

    // Any other exit is "keep waiting". A quiet one never breaks anything,
    // however often it repeats: that is exactly what a healthy wait looks like.
    const strikes =
      stderr === ''
        ? undefined
        : record.strikes?.stderr === stderr
          ? { stderr, count: record.strikes.count + 1 }
          : { stderr, count: 1 }

    // Rebuilt from the facts rather than spread over the old record, so a
    // cleared strike is genuinely gone rather than merely overwritten.
    replace({
      ...factsOf(record),
      checks: record.checks + 1,
      last,
      status: 'live',
      ...(strikes === undefined ? {} : { strikes })
    })

    if (strikes !== undefined && strikes.count >= BROKE_STRIKES) {
      end(id, { kind: 'wake', ending: { reason: 'broke', error: strikes.stderr } })
      return
    }

    store.save(records)
    if (record.owner.kind === 'session') emit()
    scheduleNext(id, record.intervalMs)
  }

  // --- endings --------------------------------------------------------------

  function end(id: MonitorId, how: Ending): void {
    const record = liveRecord(id)
    if (record === undefined) return
    clearTimers(id)

    const ended: EndedMonitorRecord = {
      ...factsOf(record),
      status: 'ended',
      endedAt: nowIso(),
      owed:
        how.kind === 'wake'
          ? { kind: 'wake', ending: how.ending }
          : how.kind === 'user'
            ? { kind: 'note' }
            : { kind: 'lost' }
    }

    // An ending that owes nothing is not a state: the record simply goes.
    if (how.kind === 'agent' || how.kind === 'gone') drop(id)
    else replace(ended)

    store.save(records)
    log?.({
      event: 'monitor_ended',
      monitorId: id,
      how: how.kind,
      ...(how.kind === 'wake' ? { reason: how.ending.reason } : {}),
      checks: record.checks
    })
    // The chip leaves the strip before the wake reaches the transcript.
    if (record.owner.kind === 'session') emit()
    if (how.kind === 'wake') settle(ended, how.ending)
  }

  /** Hands an ended record's wake to whoever is owed it, or keeps it owed. */
  function settle(record: EndedMonitorRecord, ending: MonitorEnding): void {
    const facts = {
      monitorId: record.id,
      description: record.description,
      ending,
      waitedMs: Math.max(0, Date.parse(record.endedAt) - Date.parse(record.setAt)),
      checks: record.checks,
      ...(record.last === undefined ? {} : { lastOutput: record.last.output })
    }

    if (record.owner.kind === 'node') {
      const waiter = waiters.get(ownerKey(record.owner))
      // Nobody is parked on it: the run is paused, or the node is mid-turn.
      // The wake is held until the engine asks, and a held wake is exactly
      // what makes a paused run's node never lose the answer it waited for.
      if (waiter === undefined) return
      waiters.delete(ownerKey(record.owner))
      drop(record.id)
      store.save(records)
      waiter.resolve({ text: composeWake(facts).text })
      return
    }

    const sessionId = record.owner.sessionId
    if (delivering.has(record.id)) return
    delivering.add(record.id)
    void deliver(sessionId, composeWake(facts))
      .then((outcome) => {
        delivering.delete(record.id)
        // Delivered, or the session no longer exists: either way the debt is
        // settled and the record goes.
        if (held(record.id) === undefined) return
        drop(record.id)
        store.save(records)
        log?.({ event: 'monitor_wake', monitorId: record.id, sessionId, outcome })
      })
      .catch((cause: unknown) => {
        delivering.delete(record.id)
        // "Not now": no shell is up yet, or the road is momentarily shut. The
        // record stays owed and the flush tries again.
        log?.({
          event: 'monitor_wake_deferred',
          monitorId: record.id,
          sessionId,
          message: cause instanceof Error ? cause.message : String(cause)
        })
        retryLater()
      })
  }

  function retryLater(): void {
    if (!started || disposed || retrying !== undefined) return
    retrying = setTimeout(() => {
      retrying = undefined
      flushOwed()
    }, DELIVERY_RETRY_MS)
  }

  /** Every owed session wake, tried again. A wake is never lost. */
  function flushOwed(): void {
    for (const record of [...records]) {
      if (record.status !== 'ended' || record.owner.kind !== 'session') continue
      if (record.owed.kind !== 'wake') continue
      settle(record, record.owed.ending)
    }
  }

  // --- the sweep ------------------------------------------------------------

  function begin(): void {
    if (started || disposed) return
    started = true

    for (const record of [...records]) {
      if (record.owner.kind !== 'session') continue
      // A session the user removed while Crucible was closed owes nobody
      // anything: its agent ceased to exist.
      if (!sessionExists(record.owner.sessionId)) {
        drop(record.id)
        continue
      }
      if (record.status !== 'live') continue
      const deadline = Date.parse(record.setAt) + record.timeoutMs
      // The clock counted wall time across the gap, so a wait whose time ran
      // out while Crucible was closed ends timed out without checking again.
      if (deadline <= now()) {
        end(record.id, { kind: 'wake', ending: { reason: 'timedOut' } })
        continue
      }
      armDeadline(record)
      const since = record.last === undefined ? undefined : Date.parse(record.last.at)
      const nextAt = since === undefined ? now() : since + record.intervalMs
      scheduleNext(record.id, Math.max(0, nextAt - now()))
    }

    store.save(records)
    emit()
    flushOwed()
  }

  // --- the tool behaviors ---------------------------------------------------

  const tools: MonitorTools = {
    async set(owner: MonitorOwner, cwd: string, request: MonitorRequest): Promise<string> {
      // Checked again here, so the boundary holds whoever built the request:
      // a blank field never becomes a monitor nobody can read.
      const asked = monitorRequestFrom(request)
      const timing = timingInForce(asked)
      const record: LiveMonitorRecord = {
        id: mint(),
        owner,
        description: asked.description,
        reason: asked.reason,
        command: asked.command,
        cwd,
        intervalMs: timing.intervalMs,
        timeoutMs: timing.timeoutMs,
        setAt: nowIso(),
        checks: 0,
        status: 'live'
      }
      records.push(record)
      store.save(records)
      log?.({
        event: 'monitor_set',
        monitorId: record.id,
        owner: ownerKey(owner),
        intervalMs: timing.intervalMs,
        timeoutMs: timing.timeoutMs
      })
      if (owner.kind === 'session') emit()
      armDeadline(record)
      // The first check runs at once, so the chip has something to say within
      // seconds rather than at the end of the first interval.
      check(record.id)
      return setAnswer(record, timing)
    },

    async list(owner: MonitorOwner): Promise<string> {
      const mine = records.filter(
        (record): record is LiveMonitorRecord =>
          record.status === 'live' && sameOwner(record.owner, owner)
      )
      return listAnswer(mine, now())
    },

    async stop(owner: MonitorOwner, monitorId: string): Promise<string> {
      const record = held(monitorId)
      // Unknown, already ended, or somebody else's: all one answer, because
      // telling one agent that another's monitor exists is a leak.
      if (record === undefined || record.status !== 'live' || !sameOwner(record.owner, owner)) {
        return stopRefusal(monitorId)
      }
      end(monitorId, { kind: 'agent' })
      return stopAnswer(record.description)
    }
  }

  const nodes: NodeMonitors = {
    tools(owner, cwd): BoundMonitorTools {
      return bindMonitorTools(tools, owner, cwd)
    },

    wait(owner) {
      const key = ownerKey(owner)
      // An ending that arrived while nobody was parked is answered first, so a
      // monitor that ended between "is it live" and "wait" cannot lose its
      // wake.
      const owedHere = records.find(
        (record): record is EndedMonitorRecord =>
          record.status === 'ended' &&
          record.owed.kind === 'wake' &&
          sameOwner(record.owner, owner)
      )
      if (owedHere !== undefined && owedHere.owed.kind === 'wake') {
        const ending = owedHere.owed.ending
        drop(owedHere.id)
        store.save(records)
        return {
          on: {
            monitorId: owedHere.id,
            description: owedHere.description,
            since: owedHere.setAt
          },
          wake: Promise.resolve({
            text: composeWake({
              monitorId: owedHere.id,
              description: owedHere.description,
              ending,
              waitedMs: Math.max(0, Date.parse(owedHere.endedAt) - Date.parse(owedHere.setAt)),
              checks: owedHere.checks,
              ...(owedHere.last === undefined ? {} : { lastOutput: owedHere.last.output })
            }).text
          })
        }
      }

      const live = records
        .filter(
          (record): record is LiveMonitorRecord =>
            record.status === 'live' && sameOwner(record.owner, owner)
        )
        .sort((left, right) => Date.parse(left.setAt) - Date.parse(right.setAt))
      const longest = live[0]
      if (longest === undefined) return undefined

      const wake = new Promise<NodeWake>((resolve, reject) => {
        waiters.set(key, { resolve, reject })
      })
      return {
        on: { monitorId: longest.id, description: longest.description, since: longest.setAt },
        wake
      }
    },

    takeLost(owner): readonly LostMonitor[] {
      const mine = records.filter(
        (record): record is EndedMonitorRecord =>
          record.status === 'ended' && record.owed.kind === 'lost' && sameOwner(record.owner, owner)
      )
      if (mine.length === 0) return []
      for (const record of mine) drop(record.id)
      store.save(records)
      return mine.map((record) => ({
        description: record.description,
        command: record.command,
        waitedMs: Math.max(0, Date.parse(record.endedAt) - Date.parse(record.setAt)),
        timeoutMs: record.timeoutMs
      }))
    },

    release(scope: MonitorScope): void {
      release(scope)
    }
  }

  function release(scope: MonitorScope): void {
    let touched = false
    for (const record of [...records]) {
      if (!inScope(record.owner, scope)) continue
      touched ||= record.owner.kind === 'session'
      if (record.status === 'live') {
        // Silent: no wake, no note, no message to anybody. The agent that set
        // it does not exist any more.
        clearTimers(record.id)
      }
      drop(record.id)
    }
    for (const [key, waiter] of [...waiters]) {
      const owner = ownerFromKey(key)
      if (owner === undefined || !inScope(owner, scope)) continue
      waiters.delete(key)
      waiter.reject(new Error('the monitor’s owner is gone'))
    }
    store.save(records)
    if (touched) emit()
  }

  function ownerFromKey(key: string): MonitorOwner | undefined {
    const parts = key.split(':')
    if (parts[0] === 'session') return { kind: 'session', sessionId: parts.slice(1).join(':') }
    if (parts[0] === 'node') return { kind: 'node', runId: parts[1], nodeId: parts.slice(2).join(':') }
    return undefined
  }

  return {
    async snapshot(): Promise<MonitorsSnapshot> {
      return snapshotNow()
    },

    onEvent(listener: MonitorListener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async stop(monitorId: MonitorId): Promise<void> {
      const record = held(monitorId)
      if (record === undefined || record.status !== 'live') {
        throw new Error('That monitor is no longer live.')
      }
      // A run's wait is the run's; Pause and Cancel stay a run's only
      // mechanical controls, so there is no ✕ for one anywhere.
      if (record.owner.kind === 'node') {
        throw new Error(
          'That wait belongs to a run. Pause or cancel the run instead — a node’s monitor is ' +
            'not the user’s to stop.'
        )
      }
      end(monitorId, { kind: 'user' })
    },

    tools,
    nodes,
    begin,

    turnStart(sessionId: SessionId): string | undefined {
      const stopped = records.filter(
        (record): record is EndedMonitorRecord =>
          record.status === 'ended' &&
          record.owed.kind === 'note' &&
          record.owner.kind === 'session' &&
          record.owner.sessionId === sessionId
      )
      if (stopped.length === 0) return undefined
      for (const record of stopped) drop(record.id)
      store.save(records)
      return stoppedNote(
        stopped.map((record) => ({
          description: record.description,
          waitedMs: Math.max(0, Date.parse(record.endedAt) - Date.parse(record.setAt)),
          checks: record.checks
        }))
      )
    },

    release,

    dispose(): void {
      if (disposed) return
      disposed = true
      if (retrying !== undefined) clearTimeout(retrying)
      for (const id of [...timers.keys()]) clearTimers(id)
      listeners.clear()
    }
  }
}
