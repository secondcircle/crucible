// @vitest-environment node
//
// Pure, so the home directory is injected and no test touches the machine's
// real one.
import { describe, expect, it } from 'vitest'
import { crucibleAgentDir, workspaceSessionDir } from './paths'

const HOME = '/Users/someone'
const AGENT = crucibleAgentDir(HOME)

describe('Crucible\u2019s agent directory', () => {
  it('is .crucible/agent under the home it is given', () => {
    expect(AGENT).toBe('/Users/someone/.crucible/agent')
  })
})

describe('a workspace\u2019s session directory', () => {
  it('sits under the agent directory\u2019s sessions folder', () => {
    expect(workspaceSessionDir(AGENT, '/repos/crucible')).toBe(
      '/Users/someone/.crucible/agent/sessions/--repos-crucible--'
    )
  })

  it('is the same folder every time it is asked for', () => {
    expect(workspaceSessionDir(AGENT, '/repos/crucible')).toBe(
      workspaceSessionDir(AGENT, '/repos/crucible')
    )
  })

  it('is a different folder for a different workspace', () => {
    expect(workspaceSessionDir(AGENT, '/repos/crucible')).not.toBe(
      workspaceSessionDir(AGENT, '/repos/crucible-notes')
    )
  })

  it('names no folder of \u03c0\u2019s', () => {
    for (const workspace of ['/repos/crucible', '/Users/someone/work/notes']) {
      expect(workspaceSessionDir(AGENT, workspace)).not.toContain('.pi')
    }
  })
})
