import { describe, expect, it } from 'vitest'
import {
  baseNodeId,
  CONTINUED_NODE_MESSAGE,
  currentNode,
  cutRevisions,
  isContinuedNodeMessage,
  nextRevisionId,
  nodeChain,
  nodeChains,
  resumePlan,
  runStop,
  stoppedNodes,
  type RunNode,
  type RunNodeStatus,
  type RunRecord
} from './run'

// The chain rule, read here the way every surface reads it and the way the
// engine's `runNode` acts on it: one node takes several records as it is
// revised, and the furthest of them is the only one anything will happen to.

function node(id: string, status: RunNodeStatus, extra: Partial<RunNode> = {}): RunNode {
  return { id, status, parents: [], reads: [], artifacts: [], ...extra }
}

function runOf(nodes: readonly RunNode[], status: RunRecord['status'] = 'interrupted'): RunRecord {
  return {
    id: '45c8',
    workflow: 'build',
    status,
    workspacePath: '/repos/thing',
    workspaceName: 'thing',
    inputs: {},
    nodes,
    createdAt: '2026-08-20T10:00:00.000Z'
  }
}

const TOKEN = '/state/workflow-runs/45c8/sessions/1.jsonl'
const OTHER_TOKEN = '/state/workflow-runs/45c8/sessions/2.jsonl'

describe('the records of one node', () => {
  it('is the base record and every ·rN of it, in the order the session took them', () => {
    const nodes = [
      node('gate', 'interrupted'),
      node('other', 'complete'),
      node('gate·r2', 'complete'),
      node('gate·r1', 'interrupted')
    ]
    expect(nodeChain(nodes, 'gate').map((record) => record.id)).toEqual([
      'gate',
      'gate·r1',
      'gate·r2'
    ])
    expect(nodeChain(nodes, 'other').map((record) => record.id)).toEqual(['other'])
  })

  it('counts past nine, where a string sort would not', () => {
    const nodes = [node('gate', 'complete'), node('gate·r10', 'running'), node('gate·r9', 'complete')]
    expect(nodeChain(nodes, 'gate').at(-1)?.id).toBe('gate·r10')
  })

  it('reads a node id that merely looks like a revision as its own node', () => {
    expect(baseNodeId('gate·r1')).toBe('gate')
    expect(baseNodeId('gate·review')).toBe('gate·review')
    expect(baseNodeId('gate·r')).toBe('gate·r')
    expect(baseNodeId('gate')).toBe('gate')
  })

  it('groups a run into nodes, each with the record that speaks for it', () => {
    const chains = nodeChains(
      runOf([node('spec', 'complete'), node('gate', 'interrupted'), node('gate·r1', 'running')])
    )
    expect(chains.map((chain) => chain.id)).toEqual(['spec', 'gate'])
    expect(chains[1].furthest.id).toBe('gate·r1')
    expect(chains[1].complete).toBeUndefined()
  })
})

describe('what a resume will do', () => {
  it('continues the node whose session is on disk, and names it once', () => {
    const run = runOf([node('gate', 'interrupted', { sessionToken: TOKEN })])
    expect(resumePlan(run, 'continue')).toEqual({
      continued: [run.nodes[0]],
      restarted: []
    })
  })

  // What a quit after a clean restart leaves: two interrupted records, both
  // with sessions, for one node. The engine continues the furthest and never
  // reopens the record the restart superseded, so the plan names one act.
  it('acts on the furthest record of a chain, not on the record it superseded', () => {
    const run = runOf([
      node('gate', 'interrupted', { sessionToken: TOKEN }),
      node('gate·r1', 'interrupted', { sessionToken: OTHER_TOKEN })
    ])
    expect(stoppedNodes(run).map((record) => record.id)).toEqual(['gate·r1'])
    expect(resumePlan(run, 'continue').continued.map((record) => record.id)).toEqual(['gate·r1'])
  })

  // A quit during a held-open node's revision: the base record completed, the
  // revision record carries no session of its own. The engine replays the
  // completion and the workflow's re-issued revise() continues the node
  // through the base record's session — so nothing here runs from a prompt.
  it('puts nothing back to work for a node whose chain completed', () => {
    const replayed = runOf([
      node('gate', 'complete', { sessionToken: TOKEN }),
      node('gate·r1', 'interrupted')
    ])
    expect(stoppedNodes(replayed)).toEqual([])
    expect(resumePlan(replayed, 'continue')).toEqual({ continued: [], restarted: [] })

    // The same rule the other way round: a clean restart that finished the
    // work leaves the base record interrupted for good, and it is done.
    const restarted = runOf([
      node('gate', 'interrupted', { sessionToken: TOKEN }),
      node('gate·r1', 'complete', { sessionToken: OTHER_TOKEN })
    ])
    expect(stoppedNodes(restarted)).toEqual([])
  })

  // The state the empty plan hides, named on its own so a surface can speak
  // about it: the record the quit cut down is a revision of a node that had
  // already completed once, and the session behind it is the completed
  // record's — so it is that record's token, not the revision's, that says
  // which act the resume performs.
  it('continues the revision a quit cut down in the session its completion named', () => {
    const run = runOf([
      node('spec', 'complete'),
      node('gate', 'complete', { sessionToken: TOKEN }),
      node('gate·r1', 'interrupted')
    ])
    expect(cutRevisions(run).continued.map((record) => record.id)).toEqual(['gate·r1'])
    expect(cutRevisions(run).restarted).toEqual([])
    expect(stoppedNodes(run)).toEqual([])
  })

  // A record written before sessions outlived the app: nothing in the chain
  // carries a token, so `revise()` opens a fresh session from the node's whole
  // prompt. The split says so rather than promising a continuation.
  it('restarts the cut revision of a chain whose completion named no session', () => {
    const run = runOf([node('gate', 'complete'), node('gate·r1', 'interrupted')])
    expect(cutRevisions(run).restarted.map((record) => record.id)).toEqual(['gate·r1'])
    expect(cutRevisions(run).continued).toEqual([])

    // The revision's own token is never the one reopened: the engine reads the
    // completed record's, so a token here changes nothing.
    const revisionToken = runOf([
      node('gate', 'complete'),
      node('gate·r1', 'interrupted', { sessionToken: OTHER_TOKEN })
    ])
    expect(cutRevisions(revisionToken).restarted.map((record) => record.id)).toEqual(['gate·r1'])
  })

  it('names no revision for a chain that finished, or one that never revised', () => {
    expect(
      cutRevisions(
        runOf([node('gate', 'complete', { sessionToken: TOKEN }), node('gate·r1', 'complete')])
      )
    ).toEqual({ continued: [], restarted: [] })
    expect(cutRevisions(runOf([node('gate', 'interrupted', { sessionToken: TOKEN })]))).toEqual({
      continued: [],
      restarted: []
    })
  })

  it('still names every node of a fan-out the quit cut down', () => {
    const run = runOf([
      node('left', 'interrupted', { sessionToken: TOKEN }),
      node('right', 'interrupted')
    ])
    const { continued, restarted } = resumePlan(run, 'continue')
    expect(continued.map((record) => record.id)).toEqual(['left'])
    expect(restarted.map((record) => record.id)).toEqual(['right'])
  })

  it('restarts everything it puts back to work when that is what was asked for', () => {
    const run = runOf([
      node('gate', 'interrupted', { sessionToken: TOKEN }),
      node('gate·r1', 'failed', { sessionToken: OTHER_TOKEN })
    ])
    expect(resumePlan(run, 'clean-restart')).toEqual({
      continued: [],
      restarted: [run.nodes[1]]
    })
  })
})

describe('the node a run is at', () => {
  it('is never a record a revision left behind', () => {
    const run = runOf(
      [
        node('spec', 'complete'),
        node('gate', 'interrupted', { sessionToken: TOKEN }),
        node('gate·r1', 'complete', { sessionToken: OTHER_TOKEN })
      ],
      'complete'
    )
    expect(currentNode(run)?.id).toBe('gate·r1')
  })

  it('is the working record while one is working', () => {
    const run = runOf(
      [node('gate', 'interrupted', { sessionToken: TOKEN }), node('gate·r1', 'running')],
      'running'
    )
    expect(currentNode(run)?.id).toBe('gate·r1')
  })

  it('is the cut node while the run is interrupted', () => {
    const run = runOf([node('spec', 'complete'), node('gate', 'interrupted')])
    expect(currentNode(run)?.id).toBe('gate')
  })
})

describe('how a run stopped', () => {
  it('is one word over every stop short of completing, and nothing otherwise', () => {
    const cases: ReadonlyArray<[RunRecord['status'], string | undefined]> = [
      ['interrupted', 'interrupted'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['running', undefined],
      ['paused', undefined],
      ['complete', undefined]
    ]
    for (const [status, stop] of cases) {
      expect(runStop(runOf([], status))).toBe(stop)
    }
  })
})

// The id the run view names before the click has to be the id the engine
// mints after it, so both read it from here.
describe('the id a clean restart mints', () => {
  it('is the first ·rN of that node the record does not already hold', () => {
    expect(nextRevisionId([node('gate', 'failed')], 'gate')).toBe('gate·r1')
    expect(
      nextRevisionId([node('gate', 'interrupted'), node('gate·r1', 'failed')], 'gate')
    ).toBe('gate·r2')
    // Named after the node, never after the record: a stopped revision starts
    // over as the next revision of the node it belongs to.
    expect(nextRevisionId([node('gate·r1', 'failed')], baseNodeId('gate·r1'))).toBe('gate·r2')
  })
})

describe('the message a continued node is sent', () => {
  it('is recognized by what opens it, whatever else the engine appends', () => {
    expect(isContinuedNodeMessage(CONTINUED_NODE_MESSAGE)).toBe(true)
    expect(isContinuedNodeMessage(`${CONTINUED_NODE_MESSAGE}\n\nOne monitor was lost.`)).toBe(true)
    expect(isContinuedNodeMessage('Apply the findings in review-1.md.')).toBe(false)
  })
})
