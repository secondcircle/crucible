// @vitest-environment node
//
// A run's worktree when the repository owns creation: the shipped engine
// against a real temporary repository whose `.crucible/worktree` is a real
// script. What Crucible tells that script, what it refuses to believe, and
// what it leaves behind when it refuses.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowDef } from './authoring'
import {
  cleanupScratch,
  git,
  rig,
  startRequest,
  tempDir,
  until,
  type NodeScript
} from './testing/engine-rig'

afterEach(cleanupScratch)

/** The repository claims the mechanism by putting an executable file there. */
function worktreeScript(repo: string, body: string): void {
  mkdirSync(join(repo, '.crucible'), { recursive: true })
  const path = join(repo, '.crucible', 'worktree')
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
}

/** A setup script that would be impossible to miss if it ever ran. */
function setupScript(repo: string, body: string): void {
  mkdirSync(join(repo, '.crucible'), { recursive: true })
  const path = join(repo, '.crucible', 'worktree-setup')
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
}

/**
 * The well-behaved script: all three invocations honored, worktrees of its
 * own choosing well away from `.crucible/worktrees/`, and a line per
 * invocation recording exactly what it was told.
 */
function contractScript(homes: string, options: { readonly detach?: boolean } = {}): string {
  const fresh = options.detach
    ? `git worktree add --detach "$path" "$CRUCIBLE_WORKTREE_BASE" >&2`
    : `git worktree add -b "wt/$id" "$path" "$CRUCIBLE_WORKTREE_BASE" >&2`
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'id="$$-$RANDOM"',
    `path="${homes}/wt-$id"`,
    'echo "base=${CRUCIBLE_WORKTREE_BASE:-} branch=${CRUCIBLE_WORKTREE_BRANCH:-}" >> invocations.log',
    'echo "provisioning a dev slot for $path" >&2',
    'if [ -n "${CRUCIBLE_WORKTREE_BRANCH:-}" ]; then',
    '  # continuing a predecessor whose worktree still holds the branch',
    '  git worktree add --force "$path" "$CRUCIBLE_WORKTREE_BRANCH" >&2',
    'elif [ -n "${CRUCIBLE_WORKTREE_BASE:-}" ]; then',
    `  ${fresh}`,
    'else',
    '  git worktree add -b "wt/$id" "$path" HEAD >&2',
    'fi',
    'echo "$path"',
    ''
  ].join('\n')
}

/** Every invocation the fixture script recorded, in order. */
function invocations(repo: string): string[] {
  const log = join(repo, 'invocations.log')
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : []
}

const solo: WorkflowDef = {
  description: 'one node writing a file into the worktree',
  inputs: {},
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    await ctx.node('work', { prompt: 'do the thing' })
    return { summary: 'done' }
  }
}

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

/** A node that writes something into the worktree and says it is done. */
const working = (): NodeScript => (_prompt, tools) => {
  writeFileSync(join(tools.cwd, 'made-by-node.txt'), 'work\n')
  tools.complete({ summary: 'did the thing' })
}

describe('a run whose repository owns worktree creation', () => {
  it('takes the worktree the script reports, and runs no setup after it', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo, sessions } = rig({ solo }, working)
    worktreeScript(repo, contractScript(homes))
    // If setup ever ran after the script, this kickoff would be refused.
    setupScript(repo, '#!/usr/bin/env bash\ntouch .setup-ran\necho "setup ran" >&2\nexit 1\n')

    const started = await engine.start(startRequest(repo, 'solo', {}))
    await until(() => engine.runs()[0].status === 'complete')
    const run = engine.runs()[0]

    // The script decided where the worktree goes, and the run works there.
    expect(started.worktreePath?.startsWith(homes)).toBe(true)
    expect(existsSync(join(run.worktreePath ?? '', 'made-by-node.txt'))).toBe(true)
    expect(existsSync(join(run.worktreePath ?? '', '.setup-ran'))).toBe(false)
    // None of the plain-git path's side effects: no scaffolding directory.
    expect(existsSync(join(repo, '.crucible', 'worktrees'))).toBe(false)
    expect(sessions.prompts).not.toHaveLength(0)
    // The branch the script chose is the branch the run records and commits on.
    expect(run.branch).toMatch(/^wt\//)
    expect(run.finalCommit).toBe(git(repo, 'rev-parse', run.branch ?? ''))
  })

  it('tells the script the base as a full sha, and the run holds it', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo } = rig({ solo }, working)
    const base = git(repo, 'rev-parse', 'HEAD')
    // The checkout moves on; the run is still branched from where it asked.
    writeFileSync(join(repo, 'later.md'), 'later\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'second')
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(base)
    worktreeScript(repo, contractScript(homes))

    const started = await engine.start({ ...startRequest(repo, 'solo', {}), base })

    expect(invocations(repo)).toEqual([`base=${base} branch=`])
    expect(started.baseCommit).toBe(base)
    expect(git(started.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(base)
    expect(existsSync(join(started.worktreePath ?? '', 'later.md'))).toBe(false)

    await until(() => engine.runs()[0].status === 'complete')
    expect(engine.runs()[0].baseCommit).toBe(base)
  })

  it('sends a chained successor through the script, branch and all', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo } = rig({ first: stagesASuccessor, second: successor }, () => () => {})
    worktreeScript(repo, contractScript(homes))

    const started = await engine.start(startRequest(repo, 'first', {}))
    await until(() => engine.runs().some((run) => run.workflow === 'second'))
    await until(() => engine.runs().every((run) => run.status === 'complete'))

    const runs = engine.runs()
    const predecessor = runs.find((run) => run.id === started.id)
    const chained = runs.find((run) => run.workflow === 'second')
    expect(chained?.after).toBe(started.id)
    // The second invocation named the branch to continue and its tip.
    expect(invocations(repo)).toEqual([
      `base=${predecessor?.baseCommit} branch=`,
      `base=${predecessor?.finalCommit} branch=${predecessor?.branch}`
    ])
    expect(chained?.branch).toBe(predecessor?.branch)
    expect(chained?.baseCommit).toBe(predecessor?.finalCommit)
    // Both runs' work sits on the one branch, in two worktrees: the forced
    // checkout was needed because the predecessor's is kept.
    expect(git(repo, 'rev-parse', chained?.branch ?? '')).toBe(chained?.finalCommit)
    expect(existsSync(join(predecessor?.worktreePath ?? '', 'from-first.txt'))).toBe(true)
    expect(existsSync(join(chained?.worktreePath ?? '', 'from-second.txt'))).toBe(true)
    expect(chained?.worktreePath).not.toBe(predecessor?.worktreePath)
  })
})

describe('a script Crucible refuses to believe', () => {
  it('catches a session-only script that branched from HEAD instead of the base', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo, sessions } = rig({ solo }, working)
    const base = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'later.md'), 'later\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'second')
    // The script every repository wrote before runs used it: no variables
    // read, HEAD assumed.
    worktreeScript(
      repo,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'id="$$-$RANDOM"',
        `path="${homes}/stale-$id"`,
        'echo "the old script, still branching from HEAD" >&2',
        'git worktree add -b "stale/$id" "$path" HEAD >&2',
        'echo "$path"',
        ''
      ].join('\n')
    )

    await expect(engine.start({ ...startRequest(repo, 'solo', {}), base })).rejects.toThrow(
      /on the wrong commit[\s\S]*still branching from HEAD/
    )

    // Refused at kickoff: no run, and no node ever started.
    expect(engine.runs()).toHaveLength(0)
    expect(sessions.prompts).toHaveLength(0)
    // What the script made is left exactly where it is.
    const made = readdirSync(homes)
    expect(made).toHaveLength(1)
    expect(existsSync(join(homes, made[0], 'README.md'))).toBe(true)
    expect(git(repo, 'branch', '--list', 'stale/*')).not.toBe('')
  })

  it('names both shas when the commit is wrong', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo } = rig({ solo }, working)
    const base = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'later.md'), 'later\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'second')
    const head = git(repo, 'rev-parse', 'HEAD')
    worktreeScript(
      repo,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `path="${homes}/wrong"`,
        'git worktree add -b wrong "$path" HEAD >&2',
        'echo "$path"',
        ''
      ].join('\n')
    )

    const refusal = await engine
      .start({ ...startRequest(repo, 'solo', {}), base })
      .then(() => '', (cause: Error) => cause.message)

    expect(refusal).toContain(head)
    expect(refusal).toContain(base)
    expect(refusal).toContain('CRUCIBLE_WORKTREE_BASE asked for')
  })

  it('catches a successor put on a branch of its own', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo, delivered } = rig(
      { first: stagesASuccessor, second: successor },
      () => () => {}
    )
    // Right commit, always a fresh branch: the continuation is ignored.
    worktreeScript(
      repo,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'id="$$-$RANDOM"',
        `path="${homes}/wt-$id"`,
        'echo "always a fresh branch here" >&2',
        'git worktree add -b "own/$id" "$path" "$CRUCIBLE_WORKTREE_BASE" >&2',
        'echo "$path"',
        ''
      ].join('\n')
    )

    const started = await engine.start(startRequest(repo, 'first', {}))
    await until(() => engine.runs()[0].status === 'complete')
    await until(() => delivered.some((message) => message.text.includes('could not start')))

    // The predecessor completed; the successor never existed.
    expect(engine.runs()).toHaveLength(1)
    expect(engine.runs()[0].id).toBe(started.id)
    const told = delivered.at(-1)?.text ?? ''
    expect(told).toContain('on the wrong branch')
    expect(told).toContain(`CRUCIBLE_WORKTREE_BRANCH asked for ${engine.runs()[0].branch}`)
    expect(told).toContain('always a fresh branch here')
  })

  it('catches a worktree left on no branch at all', async () => {
    const homes = tempDir('crucible-script-worktrees-')
    const { engine, repo, sessions } = rig({ solo }, working)
    worktreeScript(repo, contractScript(homes, { detach: true }))

    await expect(engine.start(startRequest(repo, 'solo', {}))).rejects.toThrow(
      /on no branch[\s\S]*detached HEAD/
    )
    expect(engine.runs()).toHaveLength(0)
    expect(sessions.prompts).toHaveLength(0)
    // Refused, and still on disk: Crucible deletes nothing.
    expect(readdirSync(homes)).toHaveLength(1)
  })

  it('refuses a script that exits non-zero, reporting what it said', async () => {
    const { engine, repo, sessions } = rig({ solo }, working)
    worktreeScript(
      repo,
      '#!/bin/sh\necho "checking the dev slot pool"\necho "no slots free" 1>&2\nexit 3\n'
    )

    const refusal = await engine
      .start(startRequest(repo, 'solo', {}))
      .then(() => '', (cause: Error) => cause.message)

    expect(refusal).toContain('.crucible/worktree exited 3')
    expect(refusal).toContain('checking the dev slot pool')
    expect(refusal).toContain('no slots free')
    expect(engine.runs()).toHaveLength(0)
    expect(sessions.prompts).toHaveLength(0)
  })

  it('refuses a script whose reported path is not a worktree', async () => {
    const { engine, repo } = rig({ solo }, working)
    worktreeScript(repo, '#!/bin/sh\necho "somewhere/relative"\n')

    await expect(engine.start(startRequest(repo, 'solo', {}))).rejects.toThrow(
      /reported a path that is not a worktree: somewhere\/relative/
    )
    expect(engine.runs()).toHaveLength(0)
  })

  it('refuses a script it cannot execute, rather than falling back to git', async () => {
    const { engine, repo } = rig({ solo }, working)
    worktreeScript(repo, '#!/bin/sh\necho "never runs"\n')
    chmodSync(join(repo, '.crucible', 'worktree'), 0o644)

    await expect(engine.start(startRequest(repo, 'solo', {}))).rejects.toThrow(
      /\.crucible\/worktree is not executable[\s\S]*chmod \+x/
    )
    expect(engine.runs()).toHaveLength(0)
    // No quiet fall-through: git made nothing behind the repository's back.
    expect(existsSync(join(repo, '.crucible', 'worktrees'))).toBe(false)
  })
})
