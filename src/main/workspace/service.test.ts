// @vitest-environment node
//
// The one module that genuinely reads folders and starts processes, driven
// against temp directories: no Electron, no renderer, no agent.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceEvent } from '../../shared/workspace/service'
import { createWorkspaceService, type RealWorkspaceService } from './service'

let folder: string
let service: RealWorkspaceService
let events: WorkspaceEvent[]
/** Every link the service asked the OS to open, which is all it may do with one. */
let opened: string[]

function write(path: string, content = 'x'): void {
  const full = join(folder, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function gitInit(): void {
  execFileSync('git', ['init', '-q'], { cwd: folder })
}

/** Runs git in the temp repository, with an identity of its own. */
function git(...args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd: folder,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Temp',
      GIT_AUTHOR_EMAIL: 'temp@example.com',
      GIT_COMMITTER_NAME: 'Temp',
      GIT_COMMITTER_EMAIL: 'temp@example.com'
    }
  })
}

function commit(path: string, message: string): void {
  write(path, message)
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

/** Everything that happened to a run, once it is over. */
function outcome(runId: string): { output: string; ended: boolean; exitCode?: number } {
  const mine = events.filter((event) => event.runId === runId)
  const ended = mine.find((event) => event.type === 'run_ended')
  return {
    output: mine
      .filter((event) => event.type === 'run_output')
      .map((event) => (event.type === 'run_output' ? event.chunk : ''))
      .join(''),
    ended: ended !== undefined,
    ...(ended?.type === 'run_ended' && ended.exitCode !== undefined
      ? { exitCode: ended.exitCode }
      : {})
  }
}

async function until(done: () => boolean, within = 5000): Promise<void> {
  const deadline = Date.now() + within
  while (!done()) {
    if (Date.now() > deadline) throw new Error('the run never got there')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'crucible-workspace-'))
  opened = []
  service = createWorkspaceService({ openExternal: (url) => opened.push(url) })
  events = []
  service.onEvent((event) => events.push(event))
})

afterEach(() => {
  service.dispose()
  rmSync(folder, { recursive: true, force: true })
})

describe('file search in a git workspace', () => {
  beforeEach(() => {
    gitInit()
    write('src/main.ts')
    write('src/notes.md')
    write('.gitignore', 'node_modules/\n*.log\n')
    write('node_modules/react/index.js')
    write('debug.log')
  })

  it('lists what git would, ignored files and .git excluded', async () => {
    const found = await service.searchFiles(folder, '')

    expect(found).toEqual(['.gitignore', 'src/main.ts', 'src/notes.md'])
  })

  it('matches a scattered subsequence, case-insensitively', async () => {
    expect(await service.searchFiles(folder, 'smn')).toEqual(['src/main.ts'])
    expect(await service.searchFiles(folder, 'NOTES')).toEqual(['src/notes.md'])
    expect(await service.searchFiles(folder, 'zzz')).toEqual([])
  })
})

describe('file search outside git', () => {
  beforeEach(() => {
    write('src/main.ts')
    write('src/deep/nested/file.ts')
    write('.gitignore', 'build/\n*.log\n!keep.log\n')
    write('build/out.js')
    write('debug.log')
    write('keep.log')
    mkdirSync(join(folder, '.git'), { recursive: true })
    write('.git/config')
  })

  it('honors .gitignore, its negations, and always skips .git', async () => {
    const found = await service.searchFiles(folder, '')

    expect(found).toEqual([
      '.gitignore',
      'keep.log',
      'src/deep/nested/file.ts',
      'src/main.ts'
    ])
  })

  it('ranks a filename match above a match anywhere in the path', async () => {
    write('deep.ts')

    // `deep.ts` is a filename match; the nested file only matches its folder.
    expect(await service.searchFiles(folder, 'deep')).toEqual([
      'deep.ts',
      'src/deep/nested/file.ts'
    ])
  })
})

describe('the branch board of a real repository', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'temp@example.com')
    commit('README.md', 'the first commit')
    // Branched and left alone: its commits are already in main's history.
    git('branch', 'already-in-main')
    git('checkout', '-q', '-b', 'unpushed-work')
    commit('src/thing.ts', 'work nobody else has')
  })

  it('reads a git-only board, with no host and no invented pull requests', async () => {
    const answer = await service.branchBoard(folder)
    if (answer.kind !== 'board') throw new Error('expected a board')

    expect(answer.board.trunk).toBe('main')
    expect(answer.board.host).toBeUndefined()
    expect(answer.board.repoLabel).toBe(folder)
    expect(answer.board.rows.some((row) => row.pr !== undefined)).toBe(false)
    // The trunk itself is what everything is measured against, never a row.
    expect(answer.board.rows.map((row) => row.name).sort()).toEqual([
      'already-in-main',
      'unpushed-work'
    ])
  })

  it('lands what is in the trunk and files the rest by where it lives', async () => {
    const answer = await service.branchBoard(folder)
    if (answer.kind !== 'board') throw new Error('expected a board')
    const row = (name: string) => answer.board.rows.find((candidate) => candidate.name === name)

    expect(row('already-in-main')).toMatchObject({
      group: 'landed',
      drift: { kind: 'counts', ahead: 0, behind: 0 },
      signal: { kind: 'inTrunkHistory' },
      yours: true
    })
    expect(row('unpushed-work')).toMatchObject({
      group: 'localOnly',
      local: true,
      onOrigin: false,
      checkedOut: true,
      subject: 'work nobody else has',
      drift: { kind: 'counts', ahead: 1, behind: 0 }
    })
  })

  it('leaves the working tree exactly as it found it', async () => {
    write('src/uncommitted.ts')
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: folder }).toString()

    await service.branchBoard(folder)

    expect(execFileSync('git', ['status', '--porcelain'], { cwd: folder }).toString()).toBe(before)
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: folder }).toString()).toBe(
      'unpushed-work\n'
    )
  })
})

describe('a folder with no repository in it', () => {
  it('answers noRepository, which is an answer rather than a failure', async () => {
    write('notes.md')

    await expect(service.branchBoard(folder)).resolves.toEqual({ kind: 'noRepository' })
  })
})

describe('opening a link', () => {
  it('hands an https link to the OS browser', async () => {
    await service.openUrl('https://github.com/secondcircle/crucible/pull/4')

    expect(opened).toEqual(['https://github.com/secondcircle/crucible/pull/4'])
  })

  it('refuses anything that is not https, and opens nothing', async () => {
    for (const url of ['file:///etc/passwd', 'http://example.com', 'not a url', 'javascript:1']) {
      await expect(service.openUrl(url)).rejects.toThrow('Crucible opens https links only.')
    }
    expect(opened).toEqual([])
  })
})

describe('a run', () => {
  it('executes at the workspace root and reports how it ended', async () => {
    write('marker.txt')
    const runId = await service.startRun(folder, 'ls marker.txt')

    await until(() => outcome(runId).ended)

    expect(outcome(runId)).toEqual({ output: 'marker.txt\n', ended: true, exitCode: 0 })
  })

  it('interleaves stdout and stderr in arrival order', async () => {
    const runId = await service.startRun(folder, 'echo out; echo err 1>&2')

    await until(() => outcome(runId).ended)

    expect(outcome(runId).output.split('\n').filter(Boolean).sort()).toEqual(['err', 'out'])
  })

  it('reports a non-zero exit as its own', async () => {
    const runId = await service.startRun(folder, 'exit 3')

    await until(() => outcome(runId).ended)

    expect(outcome(runId).exitCode).toBe(3)
  })

  it('dies on stopRun, with no exit status to report', async () => {
    const runId = await service.startRun(folder, 'echo started; sleep 30')
    await until(() => outcome(runId).output.includes('started'))

    await service.stopRun(runId)
    await until(() => outcome(runId).ended)

    expect(outcome(runId).exitCode).toBeUndefined()
  })

  it('is harmless to stop twice, or after it ended', async () => {
    const runId = await service.startRun(folder, 'true')
    await until(() => outcome(runId).ended)

    await expect(service.stopRun(runId)).resolves.toBeUndefined()
    await expect(service.stopRun('run-does-not-exist')).resolves.toBeUndefined()
  })
})
