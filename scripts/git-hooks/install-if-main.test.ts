// @vitest-environment node
//
// The hooks decide, on their own, when the human's installed app gets rebuilt
// — and they fire in a git process nobody is watching. So they are exercised
// here against a throwaway repo with `npm` stubbed: no build ever runs, and
// /Applications is never touched.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const hooks = fileURLToPath(new URL('.', import.meta.url))

let dir: string
let repo: string
let stamp: string
let builds: string

// Stands in for `npm run install:stable`: records the commit it built and
// stamps the installed app with it, which is the part the hooks read back.
const STUB = `#!/bin/bash
sha="$(git rev-parse --short HEAD)"
echo "install-stable (stub): built $sha"
echo "$sha" >> "$STUB_BUILDS"
printf '{ "commit": "%s" }\\n' "$sha" > "$CRUCIBLE_INSTALLED_STAMP"
sleep "\${STUB_SECONDS:-0}"
`

// stderr is dropped: git relays hook chatter through it, and a run of this
// file would otherwise be a wall of install-stable lines. execFileSync still
// throws if git itself fails.
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: env(),
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
    STUB_BUILDS: builds,
    CRUCIBLE_INSTALLED_STAMP: stamp,
    ...extra
  }
}

/** Commits fire the hook in the background; wait for it to have finished. */
function settled(): void {
  const lock = join(repo, 'logs', '.install-stable.lock')
  const deadline = Date.now() + 10_000
  while (existsSync(lock) && Date.now() < deadline) execFileSync('sleep', ['0.05'])
  execFileSync('sleep', ['0.1'])
}

function built(): string[] {
  if (!existsSync(builds)) return []
  return readFileSync(builds, 'utf8').split('\n').filter(Boolean)
}

/** The one script all three hooks call, run as a hook would run it. */
function hook(): void {
  execFileSync(join(hooks, 'install-if-main.sh'), [], {
    cwd: repo,
    env: env(),
    stdio: 'ignore'
  })
}

function log(): string {
  const file = join(repo, 'logs', 'install-stable.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function commit(message: string, file = 'a.txt'): void {
  writeFileSync(join(repo, file), `${message}\n`)
  git('add', file)
  git('commit', '-qm', message)
  settled()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crucible-hooks-'))
  repo = join(dir, 'repo')
  stamp = join(dir, 'build-stamp.json')
  builds = join(dir, 'builds.txt')

  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'npm'), STUB)
  chmodSync(join(dir, 'bin', 'npm'), 0o755)

  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.hooksPath', hooks)
  writeFileSync(join(repo, '.gitignore'), 'logs/\n')
  writeFileSync(join(repo, 'package.json'), '{ "name": "stub" }\n')
  writeFileSync(join(repo, 'a.txt'), 'first\n')
  git('add', '-A')
  git('commit', '-qm', 'first')
  settled()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a hook firing on main', () => {
  it('builds the commit main now points at', () => {
    const head = git('rev-parse', '--short', 'HEAD').trim()
    expect(built()).toEqual([head])
    expect(log()).toContain(`built ${head}`)
  })

  it('builds again for every further commit', () => {
    commit('second')
    commit('third')

    expect(built()).toHaveLength(3)
    expect(built().at(-1)).toBe(git('rev-parse', '--short', 'HEAD').trim())
  })

  it('builds a merge that landed', () => {
    git('checkout', '-qb', 'side')
    commit('on the side', 'b.txt')
    git('checkout', '-q', 'main')
    commit('on main', 'c.txt')

    const before = built().length
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    settled()

    expect(built().length).toBe(before + 1)
    expect(built().at(-1)).toBe(git('rev-parse', '--short', 'HEAD').trim())
  })

  it('builds once for an amend, though two hooks fire', () => {
    const before = built().length
    writeFileSync(join(repo, 'a.txt'), 'amended\n')
    git('commit', '-qa', '--amend', '-m', 'amended')
    settled()

    expect(built().length).toBe(before + 1)
    expect(built().at(-1)).toBe(git('rev-parse', '--short', 'HEAD').trim())
  })

  it('builds what a rebase left on main, which fires no post-commit', () => {
    git('checkout', '-qb', 'side')
    commit('side work', 'b.txt')
    git('checkout', '-q', 'main')
    commit('main work', 'c.txt')
    git('checkout', '-q', 'side')

    const before = built().length
    git('rebase', '-q', 'main')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--ff-only', 'side')
    settled()

    expect(built().length).toBeGreaterThan(before)
    expect(built().at(-1)).toBe(git('rev-parse', '--short', 'HEAD').trim())
  })
})

describe('a hook firing with nothing to install', () => {
  it('leaves a branch alone', () => {
    git('checkout', '-qb', 'feature')
    const before = built().length
    commit('on a branch', 'b.txt')

    expect(built().length).toBe(before)
  })

  it('skips a dirty tree, and says that is why', () => {
    writeFileSync(join(repo, 'untracked.txt'), 'in the way\n')
    const before = built().length
    commit('while dirty', 'b.txt')

    expect(built().length).toBe(before)
  })

  it('skips when the installed app is already this commit', () => {
    // The build in beforeEach stamped it, so firing again on the same commit
    // has nothing to do. This is what keeps an amend to one build.
    const before = built().length

    hook()
    hook()
    settled()

    expect(built().length).toBe(before)
  })
})
