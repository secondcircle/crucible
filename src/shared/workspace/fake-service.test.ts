// @vitest-environment node
//
// The flavor an agent-driven check drives: every answer is canned, so what
// those checks rely on is pinned here.
import { describe, expect, it } from 'vitest'
import { CANNED_FILES, CANNED_WORKTREE_IDS, createFakeWorkspaceService } from './fake-service'
import type { WorkspaceEvent } from './service'

function watched(): {
  service: ReturnType<typeof createFakeWorkspaceService>
  events: WorkspaceEvent[]
} {
  const service = createFakeWorkspaceService({ pauseMs: 0 })
  const events: WorkspaceEvent[] = []
  service.onEvent((event) => events.push(event))
  return { service, events }
}

async function settled(events: readonly WorkspaceEvent[], within = 2000): Promise<void> {
  const deadline = Date.now() + within
  while (!events.some((event) => event.type === 'run_ended')) {
    if (Date.now() > deadline) throw new Error('the canned run never ended')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('the fake workspace service', () => {
  it('searches a canned list, ranked the way the real one ranks a folder', async () => {
    const { service } = watched()

    // Everything, alphabetically: an empty query matches the whole list.
    expect(await service.searchFiles('/anywhere', '')).toEqual(
      [...CANNED_FILES].sort((left, right) => left.localeCompare(right))
    )
    // Filenames first, then the folder that only matches in its path.
    expect(await service.searchFiles('/anywhere', 'compo')).toEqual([
      'docs/design/mock-j-composer-suite.html',
      'src/renderer/src/components/composer.css',
      'src/renderer/src/components/Composer.tsx',
      'src/renderer/src/components/SessionTree.tsx',
      'src/renderer/src/components/transcript.css',
      'src/renderer/src/components/Transcript.tsx'
    ])
  })

  it('calls every workspace a git one, so the worktree chip is there to drive', async () => {
    const { service } = watched()

    expect(await service.isGitWorkspace('/anywhere')).toBe(true)
  })

  it('makes a worktree out of nothing, on a canned branch, a different one each time', async () => {
    const { service } = watched()

    const first = await service.createWorktree('/repos/crucible')
    const second = await service.createWorktree('/repos/crucible')

    expect(first).toEqual({
      ok: true,
      path: `/repos/crucible/.crucible/worktrees/${CANNED_WORKTREE_IDS[0]}`,
      branch: `crucible/${CANNED_WORKTREE_IDS[0]}`
    })
    expect(second).toMatchObject({ ok: true, branch: `crucible/${CANNED_WORKTREE_IDS[1]}` })
  })

  it('answers most commands with a short success', async () => {
    const { service, events } = watched()

    await service.startRun('/anywhere', 'git status')
    await settled(events)

    expect(events.at(-1)).toEqual({ type: 'run_ended', runId: 'fake-run-1', exitCode: 0 })
    expect(events.filter((event) => event.type === 'run_output')).not.toHaveLength(0)
  })

  it('fails the command that says it will, with a non-zero exit', async () => {
    const { service, events } = watched()

    await service.startRun('/anywhere', 'npm run fail')
    await settled(events)

    expect(events.at(-1)).toEqual({ type: 'run_ended', runId: 'fake-run-1', exitCode: 1 })
  })

  it('streams the endless one until it is stopped, and then says nothing more', async () => {
    const { service, events } = watched()
    const runId = await service.startRun('/anywhere', 'tail -f log')

    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.stopRun(runId)

    // Stopped rather than exited, so there is no exit status to report.
    expect(events.at(-1)).toEqual({ type: 'run_ended', runId })
  })
})
