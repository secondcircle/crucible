// @vitest-environment node
//
// The opening prompt Investigate sends. It is built from the record alone, so
// what it can say is exactly what the record holds — and a fact the record
// lacks is left out whole rather than printed blank.
import { describe, expect, it } from 'vitest'
import { RUN_MESSAGE_PREFIX, type RunRecord } from '../../../shared/workflows/run'
import { investigationPrompt } from './prompt'

function runOf(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'b1n7',
    workflow: 'build',
    status: 'failed',
    workspacePath: '/repos/resume-site',
    workspaceName: 'resume-site',
    sessionId: 's1',
    worktreePath: '/repos/resume-site/.crucible/worktrees/run-b1n7',
    branch: 'crucible/run-b1n7',
    baseCommit: '6c90bb0abcdef',
    inputs: {},
    nodes: [],
    createdAt: '2026-08-21T09:00:00.000Z',
    startedAt: '2026-08-21T09:00:00.000Z',
    endedAt: '2026-08-21T10:00:00.000Z',
    dir: '/state/workflow-runs/b1n7',
    ...overrides
  }
}

const failingNode = {
  id: 'builder',
  status: 'failed' as const,
  parents: ['planner'],
  reads: [],
  artifacts: [],
  cost: 1.3,
  error: 'required output "changes" is missing or empty'
}

describe('the investigation prompt', () => {
  it('carries the run, where it worked, what it spent and what broke', () => {
    const text = investigationPrompt(
      runOf({
        nodes: [
          { id: 'planner', status: 'complete', parents: [], reads: [], artifacts: [], cost: 0.6 },
          failingNode
        ],
        error: 'node "builder" failed validation'
      })
    )

    expect(text).toContain('run b1n7')
    expect(text).toContain('"build" workflow')
    expect(text).toContain('- status: failed')
    expect(text).toContain('- branch: crucible/run-b1n7')
    // Short form, as every other surface shows a commit.
    expect(text).toContain('- base commit: 6c90bb0')
    expect(text).not.toContain('6c90bb0abcdef')
    expect(text).toContain('- worktree: /repos/resume-site/.crucible/worktrees/run-b1n7')
    expect(text).toContain('- spend: $1.90')
    expect(text).toContain('- failing node "builder": required output "changes" is missing')
    expect(text).toContain('- run error: node "builder" failed validation')
  })

  it('names the directory the run wrote, and the three things readable there', () => {
    const text = investigationPrompt(runOf())

    expect(text).toContain('/state/workflow-runs/b1n7')
    expect(text).toContain('run.json')
    expect(text).toContain('artifacts/')
    expect(text).toContain('transcripts/<node>.json')
  })

  it('says the run reports here now, and asks for the status readout first', () => {
    const text = investigationPrompt(runOf())

    expect(text).toContain('reports to this session')
    expect(text).toContain('crucible_runs')
    expect(text).toMatch(/status readout/)
  })

  it('carries the parked question and how to answer it', () => {
    const text = investigationPrompt(
      runOf({
        status: 'running',
        endedAt: undefined,
        waiting: true,
        question: {
          reason: 'check-in: no one to ask — the run has no orchestrator session',
          raisedAt: '2026-08-21T09:40:00.000Z'
        }
      })
    )

    expect(text).toContain('waiting on an answer: check-in: no one to ask')
    expect(text).toContain('crucible_answer tool (runId "b1n7")')
    expect(text).toContain('resumes')
  })

  it('says nothing about a question on a run that is not waiting', () => {
    const text = investigationPrompt(
      runOf({
        question: {
          reason: 'a question answered long ago',
          raisedAt: '2026-08-21T09:40:00.000Z',
          answeredAt: '2026-08-21T09:45:00.000Z'
        }
      })
    )

    expect(text).not.toContain('crucible_answer')
    expect(text).not.toContain('answered long ago')
  })

  it('says the run was dismissed, where it was', () => {
    expect(investigationPrompt(runOf({ dismissedAt: '2026-08-21T11:00:00.000Z' }))).toContain(
      '- status: failed (dismissed by the user)'
    )
    expect(investigationPrompt(runOf())).toContain('- status: failed\n')
  })

  it('omits what the record does not have rather than printing a blank', () => {
    const text = investigationPrompt(
      runOf({
        branch: undefined,
        baseCommit: undefined,
        worktreePath: undefined,
        dir: undefined,
        nodes: []
      })
    )

    expect(text).not.toContain('branch')
    expect(text).not.toContain('base commit')
    expect(text).not.toContain('worktree')
    expect(text).not.toContain('spend')
    expect(text).not.toContain('run.json')
    expect(text).not.toContain('undefined')
    // What is left still identifies the run and still asks the question.
    expect(text).toContain('run b1n7')
    expect(text).toContain('status readout')
  })

  it('is ordinary user text, never a run talking to its orchestrator', () => {
    expect(investigationPrompt(runOf()).startsWith(RUN_MESSAGE_PREFIX)).toBe(false)
    expect(investigationPrompt(runOf())).not.toContain(RUN_MESSAGE_PREFIX)
  })
})
