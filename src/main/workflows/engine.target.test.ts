// @vitest-environment node
//
// A run's target repository: a real temporary workspace that is a small
// repository of its own, with an independent repository cloned inside it, as
// a workspace of several repositories is laid out. What the engine makes
// where, what it commits where, what it says, and every target it refuses
// before anything has cost money.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUN_MESSAGE_PREFIX } from '../../shared/workflows/run'
import type { LoadedSkill, SkillService } from '../skills/service'
import type { WorkflowDef } from './authoring'
import { scheduledBase } from './scheduled-base'
import {
  cleanupScratch,
  git,
  recordsOnDisk,
  rig,
  startRequest,
  tempDir,
  until,
  type NodeScript,
  type RigOptions
} from './testing/engine-rig'

afterEach(cleanupScratch)

/** A repository with one commit, initialised wherever it is asked to be. */
function repoAt(path: string, file = 'README.md'): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.invalid')
  git(path, 'config', 'user.name', 'Crucible Test')
  writeFileSync(join(path, file), `${file}\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', `first in ${file}`)
  return path
}

/**
 * The workspace: a repository that tracks only its own few files, with a
 * component repository cloned inside it and a plain folder of its own.
 */
function workspaceOfRepositories(): { workspace: string; component: string } {
  const workspace = tempDir('crucible-workspace-')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, '.gitignore'), '/*\n!/.gitignore\n!/AGENTS.md\n!/wiki/\n')
  writeFileSync(join(workspace, 'AGENTS.md'), 'the workspace\n')
  mkdirSync(join(workspace, 'wiki'))
  writeFileSync(join(workspace, 'wiki', 'index.md'), 'the wiki\n')
  repoAt(workspace, 'AGENTS.md')
  const component = repoAt(join(workspace, 'app'), 'app.txt')
  // A second commit, so the component's HEAD is nothing like the workspace's.
  writeFileSync(join(component, 'more.txt'), 'more\n')
  git(component, 'add', '-A')
  git(component, 'commit', '-q', '-m', 'second in app')
  return { workspace, component }
}

/** What the workflow's own code saw of where it is. */
const seen: { cwd?: string; workspacePath?: string }[] = []

const solo: WorkflowDef = {
  description: 'one node writing a file into the worktree',
  inputs: {},
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    seen.push({ cwd: ctx.cwd, workspacePath: ctx.workspacePath })
    await ctx.node('work', { prompt: 'do the thing' })
    return { summary: 'done' }
  }
}

const fixed: WorkflowDef = { ...solo, description: 'always in app', target: 'app' }
const required: WorkflowDef = { ...solo, description: 'wherever it is told', target: { required: true } }

/** A node that writes something into the worktree and says it is done. */
const working = (): NodeScript => (_prompt, tools) => {
  writeFileSync(join(tools.cwd, 'made-by-node.txt'), 'work\n')
  tools.complete({ summary: 'did the thing' })
}

function targetRig(
  defs: Record<string, WorkflowDef>,
  script: (nodeId: string) => NodeScript = working,
  options: RigOptions = {}
) {
  const { workspace, component } = workspaceOfRepositories()
  seen.length = 0
  return { ...rig(defs, script, { ...options, repo: workspace }), workspace, component }
}

function kickoff(workspace: string, workflow: string, target?: string, base = 'HEAD') {
  return {
    ...startRequest(workspace, workflow, {}),
    base,
    ...(target === undefined ? {} : { target })
  }
}

describe('a run that names no target', () => {
  it('works, commits and reports exactly as a run in the workspace repository always has', async () => {
    // Into the wiki, because the workspace's repository tracks nothing else.
    const intoTheWiki = (): NodeScript => (_prompt, tools) => {
      writeFileSync(join(tools.cwd, 'wiki', 'made-by-node.txt'), 'work\n')
      tools.complete({ summary: 'did the thing' })
    }
    const { engine, workspace, delivered, sessions } = targetRig({ solo }, intoTheWiki)

    const run = await engine.start(kickoff(workspace, 'solo'))
    await until(() => engine.runs()[0].status === 'complete')

    const done = engine.runs()[0]
    expect(done).not.toHaveProperty('targetRepository')
    expect(done.worktreePath).toBe(join(workspace, '.crucible', 'worktrees', `run-${run.id}`))
    expect(done.baseCommit).toBe(git(workspace, 'rev-parse', 'HEAD'))
    expect(git(workspace, 'show', `${done.branch}:wiki/made-by-node.txt`)).toBe('work')
    // Nodes get nothing beside their worktree: it carries the workspace.
    expect(sessions.requests[0]).not.toHaveProperty('workspace')
    expect(seen).toEqual([{ cwd: done.worktreePath, workspacePath: workspace }])
    expect(delivered.at(-1)?.text).toMatch(
      new RegExp(
        `^${RUN_MESSAGE_PREFIX} ${run.id} \\(solo\\) completed · branch crucible/run-${run.id} · ` +
          'worktree '
      )
    )
    expect(delivered.at(-1)?.text).not.toContain('repository')
  })

  it('means the same thing named as "." or any spelling of the workspace folder', async () => {
    const { engine, workspace } = targetRig({ solo })
    for (const spelling of ['.', './', 'app/..']) {
      const run = await engine.start(kickoff(workspace, 'solo', spelling))
      expect(run).not.toHaveProperty('targetRepository')
      expect(run.worktreePath).toBe(join(workspace, '.crucible', 'worktrees', `run-${run.id}`))
      await until(() => engine.runs().find((one) => one.id === run.id)?.status === 'complete')
    }
  })
})

describe('a run that targets a repository inside the workspace', () => {
  it("makes its worktree in the target, from the target's HEAD, and works and commits there", async () => {
    const target = targetRig({ solo })
    const { engine, workspace, component, sessions } = target

    const run = await engine.start(kickoff(workspace, 'solo', 'app'))
    await until(() => engine.runs()[0].status === 'complete')

    const done = engine.runs()[0]
    expect(done.targetRepository).toBe('app')
    // What the next launch reads back says which repository the run was in.
    expect(recordsOnDisk(target)[0].targetRepository).toBe('app')
    expect(done.workspacePath).toBe(workspace)
    expect(done.worktreePath).toBe(join(component, '.crucible', 'worktrees', `run-${run.id}`))
    // HEAD is the target's, never the workspace's.
    expect(done.baseCommit).toBe(git(component, 'rev-parse', 'main'))
    expect(done.baseCommit).not.toBe(git(workspace, 'rev-parse', 'HEAD'))
    // Every node worked in the target's worktree; the workflow's code can
    // still find the workspace folder.
    expect(sessions.requests.map((request) => request.cwd)).toEqual([done.worktreePath])
    expect(seen).toEqual([{ cwd: done.worktreePath, workspacePath: workspace }])
    // The work landed on the target's branch, and the workspace's repository
    // knows nothing of the run.
    expect(git(component, 'show', `${done.branch}:made-by-node.txt`)).toBe('work')
    expect(git(component, 'rev-parse', done.branch ?? '')).toBe(done.finalCommit)
    expect(git(workspace, 'branch', '--list', done.branch ?? '')).toBe('')
    expect(git(workspace, 'status', '--porcelain')).toBe('')
  })

  it('resolves a named base in the target repository', async () => {
    const { engine, workspace, component } = targetRig({ solo })
    const first = git(component, 'rev-parse', 'main~1')
    git(component, 'branch', 'older', first)

    const run = await engine.start(kickoff(workspace, 'solo', 'app', 'older'))

    expect(run.baseCommit).toBe(first)
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('names the target repository in its completion, before the branch and worktree', async () => {
    const { engine, workspace, component, delivered } = targetRig({ solo })

    const run = await engine.start(kickoff(workspace, 'solo', 'app'))
    await until(() => engine.runs()[0].status === 'complete')

    expect(delivered.at(-1)?.text).toContain(
      `${RUN_MESSAGE_PREFIX} ${run.id} (solo) completed · repository app · branch ` +
        `crucible/run-${run.id} · worktree ${join(component, '.crucible', 'worktrees', `run-${run.id}`)} · `
    )
  })

  it('names the target repository when it fails, too', async () => {
    const failing: WorkflowDef = {
      ...solo,
      run: async () => {
        throw new Error('the workflow gave up')
      }
    }
    const { engine, workspace, delivered } = targetRig({ failing })

    const run = await engine.start(kickoff(workspace, 'failing', 'app'))
    await until(() => engine.runs()[0].status === 'failed')

    expect(delivered.at(-1)?.text).toContain(
      `${RUN_MESSAGE_PREFIX} ${run.id} (failing) failed · repository app · branch crucible/run-${run.id}`
    )
  })

  it('normalizes the name it records, and accepts a repository at any depth', async () => {
    const { engine, workspace } = targetRig({ solo })
    repoAt(join(workspace, 'vendor', 'lib'))

    const spelled = await engine.start(kickoff(workspace, 'solo', './app/'))
    expect(spelled.targetRepository).toBe('app')
    await until(() => engine.runs()[0].status === 'complete')

    const deep = await engine.start(kickoff(workspace, 'solo', 'vendor/lib'))
    expect(deep.targetRepository).toBe(join('vendor', 'lib'))
    expect(relative(workspace, deep.worktreePath ?? '')).toBe(
      join('vendor', 'lib', '.crucible', 'worktrees', `run-${deep.id}`)
    )
    await until(() => engine.runs()[0].status === 'complete')
  })

  it("hands its nodes the workspace beside the worktree, and the workspace's skills behind the worktree's", async () => {
    const asked: [string, string | undefined][] = []
    const skills: SkillService = {
      async resolve(workspacePath, beside): Promise<readonly LoadedSkill[]> {
        asked.push([workspacePath, beside])
        return []
      }
    }
    const { engine, workspace, sessions } = targetRig({ solo }, working, { skills })

    const run = await engine.start(kickoff(workspace, 'solo', 'app'))
    await until(() => engine.runs()[0].status === 'complete')

    expect(sessions.requests[0].workspace).toBe(workspace)
    expect(asked).toEqual([[engine.runs()[0].worktreePath, workspace]])
    expect(run.targetRepository).toBe('app')
  })

  it('may start from a workspace folder that is no repository at all', async () => {
    const folder = tempDir('crucible-plain-workspace-')
    const component = repoAt(join(folder, 'app'))
    const { engine } = rig({ solo }, working, { repo: folder })

    const run = await engine.start(kickoff(folder, 'solo', 'app'))
    await until(() => engine.runs()[0].status === 'complete')

    expect(run.worktreePath).toBe(join(component, '.crucible', 'worktrees', `run-${run.id}`))
    expect(git(component, 'show', `${engine.runs()[0].branch}:made-by-node.txt`)).toBe('work')
  })
})

describe('a target that is refused at kickoff', () => {
  const refusals: [string, string, RegExp][] = [
    ['outside the workspace', '../elsewhere', /is not inside the workspace folder/],
    ['absolute', '/tmp', /is not inside the workspace folder/],
    ['missing', 'nowhere', /does not exist: nothing is at .*nowhere/],
    ['a plain folder of the workspace repository', 'wiki', /is not the top of a git repository: .*wiki is a folder inside the repository at /],
    ['a file', 'AGENTS.md', /is not a folder/]
  ]

  it.each(refusals)('refuses a target %s, naming it, before anything is made', async (_what, target, why) => {
    const { engine, workspace, sessions } = targetRig({ solo })

    await expect(engine.start(kickoff(workspace, 'solo', target))).rejects.toThrow(why)
    await expect(engine.start(kickoff(workspace, 'solo', target))).rejects.toThrow(
      `The target repository "${target}"`
    )

    expect(engine.runs()).toEqual([])
    expect(sessions.requests).toEqual([])
    expect(existsSync(join(workspace, '.crucible', 'worktrees'))).toBe(false)
  })

  it('refuses a folder inside the target repository rather than its top', async () => {
    const { engine, workspace, component } = targetRig({ solo })
    mkdirSync(join(component, 'src'))

    await expect(engine.start(kickoff(workspace, 'solo', 'app/src'))).rejects.toThrow(
      `is a folder inside the repository at`
    )
    expect(engine.runs()).toEqual([])
  })
})

describe('what a workflow declares about its target', () => {
  it('lands a run of a workflow with a fixed target there, when the kickoff names none', async () => {
    const { engine, workspace, component } = targetRig({ fixed })

    const run = await engine.start(kickoff(workspace, 'fixed'))

    expect(run.targetRepository).toBe('app')
    expect(run.worktreePath).toBe(join(component, '.crucible', 'worktrees', `run-${run.id}`))
    await until(() => engine.runs()[0].status === 'complete')
  })

  it("branches a scheduled run of a workflow with a fixed target from that repository's trunk", async () => {
    const { engine, workspace, component } = targetRig({ fixed })
    // The target's checkout sits on a branch of its own; its trunk is main.
    git(component, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(component, 'side.txt'), 'side\n')
    git(component, 'add', '-A')
    git(component, 'commit', '-q', '-m', 'on the side')

    const run = await engine.start({
      workspacePath: workspace,
      workspaceName: 'workspace',
      workflow: 'fixed',
      inputs: {},
      base: (target) => scheduledBase(target.path),
      scheduled: true
    })

    expect(run.targetRepository).toBe('app')
    expect(run.baseCommit).toBe(git(component, 'rev-parse', 'main'))
    expect(run.baseCommit).not.toBe(git(component, 'rev-parse', 'HEAD'))
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('takes the same repository named in another spelling as agreement', async () => {
    const { engine, workspace } = targetRig({ fixed })

    const run = await engine.start(kickoff(workspace, 'fixed', './app/'))

    expect(run.targetRepository).toBe('app')
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('refuses a kickoff whose target disagrees with the fixed one, naming both and the workflow', async () => {
    const { engine, workspace, sessions } = targetRig({ fixed })
    repoAt(join(workspace, 'other'))

    await expect(engine.start(kickoff(workspace, 'fixed', 'other'))).rejects.toThrow(
      'The workflow "fixed" works in the target repository "app", and this kickoff named "other".'
    )
    expect(engine.runs()).toEqual([])
    expect(sessions.requests).toEqual([])
  })

  it('refuses a kickoff that names no target for a workflow that requires one', async () => {
    const { engine, workspace, sessions } = targetRig({ required })

    await expect(engine.start(kickoff(workspace, 'required'))).rejects.toThrow(
      'The workflow "required" requires a target repository, and none was named.'
    )
    // "." names the workspace's own repository, which is naming none.
    await expect(engine.start(kickoff(workspace, 'required', '.'))).rejects.toThrow(
      'requires a target repository'
    )
    expect(engine.runs()).toEqual([])
    expect(sessions.requests).toEqual([])
  })

  it('starts a workflow that requires a target in the one the kickoff names', async () => {
    const { engine, workspace } = targetRig({ required })

    const run = await engine.start(kickoff(workspace, 'required', 'app'))

    expect(run.targetRepository).toBe('app')
    await until(() => engine.runs()[0].status === 'complete')
  })

  it('refuses a fixed target that is not a repository, before anything is made', async () => {
    const broken: WorkflowDef = { ...solo, target: 'wiki' }
    const { engine, workspace } = targetRig({ broken })

    await expect(engine.start(kickoff(workspace, 'broken'))).rejects.toThrow(
      'The target repository "wiki" is not the top of a git repository'
    )
    expect(engine.runs()).toEqual([])
  })
})

const stagesASuccessor: WorkflowDef = {
  description: 'stages a successor',
  inputs: {},
  run: async (ctx) => {
    writeFileSync(join(ctx.cwd, 'from-first.txt'), 'first\n')
    await ctx.stage({ workflow: 'second', inputs: {} })
  }
}

const successor: WorkflowDef = {
  description: 'the successor',
  inputs: {},
  run: async (ctx) => {
    writeFileSync(join(ctx.cwd, 'from-second.txt'), 'second\n')
  }
}

describe('a chained successor of a targeted run', () => {
  it("continues its predecessor's branch in its predecessor's target", async () => {
    const { engine, workspace, component } = targetRig({ first: stagesASuccessor, second: successor })

    const first = await engine.start(kickoff(workspace, 'first', 'app'))
    await until(() => engine.runs().some((run) => run.after === first.id && run.status === 'complete'))

    const second = engine.runs().find((run) => run.after === first.id)
    expect(second?.targetRepository).toBe('app')
    expect(second?.branch).toBe(first.branch)
    expect(second?.worktreePath).toBe(join(component, '.crucible', 'worktrees', `run-${second?.id}`))
    expect(git(component, 'show', `${first.branch}:from-first.txt`)).toBe('first')
    expect(git(component, 'show', `${first.branch}:from-second.txt`)).toBe('second')
  })

  it('is refused, and reported as the predecessor chaining failure, when its workflow fixes another target', async () => {
    const elsewhere: WorkflowDef = { ...successor, target: 'other' }
    const { engine, workspace, delivered } = targetRig({ first: stagesASuccessor, second: elsewhere })
    repoAt(join(workspace, 'other'))

    const first = await engine.start(kickoff(workspace, 'first', 'app'))
    await until(() =>
      delivered.some((message) => message.text.includes('staged a "second" run that could not start'))
    )

    expect(engine.runs().filter((run) => run.after === first.id)).toEqual([])
    const told = delivered.find((message) => message.text.includes('could not start'))?.text
    expect(told).toContain(`${RUN_MESSAGE_PREFIX} ${first.id} (first)`)
    expect(told).toContain(
      'The workflow "second" works in the target repository "other", but a chained successor ' +
        'continues in its predecessor\'s ("app")'
    )
  })

  it("is refused when its workflow fixes a target and its predecessor worked in the workspace's own", async () => {
    const pinned: WorkflowDef = { ...successor, target: 'app' }
    const { engine, workspace, delivered } = targetRig({ first: stagesASuccessor, second: pinned })

    const first = await engine.start(kickoff(workspace, 'first'))
    await until(() => delivered.some((message) => message.text.includes('could not start')))

    expect(engine.runs().filter((run) => run.after === first.id)).toEqual([])
    expect(delivered.find((message) => message.text.includes('could not start'))?.text).toContain(
      "continues in its predecessor's (the workspace's own repository)"
    )
  })
})

/** Blocks on its first turn; writes and completes on any later one. */
const blockThenFinish: (nodeId: string) => NodeScript = () => (_prompt, tools, turn) => {
  if (turn === 1 && !tools.continued) {
    tools.block({ reason: 'which way?' })
    return
  }
  writeFileSync(join(tools.cwd, 'made-by-node.txt'), 'work\n')
  tools.complete({ summary: 'did the thing' })
}

describe('resuming a targeted run', () => {
  it('carries on in the same worktree of the same target', async () => {
    const { engine, workspace, component, sessions } = targetRig({ solo }, blockThenFinish)
    const run = await engine.start(kickoff(workspace, 'solo', 'app'))
    await until(() => engine.runs()[0].waiting === true)
    engine.cancel(run.id)
    await until(() => engine.runs()[0].status === 'cancelled')

    await engine.resume(run.id)
    await until(() => engine.runs()[0].status === 'complete')

    const done = engine.runs()[0]
    expect(done.targetRepository).toBe('app')
    expect(done.worktreePath).toBe(run.worktreePath)
    expect(sessions.requests.at(-1)?.cwd).toBe(run.worktreePath)
    expect(sessions.requests.at(-1)?.workspace).toBe(workspace)
    expect(git(component, 'show', `${done.branch}:made-by-node.txt`)).toBe('work')
  })

  it('is refused, naming the path, when the target repository is gone', async () => {
    // The worktree is put outside the target by its own script, so it is the
    // target's absence that is refused rather than the worktree's.
    const homes = tempDir('crucible-target-worktrees-')
    const { engine, workspace, component } = targetRig({ solo }, blockThenFinish)
    worktreeScript(component, homes)
    git(component, 'add', '-A')
    git(component, 'commit', '-q', '-m', 'the worktree script')
    const run = await engine.start(kickoff(workspace, 'solo', 'app'))
    await until(() => engine.runs()[0].waiting === true)
    engine.cancel(run.id)
    await until(() => engine.runs()[0].status === 'cancelled')
    expect(run.worktreePath?.startsWith(homes)).toBe(true)

    rmSync(component, { recursive: true, force: true })

    await expect(engine.resume(run.id)).rejects.toThrow(
      `The run "${run.id}" cannot resume: its target repository is gone (${component}).`
    )
    expect(existsSync(run.worktreePath ?? '')).toBe(true)
    expect(engine.runs()[0].status).toBe('cancelled')
  })
})

/** A creation script that honors the run contract and puts worktrees in `homes`. */
function worktreeScript(repo: string, homes: string): void {
  mkdirSync(join(repo, '.crucible'), { recursive: true })
  const path = join(repo, '.crucible', 'worktree')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'id="$$-$RANDOM"',
      `path="${homes}/wt-$id"`,
      'echo "ran in $PWD" >&2',
      'if [ -n "${CRUCIBLE_WORKTREE_BRANCH:-}" ]; then',
      '  git worktree add --force "$path" "$CRUCIBLE_WORKTREE_BRANCH" >&2',
      'else',
      '  git worktree add -b "wt/$id" "$path" "$CRUCIBLE_WORKTREE_BASE" >&2',
      'fi',
      'echo "$path"',
      ''
    ].join('\n'),
    'utf8'
  )
  chmodSync(path, 0o755)
}

describe("the target repository's own worktree scripts", () => {
  it("are the ones that make a targeted run's worktree, verified as ever", async () => {
    const homes = tempDir('crucible-target-worktrees-')
    const { engine, workspace, component } = targetRig({ solo })
    worktreeScript(component, homes)
    // The workspace's script would refuse every run it was asked to make.
    mkdirSync(join(workspace, '.crucible'), { recursive: true })
    writeFileSync(join(workspace, '.crucible', 'worktree'), '#!/usr/bin/env bash\nexit 9\n')
    chmodSync(join(workspace, '.crucible', 'worktree'), 0o755)

    const run = await engine.start(kickoff(workspace, 'solo', 'app'))
    await until(() => engine.runs()[0].status === 'complete')

    expect(run.worktreePath?.startsWith(homes)).toBe(true)
    expect(run.baseCommit).toBe(git(component, 'rev-parse', 'main'))
    expect(git(component, 'show', `${engine.runs()[0].branch}:made-by-node.txt`)).toBe('work')
  })

  it("run the target's setup in a plain-git worktree, not the workspace's", async () => {
    const { engine, workspace, component } = targetRig({ solo })
    for (const [repo, body] of [
      [component, '#!/usr/bin/env bash\ntouch .target-setup-ran\n'],
      [workspace, '#!/usr/bin/env bash\necho "the workspace setup ran" >&2\nexit 1\n']
    ] as const) {
      mkdirSync(join(repo, '.crucible'), { recursive: true })
      writeFileSync(join(repo, '.crucible', 'worktree-setup'), body)
      chmodSync(join(repo, '.crucible', 'worktree-setup'), 0o755)
    }

    const run = await engine.start(kickoff(workspace, 'solo', 'app'))

    expect(existsSync(join(run.worktreePath ?? '', '.target-setup-ran'))).toBe(true)
    await until(() => engine.runs()[0].status === 'complete')
  })
})
