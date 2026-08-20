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

function write(path: string, content = 'x'): void {
  const full = join(folder, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function gitInit(): void {
  execFileSync('git', ['init', '-q'], { cwd: folder })
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
  service = createWorkspaceService()
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
