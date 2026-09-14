// @vitest-environment node
//
// The one module that genuinely reads folders and starts processes, driven
// against temp directories: no Electron, no renderer, no agent.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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
let revealed: string[]

function write(path: string, content = 'x'): void {
  const full = join(folder, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function gitInit(): void {
  execFileSync('git', ['init', '-q'], { cwd: folder })
}

/** A HEAD to branch from, with an identity the machine need not have. */
function gitCommit(): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-qm',
      'first',
      '--allow-empty'
    ],
    { cwd: folder }
  )
}

/** The repo's own mechanism, exactly where Crucible looks for it. */
function worktreeScript(body: string, { executable = true } = {}): void {
  const path = join(folder, '.crucible', 'worktree')
  mkdirSync(join(folder, '.crucible'), { recursive: true })
  writeFileSync(path, body)
  if (executable) chmodSync(path, 0o755)
}

/** Everything that happened to a run, once it is over. */
function outcome(runId: string): { output: string; ended: boolean; exitCode?: number } {
  const mine = events.filter(
    (event) =>
      (event.type === 'run_output' || event.type === 'run_ended') && event.runId === runId
  )
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
  revealed = []
  service = createWorkspaceService({
    openExternal: (url) => opened.push(url),
    revealItem: (path) => revealed.push(path)
  })
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

describe('watching a directory', () => {
  it('announces one change for a burst of writes, and names the directory', async () => {
    write('src/a.ts')
    await service.watchFiles(folder)

    write('src/b.ts')
    write('src/c.ts')
    // A generous budget: how fast the platform's watcher wakes is its own
    // business, and a loaded machine can take seconds over it.
    await until(() => events.some((event) => event.type === 'files_changed'), 20_000)
    // The settling window is what makes a build one announcement rather than
    // hundreds; anything later would be a second burst.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(events.filter((event) => event.type === 'files_changed')).toEqual([
      { type: 'files_changed', directory: folder }
    ])
  })

  it('stops announcing once the last watcher of that directory lets go', async () => {
    // A folder with something in it, watched after it settled: on macOS a
    // recursive watch of a directory created in the same breath can miss the
    // writes that follow, and a workspace is never that young.
    write('already-here.ts')
    await service.watchFiles(folder)
    await service.watchFiles(folder)

    await service.unwatchFiles(folder)
    write('still-watched.ts')
    await until(() => events.some((event) => event.type === 'files_changed'), 20_000)

    // One write can wake the platform's watcher more than once; the trailing
    // announcements are let through before the watch is dropped, so what the
    // assertion sees is the drop and not a straggler.
    await new Promise((resolve) => setTimeout(resolve, 400))
    events.length = 0
    await service.unwatchFiles(folder)
    write('no-longer.ts')
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(events).toEqual([])
  })

  // review-2: the arming window the watch opens on macOS is the window it
  // exists to cover, and nothing re-lists after it closes.
  it('announces a file written while the watch is still arming', async () => {
    write('already-here.ts')
    const watching = service.watchFiles(folder)
    // An agent writing in the milliseconds after ⌘E: the watcher is created,
    // `live` is still false, so the event is dropped and never replaced.
    write('written-during-arming.ts')
    await watching
    await until(() => events.some((event) => event.type === 'files_changed'), 8000)

    expect(events.filter((event) => event.type === 'files_changed')).toHaveLength(1)
  })

  // review-2: "Read-only. No edit, no save, no file mutation of any kind."
  it('leaves the watched directory untouched', async () => {
    write('already-here.ts')
    const before = statSync(folder)

    await service.watchFiles(folder)

    expect(statSync(folder).ctimeMs).toBe(before.ctimeMs)
  })

  it('is unmoved by what git does to its own directory', async () => {
    gitInit()
    await service.watchFiles(folder)

    // A command that only touches .git: an index lock, a ref, a log line.
    execFileSync('git', ['config', 'user.name', 'Nobody'], { cwd: folder })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(events).toEqual([])
  })
})

describe('revealing a file', () => {
  it('hands the OS the file itself, resolved against the directory it is in', async () => {
    await service.revealFile(folder, 'src/deep/file.ts')

    expect(revealed).toEqual([join(folder, 'src/deep/file.ts')])
  })

  it('takes an absolute path as it stands', async () => {
    await service.revealFile(folder, join(folder, 'a.ts'))

    expect(revealed).toEqual([join(folder, 'a.ts')])
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

describe('whether a folder is a git workspace', () => {
  it('is true inside a repository and inside a worktree of it', async () => {
    gitInit()
    gitCommit()
    const made = await service.createWorktree(folder)
    if (!made.ok) throw new Error(made.output)

    expect(await service.isGitWorkspace(folder)).toBe(true)
    expect(await service.isGitWorkspace(made.path)).toBe(true)
  })

  it('is false for an ordinary folder and for one that is not there', async () => {
    expect(await service.isGitWorkspace(folder)).toBe(false)
    expect(await service.isGitWorkspace(join(folder, 'nothing-here'))).toBe(false)
  })
})

describe('creating a worktree with no script in the repository', () => {
  beforeEach(() => {
    gitInit()
    gitCommit()
  })

  it('branches from HEAD under .crucible/worktrees, and says which branch', async () => {
    const made = await service.createWorktree(folder)

    if (!made.ok) throw new Error(made.output)
    expect(made.branch).toMatch(/^crucible\/[0-9a-f]{6}$/)
    expect(made.path).toBe(join(folder, '.crucible', 'worktrees', made.branch?.slice(9) ?? ''))
    expect(existsSync(join(made.path, '.git'))).toBe(true)
    expect(
      execFileSync('git', ['-C', made.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
    ).toBe(made.branch)
  })

  it('makes the worktrees directory ignore itself, once', async () => {
    const ignore = join(folder, '.crucible', 'worktrees', '.gitignore')

    await service.createWorktree(folder)
    expect(readFileSync(ignore, 'utf8')).toBe('*\n')

    // A repository that wrote its own is left exactly as it is.
    writeFileSync(ignore, 'mine\n')
    await service.createWorktree(folder)
    expect(readFileSync(ignore, 'utf8')).toBe('mine\n')
  })

  it('gives each session a worktree of its own', async () => {
    const first = await service.createWorktree(folder)
    const second = await service.createWorktree(folder)

    if (!first.ok || !second.ok) throw new Error('both were supposed to succeed')
    expect(second.path).not.toBe(first.path)
    expect(second.branch).not.toBe(first.branch)
  })
})

describe('when the fallback fails', () => {
  it('hands back git’s own output as a value, named as git’s', async () => {
    // Whatever git refuses — here, a folder it will not branch in at all —
    // reaches the screen as git said it, and nothing is thrown.
    const made = await service.createWorktree(folder)

    expect(made.ok).toBe(false)
    const output = made.ok ? '' : made.output
    expect(output.split('\n')[0]).toMatch(/^git worktree add exited \d+$/)
    expect(output.toLowerCase()).toContain('git repository')
    // Nothing is cleaned up and nothing is invented: the directory it made
    // for itself is still there.
    expect(existsSync(join(folder, '.crucible', 'worktrees', '.gitignore'))).toBe(true)
  })
})

describe('the repository’s own worktree script', () => {
  beforeEach(() => {
    gitInit()
    gitCommit()
  })

  it('is the whole mechanism: its last line wins over everything it printed', async () => {
    worktreeScript(
      [
        '#!/bin/sh',
        'echo "preparing the worktree"',
        'echo "installing" 1>&2',
        'git worktree add -q -b feature/from-script "$PWD/from-script" 1>&2',
        'echo "$PWD/from-script"',
        ''
      ].join('\n')
    )

    const made = await service.createWorktree(folder)

    if (!made.ok) throw new Error(made.output)
    // Whatever the script printed, verbatim: the temp folder resolves through
    // a symlink here, and Crucible reports what it was told.
    expect(made.path).toBe(join(realpathSync(folder), 'from-script'))
    expect(made.branch).toBe('feature/from-script')
    // The fallback never ran: no crucible/ branch and no worktrees directory.
    expect(existsSync(join(folder, '.crucible', 'worktrees'))).toBe(false)
  })

  it('tells it nothing: a session is the invocation with no variables set', async () => {
    // The same script serves runs, which are told a base and sometimes a
    // branch. A session is the case where neither exists, and that is how a
    // script tells them apart.
    worktreeScript(
      [
        '#!/bin/sh',
        'echo "base=[${CRUCIBLE_WORKTREE_BASE-unset}] branch=[${CRUCIBLE_WORKTREE_BRANCH-unset}]" > "$PWD/told.txt"',
        'git worktree add -q -b feature/from-script "$PWD/from-script" 1>&2',
        'echo "$PWD/from-script"',
        ''
      ].join('\n')
    )

    const made = await service.createWorktree(folder)

    if (!made.ok) throw new Error(made.output)
    expect(readFileSync(join(folder, 'told.txt'), 'utf8').trim()).toBe(
      'base=[unset] branch=[unset]'
    )
  })

  it('leaves the branch unknown when the worktree it reports has none', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'crucible-elsewhere-'))
    try {
      worktreeScript(`#!/bin/sh\necho "${outside}"\n`)

      const made = await service.createWorktree(folder)

      if (!made.ok) throw new Error(made.output)
      expect(made.path).toBe(outside)
      expect(made.branch).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fails with its exit status and everything it printed', async () => {
    worktreeScript(
      ['#!/bin/sh', 'echo "checking the branch policy"', 'echo "no policy here" 1>&2', 'exit 3', ''].join('\n')
    )

    const made = await service.createWorktree(folder)

    expect(made.ok).toBe(false)
    const output = made.ok ? '' : made.output
    expect(output.split('\n')[0]).toBe('.crucible/worktree exited 3')
    expect(output).toContain('checking the branch policy')
    expect(output).toContain('no policy here')
  })

  it('fails when what it reported is not a worktree', async () => {
    worktreeScript(`#!/bin/sh\necho "somewhere/relative"\n`)

    const made = await service.createWorktree(folder)

    expect(made.ok).toBe(false)
    expect(made.ok ? '' : made.output).toContain('somewhere/relative')
  })

  it('fails when it reported nothing at all', async () => {
    worktreeScript(`#!/bin/sh\nexit 0\n`)

    const made = await service.createWorktree(folder)

    expect(made.ok).toBe(false)
    expect(made.ok ? '' : made.output).toContain('without reporting a worktree path')
  })

  it('never falls through to git when the repository’s script cannot be run', async () => {
    worktreeScript(`#!/bin/sh\necho "/tmp"\n`, { executable: false })

    const made = await service.createWorktree(folder)

    expect(made.ok).toBe(false)
    expect(made.ok ? '' : made.output).toContain('.crucible/worktree is not executable')
    expect(existsSync(join(folder, '.crucible', 'worktrees'))).toBe(false)
  })
})
