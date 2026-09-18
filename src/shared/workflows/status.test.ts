import { describe, expect, it } from 'vitest'
import { interruptionNotice, resumeAnswer } from './status'
import type { RunNode, RunNodeStatus, RunRecord } from './run'

// What an orchestrator is told a resume will do. The rule under every case
// here: the sentence describes the act the engine performs on the record as it
// stands, so a session reading it never budgets for a re-spend that will not
// happen — and never expects a continuation the engine cannot make.

function node(id: string, status: RunNodeStatus, extra: Partial<RunNode> = {}): RunNode {
  return { id, status, parents: [], reads: [], artifacts: [], ...extra }
}

function runOf(nodes: readonly RunNode[]): RunRecord {
  return {
    id: '45c8',
    workflow: 'build',
    status: 'interrupted',
    workspacePath: '/repos/thing',
    workspaceName: 'thing',
    worktreePath: '/repos/thing/.crucible/worktrees/run-45c8',
    inputs: {},
    nodes,
    createdAt: '2026-08-20T10:00:00.000Z'
  }
}

const TOKEN = '/state/workflow-runs/45c8/sessions/1.jsonl'

describe('the interruption notice', () => {
  it('says a node whose session is on disk continues from its last turn', () => {
    const notice = interruptionNotice(runOf([node('gate', 'interrupted', { sessionToken: TOKEN })]))
    expect(notice).toContain('node "gate" continues from its last turn')
    expect(notice).toContain('/repos/thing/.crucible/worktrees/run-45c8')
    expect(notice).not.toContain('fresh attempt')
  })

  it('says a node with no session left runs again from its prompt', () => {
    const notice = interruptionNotice(runOf([node('gate', 'interrupted')]))
    expect(notice).toContain('no session left to continue')
    expect(notice).toContain('runs again from its prompt')
  })

  // A quit between nodes, or on a workflow-level check-in: no node record
  // stopped mid-turn, so the resume replays what completed and carries on.
  // Nothing runs again from a prompt, and the notice must not say one will.
  it('describes a replay, not a re-run, when no node record stopped', () => {
    const notice = interruptionNotice(runOf([node('spec', 'complete', { sessionToken: TOKEN })]))
    expect(notice).toContain('picks up where it stopped')
    expect(notice).toContain('handing back what it already finished')
    expect(notice).not.toContain('runs again from its prompt')
    expect(notice).not.toContain('no session left')
  })

  // The quit caught a held-open node mid-revision: the base record completed
  // with its session on disk, the revision record carries none. The engine
  // replays the completion and the re-issued revise() reopens that session, so
  // the notice names the revision as continuing there.
  it('names the revision a quit cut down as continuing in its node’s session', () => {
    const notice = interruptionNotice(
      runOf([
        node('review', 'complete', { sessionToken: TOKEN }),
        node('review·r1', 'interrupted')
      ])
    )
    expect(notice).toContain('node "review·r1" is a revision the quit cut down')
    expect(notice).toContain('continues in the session that node was working in')
    expect(notice).toContain('nothing it already spent is spent again')
    expect(notice).not.toContain('runs again from its prompt')
    expect(notice).not.toContain('no session left')
  })
})

describe('what crucible_resume answers', () => {
  it('states the act for a stopped node, and plain progress when none stopped', () => {
    const stopped = runOf([node('gate', 'interrupted', { sessionToken: TOKEN })])
    const working = { ...stopped, status: 'running' as const }
    expect(resumeAnswer(working, stopped)).toContain('node "gate" continues from its last turn')
    expect(resumeAnswer(working, stopped, 'clean-restart')).toContain(
      'runs again from its prompt'
    )
    expect(resumeAnswer(working, runOf([node('spec', 'complete')]))).toContain('is working again')
  })
})
