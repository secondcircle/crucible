// @vitest-environment node
//
// Where bash is, per OS, decided from a view of the machine rather than from
// the machine this runs on.
import { describe, expect, it } from 'vitest'
import { discoverBash, type MachineBashView } from './bash'
import { toPosixPath } from './exec'

function view(over: Partial<MachineBashView> = {}): MachineBashView {
  return { platform: 'darwin', path: '/usr/bin:/bin', exists: () => false, ...over }
}

describe('bash on a Mac and on Linux', () => {
  it('is bash, as PATH gives it', () => {
    expect(discoverBash(view())).toEqual({ ok: true, path: 'bash' })
    expect(discoverBash(view({ platform: 'linux' }))).toEqual({ ok: true, path: 'bash' })
  })
})

describe('bash on Windows', () => {
  const held = (...paths: string[]) => (path: string) => paths.includes(path)

  it('is the Git Bash beside whichever git is on PATH', () => {
    const found = discoverBash(
      view({
        platform: 'win32',
        path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
        exists: held('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe')
      })
    )

    expect(found).toEqual({ ok: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' })
  })

  it('never answers System32\\bash.exe, which is WSL and another world entirely', () => {
    const found = discoverBash(
      view({
        platform: 'win32',
        path: 'C:\\Windows\\system32',
        // WSL's bash is right there on PATH, and no git anywhere.
        exists: held('C:\\Windows\\system32\\bash.exe')
      })
    )

    expect(found.ok).toBe(false)
  })

  it('falls back to where Git for Windows installs itself, and never to a bare name', () => {
    const found = discoverBash(
      view({
        platform: 'win32',
        path: 'C:\\Windows\\system32',
        exists: held('C:\\Program Files\\Git\\bin\\bash.exe')
      })
    )

    expect(found).toEqual({ ok: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' })
  })

  it('says what is missing and where to get it when there is no Git Bash', () => {
    const found = discoverBash(view({ platform: 'win32', path: 'C:\\Windows\\system32' }))

    expect(found.ok).toBe(false)
    // The bash run renders this; a silent failure would be the defect.
    expect(found.ok === false && found.message).toContain('Git for Windows')
  })
})

describe('a Windows path as Git Bash reads it', () => {
  it('turns a drive letter into a root and backslashes into slashes', () => {
    expect(toPosixPath('C:\\Users\\you\\repo\\.crucible\\worktree')).toBe(
      '/c/Users/you/repo/.crucible/worktree'
    )
  })

  it('leaves a path that is already posix alone', () => {
    expect(toPosixPath('/home/you/repo/.crucible/worktree')).toBe('/home/you/repo/.crucible/worktree')
  })
})
