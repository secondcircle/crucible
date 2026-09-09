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

  it('answers every issue-board state a check might want, by a word in the path', async () => {
    const { service } = watched()
    const github = await service.issueBoard('/repos/crucible')
    const jira = await service.issueBoard('/repos/jira-ek-app')
    const unset = await service.issueBoard('/repos/nojira-ek-app')
    const none = await service.issueBoard('/repos/nohost-resume-site')

    if (github.kind !== 'board' || jira.kind !== 'board') throw new Error('expected boards')
    expect(github.board.host).toEqual({ kind: 'github' })
    expect(github.board.rows[0]?.reference).toMatch(/^crucible#/)

    // A Jira project: keys for references, the project key as the label, the
    // display name as who you are, and no mentions group anywhere.
    expect(jira.board.host).toEqual({ kind: 'jira' })
    expect(jira.board.repoLabel).toBe('EK')
    expect(jira.board.login).toBe('Ike Melancon')
    expect(jira.board.rows.map((row) => row.reference)).toEqual([
      'EK-341',
      'EK-338',
      'EK-352',
      'EK-349',
      'EK-344'
    ])
    expect(jira.board.rows.some((row) => row.group === 'mentionsYou')).toBe(false)
    expect(jira.board.rows.some((row) => row.pr !== undefined)).toBe(false)
    // Two teammates share a display name and are still two people.
    expect(jira.board.rows.filter((row) => row.group === 'assignedToOthers')).toHaveLength(2)
    // No account id crosses, and no label carries a colour Jira does not have.
    expect(JSON.stringify(jira.board)).not.toContain('557058')
    expect(jira.board.rows.every((row) => row.labels.every((label) => label.color === undefined))).toBe(true)

    expect(unset.kind).toBe('notConfigured')
    expect(unset.kind === 'notConfigured' && unset.missing.map((piece) => piece.name)).toEqual([
      'JIRA_API_TOKEN',
      '.crucible/jira.json'
    ])
    expect(none).toEqual({ kind: 'noIssueHost' })
  })

  it('mints the collection time at call time, so the age reads fresh', async () => {
    const { service } = watched()
    const answer = await service.issueBoard('/repos/pi-extensions')
    if (answer.kind !== 'board') throw new Error('expected a board')

    expect(Date.now() - Date.parse(answer.board.collectedAt)).toBeLessThan(2000)
  })

  it('records a link and opens nothing at all', async () => {
    const { service } = watched()

    await service.openUrl('https://github.com/secondcircle/pi-extensions/pull/45')

    expect(service.openedUrls).toEqual([
      'https://github.com/secondcircle/pi-extensions/pull/45'
    ])
  })

  it('answers the research CLI as an installed, connected one with credits', async () => {
    const { service } = watched()

    expect(await service.researchStatus()).toEqual({
      kind: 'signedIn',
      version: '1.23.3',
      credits: 4820
    })
  })

  it('walks the flow the real one walks: logged out, then connected again', async () => {
    const { service, events } = watched()

    expect(await service.researchDisconnect()).toEqual({
      kind: 'settled',
      status: { kind: 'signedOut', version: '1.23.3' }
    })
    expect(await service.researchStatus()).toEqual({
      kind: 'signedOut',
      version: '1.23.3'
    })

    // Nobody can be the person the browser flow waits on, so it holds and the
    // pasted key is the one that finishes, as it is for the real CLI.
    const waiting = service.researchConnect()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(events.some((event) => event.type === 'research_output')).toBe(true)

    await service.researchCancelConnect()
    expect(await waiting).toEqual({ kind: 'abandoned' })

    expect(await service.researchConnect('fc-anything-at-all')).toEqual({
      kind: 'settled',
      status: { kind: 'signedIn', version: '1.23.3', credits: 4820 }
    })
  })

  it('starts no process and stores no key for any of it', async () => {
    const { service } = watched()

    // Nothing to assert but the absence: the fake imports neither Node nor
    // Electron, so there is nothing here that could spawn or write.
    await service.researchConnect('fc-a-key-the-fake-forgets')
    expect(JSON.stringify(await service.researchStatus())).not.toContain('fc-')
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
