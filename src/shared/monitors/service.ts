// The seam the monitor surfaces are driven through: the renderer sees this
// interface and nothing behind it, so a component test hands in a fake and the
// IPC client implements the same shape over the preload bridge. Main holds a
// superset with the tool behaviors, the engine's wait and the lifecycle the
// window never sees.

import type { SessionId, SystemMessage, Unsubscribe } from '../agent/port'
import type { BoundMonitorTools, MonitorTools } from '../agent/monitor-tools'
import type {
  LiveMonitor,
  LostMonitor,
  MonitorId,
  MonitorOwner,
  MonitorScope
} from './monitor'
import type { NodeWait } from '../workflows/run'

export interface MonitorsSnapshot {
  /** Live session monitors of every session, oldest set first. Nothing ended, ever. */
  readonly monitors: readonly LiveMonitor[]
}

// The whole snapshot on every change, like the run seam: nothing is patched,
// so a dropped frame self-heals on the next one.
export type MonitorEvent = { readonly type: 'monitors'; readonly snapshot: MonitorsSnapshot }

export type MonitorListener = (event: MonitorEvent) => void

export interface MonitorService {
  snapshot(): Promise<MonitorsSnapshot>
  /** Live-only: no replay, no backlog. */
  onEvent(listener: MonitorListener): Unsubscribe
  // The user's ✕ and the detail's Stop: no wake, and a note on the session's
  // next user turn. Refuses a node's monitor and an unknown or ended id with a
  // sentence.
  stop(monitorId: MonitorId): Promise<void>
}

/** A node's monitor ending, as the engine receives it: its next message. */
export interface NodeWake {
  readonly text: string
}

/** What the engine holds: enough to wait, never enough to converse. */
export interface NodeMonitors {
  tools(owner: Extract<MonitorOwner, { kind: 'node' }>, cwd: string): BoundMonitorTools
  // Undefined when the node has nothing live and nothing owed, so the caller
  // takes its ordinary path. Otherwise what the chip should say and a promise
  // of the next wake: one already owed resolves at once. One call, so a
  // monitor ending between "is it live" and "wait" cannot lose its wake.
  // Rejects when the owner is released.
  wait(
    owner: Extract<MonitorOwner, { kind: 'node' }>
  ): { readonly on: NodeWait; readonly wake: Promise<NodeWake> } | undefined
  /** The monitors a quit cut down under this node, handed over once and deleted. */
  takeLost(owner: Extract<MonitorOwner, { kind: 'node' }>): readonly LostMonitor[]
  release(scope: MonitorScope): void
}

export interface MainMonitorService extends MonitorService {
  readonly tools: MonitorTools
  readonly nodes: NodeMonitors
  // After the window exists and the inbox is wired: resumes every live session
  // monitor's loop and delivers every owed session wake. Before it, nothing
  // checks and nothing is delivered.
  begin(): void
  // Consulted once at the start of every user turn of a session, beside the
  // run service's hook: the note for every session monitor the user stopped
  // since the last turn, composed once and the records then deleted.
  turnStart(sessionId: SessionId): string | undefined
  // The owner ceased to exist: every live monitor of the scope ends at once
  // with no wake, every owed record is dropped, every in-flight check is
  // killed, every pending `wait` rejects.
  release(scope: MonitorScope): void
  /** Kills in-flight checks; records stay as they are for the next launch. */
  dispose(): void
}

/** How a session's wake travels out of the model. */
export type DeliverMonitorMessage = (
  sessionId: SessionId,
  message: SystemMessage
) => Promise<'delivered' | 'no-session'>
