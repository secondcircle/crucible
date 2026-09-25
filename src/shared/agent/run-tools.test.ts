import { describe, expect, it } from 'vitest'
import { runTool } from './run-tools'

// The tool description is the orchestrator's teaching, riding every request:
// an agent that has read only it must be able to start a run in a repository
// cloned inside the workspace.
describe('crucible_run', () => {
  const tool = runTool('crucible_run')

  it('takes an optional target, named relative to the workspace folder', () => {
    const target = tool.parameters.find((parameter) => parameter.name === 'target')
    expect(target?.optional).toBe(true)
    expect(target?.kind).toBeUndefined()
    expect(target?.description).toMatch(/relative\s+to that folder/)
    expect(target?.description).toMatch(/Omit for the workspace's own repository/)
  })

  it('says what a target changes, what a workflow can settle, and what is refused', () => {
    const text = tool.description
    expect(text).toMatch(/exactly one target repository/)
    expect(text).toMatch(/pass `target` with its path relative to that folder/)
    expect(text).toMatch(/branches from that repository's HEAD, or from `base` resolved there/)
    expect(text).toMatch(/fix its target/)
    expect(text).toMatch(/require one/)
    expect(text).toMatch(/refused\s+before anything is spent/)
  })

  it('resolves base in the target', () => {
    const base = tool.parameters.find((parameter) => parameter.name === 'base')
    expect(base?.description).toMatch(/resolved in the run's target repository/)
  })
})

describe('crucible_workflows', () => {
  it('says the catalog shows a fixed or required target', () => {
    expect(runTool('crucible_workflows').description).toMatch(
      /target repository a workflow fixes or requires/
    )
  })
})
