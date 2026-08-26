// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { devInstance } from './instance'

describe('the dev instance', () => {
  it('is the plain dev state in a primary clone', () => {
    expect(devInstance('/Users/x/repos/crucible')).toEqual({
      stateDir: 'Crucible-Dev',
      badge: 'dev'
    })
  })

  it('takes the worktree’s own name, so two windows can never look alike', () => {
    expect(devInstance('/Users/x/repos/crucible/.crucible/worktrees/4aa56f')).toEqual({
      stateDir: 'Crucible-Dev-4aa56f',
      badge: 'dev · 4aa56f'
    })
    // The badge is the state directory's suffix and nothing else: it is what
    // decides which runs and sessions the window can see.
    const other = devInstance('/Users/x/repos/crucible/.crucible/worktrees/run-dd2c')
    expect(other.badge).toBe('dev · run-dd2c')
    expect(other.stateDir).toBe('Crucible-Dev-run-dd2c')
  })

  it('is not fooled by a folder that merely mentions worktrees', () => {
    expect(devInstance('/Users/x/repos/worktrees/crucible').stateDir).toBe('Crucible-Dev')
  })
})
