import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import {
  APPENDIX_GAP,
  type Appended,
  type RuleAgent,
  type RuleDelivery,
  type RuleGate,
  type RuleNote,
  type RuleWatch
} from '../../shared/rules/gate'
import {
  ruleMessage,
  tracksOutcome,
  type CatalogRule,
  type Delivery,
  type Firing,
  type LedgerLine,
  type Outcome,
  type RuleAgentRef,
  type RuleTrigger
} from '../../shared/rules/ledger'
import { hunkOf, lineDiff } from './diff'
import type { JudgeConfig, RuleRun, WireEvent } from './host/engine'
import type { RuleHost } from './host/host'
import type { NewLine, RulesLedger } from './ledger'

// The gate: what every agent loop's hooks call, in either flavor. It asks the
// workspace's rule host what the rules decided, delivers what an enforce rule
// said by the one road its action allows, writes every firing to the ledger,
// and follows each open item until something comes of it. Nothing here ever
// throws into a turn: a host that fails leaves the turn exactly as it was.

/** How long the whole path may take and still be read in the same tool result. */
export const INLINE_MS = 300

/** A note on the same key this many times is escalated instead of delivered again. */
export const BOUNCE_CAP = 2

/** How far a new item may sit from an old one and still be its rewording. */
const REWORD_LINES = 6

/** How much of the agent's next words a reaction keeps. */
const SAID_LIMIT = 400

export interface GateWiring {
  /** The workspace a checkout belongs to: a worktree's is its main checkout. */
  readonly workspaceOf: (cwd: string) => Promise<string>
  /** Whether the workspace declares any rules; one that does not starts no host at all. */
  readonly hasRules?: (workspacePath: string) => boolean
  readonly host: (workspacePath: string) => RuleHost
  readonly ledger: (workspacePath: string) => RulesLedger
  readonly judge: (workspacePath: string) => Promise<JudgeConfig>
  /** The rules as last loaded, for a host that failed without saying which rule held it. */
  readonly catalog: (workspacePath: string) => readonly CatalogRule[]
  readonly readText: (path: string) => Promise<string | null>
  /** Lines were written for this workspace. */
  readonly appended: (workspacePath: string) => void
  readonly now?: () => number
  readonly newId?: () => string
  readonly inlineMs?: number
  /** A failure nobody is waiting on still deserves a line in the run log. */
  readonly onFailure?: (cause: unknown) => void
}

interface OpenItem {
  readonly firingId: string
  readonly rule: string
  readonly key: string
  readonly path: string
  readonly line: number
  readonly trigger: RuleTrigger
  readonly agentKey: string
}

interface WorkspaceState {
  readonly open: Map<string, OpenItem>
  /** Notes delivered per rule and key, for the bounce cap. */
  readonly noted: Map<string, number>
}

interface Draft {
  readonly firing: Omit<Firing, 'delivery' | 'tookMs' | 'read'>
  readonly source: string
}

interface Settled {
  readonly workspacePath: string
  readonly drafts: readonly Draft[]
  readonly admitted: readonly NewLine[]
}

/** What came of delivering a batch of drafts. */
interface Finished {
  readonly firings: readonly Firing[]
  readonly notes: readonly RuleNote[]
  readonly inline: readonly string[]
  readonly blocks: readonly string[]
  readonly holds: readonly string[]
}

interface PendingReaction {
  readonly firingId: string
  readonly workspacePath: string
  readonly path: string
  readonly at: number
  said?: string
}

function agentKeyOf(agent: RuleAgent): string {
  return agent.kind === 'session' ? `session:${agent.sessionId}` : `node:${agent.runId}:${agent.nodeId}`
}

function agentRefOf(agent: RuleAgent): RuleAgentRef {
  return agent.kind === 'session'
    ? { kind: 'session', sessionId: agent.sessionId }
    : { kind: 'node', runId: agent.runId, nodeId: agent.nodeId, workflow: agent.workflow }
}

function agentKeyOfRef(ref: RuleAgentRef): string {
  return ref.kind === 'session' ? `session:${ref.sessionId}` : `node:${ref.runId}:${ref.nodeId}`
}

/** The value, or undefined once `ms` has passed without it. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

export function createRuleGate(wiring: GateWiring): RuleGate {
  const now = wiring.now ?? (() => Date.now())
  const newId = wiring.newId ?? (() => randomUUID())
  const inlineMs = wiring.inlineMs ?? INLINE_MS
  const onFailure = wiring.onFailure ?? (() => {})
  const states = new Map<string, Promise<WorkspaceState>>()

  // Read back once per workspace per launch, so the bounce cap and the open
  // items survive a restart.
  function stateOf(workspacePath: string): Promise<WorkspaceState> {
    let found = states.get(workspacePath)
    if (found === undefined) {
      found = wiring
        .ledger(workspacePath)
        .read()
        .then((lines) => rehydrate(lines))
        .catch(() => ({ open: new Map(), noted: new Map() }))
      states.set(workspacePath, found)
    }
    return found
  }

  function rehydrate(lines: readonly LedgerLine[]): WorkspaceState {
    const open = new Map<string, OpenItem>()
    const noted = new Map<string, number>()
    for (const line of lines) {
      if (line.type === 'firing') {
        if (line.item !== undefined && line.action === 'note' && line.delivery !== 'none') {
          const key = `${line.rule}\0${line.item.key}`
          noted.set(key, (noted.get(key) ?? 0) + 1)
        }
        if (line.item !== undefined && tracksOutcome(line)) {
          open.set(line.id, {
            firingId: line.id,
            rule: line.rule,
            key: line.item.key,
            path: line.item.path,
            line: line.item.line,
            trigger: line.trigger,
            agentKey: agentKeyOfRef(line.agent)
          })
        }
      } else if (line.type === 'outcome') {
        open.delete(line.firing)
      }
    }
    return { open, noted }
  }

  async function write(workspacePath: string, lines: readonly NewLine[]): Promise<void> {
    if (lines.length === 0) return
    await wiring.ledger(workspacePath).append(lines)
    wiring.appended(workspacePath)
  }

  /** What the rules decided about one event, not yet delivered. */
  async function decide(agent: RuleAgent, event: WireEvent, callId?: string): Promise<Settled> {
    const workspacePath = await wiring.workspaceOf(agent.cwd)
    if (wiring.hasRules?.(workspacePath) === false) return { workspacePath, drafts: [], admitted: [] }
    const host = wiring.host(workspacePath)
    const at = new Date(now()).toISOString()
    const trigger = event.trigger
    const where =
      event.trigger === 'edit' ? event.path : event.trigger === 'bash' ? event.command : event.trigger === 'commit' ? event.sha.slice(0, 9) : `since ${event.base.slice(0, 9)}`
    const ref = agentRefOf(agent)
    const change =
      event.trigger === 'edit'
        ? (() => {
            const hunk = hunkOf(event.before, event.after)
            return { added: hunk.added.length, removed: hunk.removed.length }
          })()
        : undefined
    let runs: readonly RuleRun[]
    try {
      await host.configure(await wiring.judge(workspacePath))
      runs = await host.evaluate({ agent: agent.kind, cwd: agent.cwd, event })
    } catch (cause) {
      // The host itself failed, and nothing says which rule held it: every
      // rule that would have seen this event is skipped and says why.
      onFailure(cause)
      const message = `the rule host failed · ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`
      const drafts = wiring
        .catalog(workspacePath)
        .filter((rule) => rule.on === trigger && rule.running !== 'off')
        .map(
          (rule): Draft => ({
            source: rule.source,
            firing: {
              id: newId(),
              at,
              rule: rule.name,
              mode: rule.running === 'shadow' ? 'shadow' : 'enforce',
              trigger,
              agent: ref,
              ...(callId === undefined ? {} : { toolCallId: callId }),
              where,
              action: 'log',
              skip: { kind: 'threw', message }
            }
          })
        )
      return { workspacePath, drafts, admitted: [] }
    }
    // A run that failed extracted nothing, and is a skip row rather than "nothing to judge".
    const admitted: NewLine[] = runs.filter((run) => run.skip === undefined).map((run) => ({
      type: 'admitted',
      at,
      rule: run.rule,
      agent: ref,
      trigger,
      items: run.items
    }))
    const drafts: Draft[] = []
    for (const run of runs) {
      const base = {
        at,
        rule: run.rule,
        mode: run.mode,
        trigger,
        agent: ref,
        ...(callId === undefined ? {} : { toolCallId: callId }),
        ...(change === undefined ? {} : { change: { tool: event.trigger, ...change } })
      }
      if (run.skip !== undefined) {
        drafts.push({ source: run.source, firing: { ...base, id: newId(), where, action: 'log', skip: run.skip } })
        continue
      }
      for (const result of run.results) {
        drafts.push({
          source: run.source,
          firing: {
            ...base,
            id: newId(),
            where: result.item.path === '' ? where : result.item.path,
            item: result.item,
            action: result.action,
            ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
            ...(result.judged === undefined ? {} : { judged: result.judged }),
            ...(result.skip === undefined ? {} : { skip: result.skip })
          }
        })
      }
    }
    return { workspacePath, drafts, admitted }
  }

  /**
   * Delivers a batch by the road each action allows and records it. `path`
   * is how a note travels this time: in the tool result, or at the next
   * boundary because the tool result has already gone back.
   */
  async function finish(
    agent: RuleAgent,
    settled: Settled,
    startedAt: number,
    notePath: 'inline' | 'steered',
    reactions: PendingReaction[]
  ): Promise<Finished> {
    const state = await stateOf(settled.workspacePath)
    const tookMs = now() - startedAt
    const firings: Firing[] = []
    const notes: RuleNote[] = []
    const inline: string[] = []
    const blocks: string[] = []
    const holds: string[] = []
    for (const { firing: draft, source } of settled.drafts) {
      let action = draft.action
      let bounced = false
      const noteKey = draft.item === undefined ? undefined : `${draft.rule}\0${draft.item.key}`
      if (action === 'note' && draft.mode === 'enforce' && noteKey !== undefined && (state.noted.get(noteKey) ?? 0) >= BOUNCE_CAP) {
        action = 'escalate'
        bounced = true
      }
      const enforce = draft.mode === 'enforce' && draft.skip === undefined
      let delivery: Delivery = 'none'
      if (enforce && action === 'note') delivery = notePath
      if (enforce && action === 'block') delivery = 'blocked'
      if (enforce && action === 'hold') delivery = 'held'
      const read =
        delivery === 'none' || draft.feedback === undefined ? undefined : ruleMessage(draft.rule, source, draft.feedback)
      const firing: Firing = {
        ...draft,
        action,
        ...(bounced ? { bounced: true } : {}),
        delivery,
        tookMs,
        ...(read === undefined ? {} : { read })
      }
      firings.push(firing)
      if (delivery === 'inline' && read !== undefined) inline.push(read)
      if (delivery === 'blocked' && read !== undefined) blocks.push(read)
      if (delivery === 'held' && read !== undefined) holds.push(read)
      if (delivery === 'steered' && read !== undefined) {
        notes.push({ firingId: firing.id, rule: firing.rule, text: read })
      }
      if (delivery !== 'none' && action === 'note' && noteKey !== undefined) {
        state.noted.set(noteKey, (state.noted.get(noteKey) ?? 0) + 1)
      }
      if (firing.item !== undefined && tracksOutcome(firing)) {
        state.open.set(firing.id, {
          firingId: firing.id,
          rule: firing.rule,
          key: firing.item.key,
          path: firing.item.path,
          line: firing.item.line,
          trigger: firing.trigger,
          agentKey: agentKeyOf(agent)
        })
        reactions.push({ firingId: firing.id, workspacePath: settled.workspacePath, path: firing.item.path, at: now() })
      }
    }
    await write(settled.workspacePath, [
      ...settled.admitted,
      ...firings.map((firing): NewLine => ({ type: 'firing', ...firing }))
    ])
    return { firings, notes, inline, blocks, holds }
  }

  async function resolve(
    workspacePath: string,
    item: OpenItem,
    outcome: Outcome,
    how: string,
    by?: string
  ): Promise<void> {
    const state = await stateOf(workspacePath)
    if (!state.open.delete(item.firingId)) return
    await write(workspacePath, [
      { type: 'outcome', at: new Date(now()).toISOString(), firing: item.firingId, outcome, how, ...(by === undefined ? {} : { by }) }
    ])
  }

  function reactionLine(pending: PendingReaction, then?: { tool: string; path: string; diff: string }): NewLine {
    return {
      type: 'reaction',
      at: new Date(now()).toISOString(),
      firing: pending.firingId,
      afterMs: now() - pending.at,
      ...(pending.said === undefined ? {} : { said: pending.said }),
      ...(then === undefined ? {} : { then })
    }
  }

  return {
    watch(agent: RuleAgent, delivery: RuleDelivery): RuleWatch {
      const agentKey = agentKeyOf(agent)
      const reactions: PendingReaction[] = []
      const heads = new Map<string, string | undefined>()
      let base: string | undefined
      // Everything this agent did so far, settled and followed. A judge that
      // answers after the agent's next edit must still be followed by it, so
      // each follow waits here; a tool result never does.
      let tail: Promise<void> = Promise.resolve()

      function afterEarlier(work: () => Promise<void>): Promise<void> {
        const run = tail.then(work)
        tail = run.catch(() => {})
        return run
      }

      async function head(): Promise<string | undefined> {
        try {
          const workspacePath = await wiring.workspaceOf(agent.cwd)
          if (wiring.hasRules?.(workspacePath) === false) return undefined
          return await wiring.host(workspacePath).head(agent.cwd)
        } catch {
          return undefined
        }
      }

      /** Items this agent left open on a path before the event now being handled. */
      async function openOn(path: string | undefined): Promise<{ workspacePath: string; items: OpenItem[] }> {
        const workspacePath = await wiring.workspaceOf(agent.cwd)
        const state = await stateOf(workspacePath)
        const items = [...state.open.values()].filter(
          (item) => item.agentKey === agentKey && (path === undefined || item.path === path)
        )
        return { workspacePath, items }
      }

      /** An edit landed: items left open on that file before it are fixed, reworded, or still there. */
      async function followEdit(path: string, after: string, fresh: readonly Firing[]): Promise<void> {
        const mine = new Set(fresh.map((firing) => firing.id))
        const { workspacePath, items } = await openOn(path)
        const prior = items.filter((item) => !mine.has(item.firingId))
        const host = wiring.host(workspacePath)
        const keysBy = new Map<string, readonly string[] | undefined>()
        for (const item of prior) {
          if (item.trigger !== 'edit') continue
          if (!keysBy.has(item.rule)) keysBy.set(item.rule, await host.present({ rule: item.rule, path, text: after }))
          const keys = keysBy.get(item.rule)
          if (keys === undefined || keys.includes(item.key)) continue
          const reword = fresh.find(
            (firing) =>
              firing.rule === item.rule &&
              firing.item !== undefined &&
              firing.item.key !== item.key &&
              Math.abs(firing.item.line - item.line) <= REWORD_LINES
          )
          await resolve(workspacePath, item, reword === undefined ? 'fixed' : 'reworded', 'at the next edit of this file', reword?.id)
        }
      }

      async function followReactions(
        call: { tool: string; path: string; before: string | null; after: string },
        fresh: readonly Firing[]
      ): Promise<void> {
        for (const pending of [...reactions]) {
          if (pending.path !== call.path || fresh.some((firing) => firing.id === pending.firingId)) continue
          reactions.splice(reactions.indexOf(pending), 1)
          await write(pending.workspacePath, [
            reactionLine(pending, { tool: call.tool, path: call.path, diff: lineDiff(call.before, call.after) })
          ])
        }
      }

      /**
       * An edit, or a commit after a bash call: inline when it decides in time,
       * steered when it does not. `followUp` runs once this event and every
       * earlier one have settled.
       */
      async function deliverAfter(
        event: WireEvent,
        callId: string,
        followUp: (finished: Finished) => Promise<void>
      ): Promise<Appended> {
        const startedAt = now()
        const work = decide(agent, event, callId)
        let settledHere: (finished: Finished | undefined) => void = () => {}
        const here = new Promise<Finished | undefined>((resolve) => (settledHere = resolve))
        void afterEarlier(async () => {
          const finished = await here
          if (finished !== undefined) await followUp(finished)
        }).catch(onFailure)
        try {
          const early = await within(work, inlineMs)
          if (early !== undefined) {
            const finished = await finish(agent, early, startedAt, 'inline', reactions)
            settledHere(finished)
            return finished.inline.length === 0
              ? {}
              : { appendix: `${APPENDIX_GAP}${finished.inline.join(APPENDIX_GAP)}` }
          }
        } catch (cause) {
          settledHere(undefined)
          throw cause
        }
        void work
          .then(async (settled) => {
            const finished = await finish(agent, settled, startedAt, 'steered', reactions)
            for (const note of finished.notes) delivery.steer(note)
            settledHere(finished)
          })
          .catch((cause: unknown) => {
            settledHere(undefined)
            onFailure(cause)
          })
        return {}
      }

      return {
        async turnStarted() {
          base = await head()
        },

        async beforeBash(call) {
          try {
            heads.set(call.callId, await head())
            const startedAt = now()
            const settled = await decide(agent, { trigger: 'bash', command: call.command }, call.callId)
            const finished = await finish(agent, settled, startedAt, 'steered', reactions)
            for (const note of finished.notes) delivery.steer(note)
            return finished.blocks.length === 0 ? {} : { block: finished.blocks.join(APPENDIX_GAP) }
          } catch (cause) {
            onFailure(cause)
            return {}
          }
        },

        async afterBash(call) {
          try {
            const before = heads.get(call.callId)
            heads.delete(call.callId)
            if (before === undefined) return {}
            const after = await head()
            if (after === undefined || after === before) return {}
            return await deliverAfter({ trigger: 'commit', sha: after }, call.callId, async () => {})
          } catch (cause) {
            onFailure(cause)
            return {}
          }
        },

        async afterEdit(call) {
          try {
            return await deliverAfter(
              { trigger: 'edit', path: call.path, before: call.before, after: call.after },
              call.callId,
              async (finished) => {
                await followReactions(call, finished.firings)
                await followEdit(call.path, call.after, finished.firings)
              }
            )
          } catch (cause) {
            onFailure(cause)
            return {}
          }
        },

        said(text) {
          const words = text.trim()
          if (words === '') return
          void afterEarlier(async () => {
            for (const pending of reactions) pending.said ??= words.slice(0, SAID_LIMIT)
          })
        },

        async checkpoint(at) {
          try {
            await afterEarlier(async () => {})
            const { workspacePath, items: prior } = await openOn(undefined)
            const from = base ?? (await head())
            let finished: Finished | undefined
            if (from !== undefined) {
              const startedAt = now()
              const settled = await decide(agent, { trigger: 'checkpoint', at, base: from })
              finished = await finish(agent, settled, startedAt, 'steered', reactions)
              for (const note of finished.notes) delivery.steer(note)
            }
            const held = (finished?.holds.length ?? 0) > 0
            const ended = at === 'turn-end' ? 'when the turn ended' : 'when the node completed'
            const host = wiring.host(workspacePath)
            for (const item of prior) {
              if (item.trigger === 'checkpoint') {
                const still = finished?.firings.some((firing) => firing.rule === item.rule && firing.item?.key === item.key)
                if (!still) await resolve(workspacePath, item, 'fixed', 'gone at the next checkpoint')
                continue
              }
              if (item.trigger !== 'edit') {
                if (!held) await resolve(workspacePath, item, 'ignored', `still open ${ended}`)
                continue
              }
              const text = await wiring.readText(isAbsolute(item.path) ? item.path : join(agent.cwd, item.path))
              if (text === null) {
                await resolve(workspacePath, item, 'fixed', `the file was gone ${ended}`)
                continue
              }
              const keys = await host.present({ rule: item.rule, path: item.path, text })
              if (keys === undefined) continue
              if (!keys.includes(item.key)) await resolve(workspacePath, item, 'fixed', `gone ${ended}`)
              else if (!held) await resolve(workspacePath, item, 'ignored', `still there ${ended}`)
            }
            if (!held) {
              for (const pending of reactions.splice(0)) {
                if (pending.said !== undefined) await write(pending.workspacePath, [reactionLine(pending)])
              }
            }
            return held ? { hold: finished!.holds.join(APPENDIX_GAP) } : {}
          } catch (cause) {
            onFailure(cause)
            return {}
          }
        }
      }
    }
  }
}
