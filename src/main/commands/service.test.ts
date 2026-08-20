// @vitest-environment node
//
// The one module that genuinely reads command folders, driven against temp
// directories: no Electron, no renderer, no agent.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandService } from '../../shared/commands/service'
import { createCommandService } from './service'

let root: string
let workspace: string
let service: CommandService
let unreadable: string[]

/** `origin/name.md`, written with its folder created on the way. */
function write(origin: 'built-in' | 'user' | 'workspace', path: string, text: string): string {
  const folder =
    origin === 'workspace' ? join(workspace, '.crucible', 'commands') : join(root, origin)
  const full = join(folder, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
  return full
}

const names = async (): Promise<string[]> =>
  (await service.list(workspace)).map((command) => command.name)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-commands-'))
  workspace = mkdtempSync(join(tmpdir(), 'crucible-ws-'))
  unreadable = []
  service = createCommandService({
    roots: { builtIn: join(root, 'built-in'), user: join(root, 'user') },
    onUnreadable: (path) => unreadable.push(path)
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

describe('discovery', () => {
  it('finds commands at each of the three origins, alphabetically', async () => {
    write('built-in', 'align.md', 'Interview me.')
    write('user', 'review.md', 'Review $1.')
    write('workspace', 'component.md', 'Create $1.')

    expect(await service.list(workspace)).toEqual([
      { name: 'align', description: 'Interview me.', origin: 'built-in' },
      { name: 'component', description: 'Create $1.', origin: 'workspace' },
      { name: 'review', description: 'Review $1.', origin: 'user' }
    ])
  })

  it('lets workspace shadow user, and user shadow built-in, winners only', async () => {
    write('built-in', 'align.md', 'The shipped one.')
    write('user', 'align.md', 'The user one.')
    write('user', 'review.md', 'The user review.')
    write('workspace', 'align.md', 'The workspace one.')
    write('workspace', 'review.md', 'The workspace review.')

    const listed = await service.list(workspace)

    expect(listed.map((command) => `${command.name}:${command.origin}`)).toEqual([
      'align:workspace',
      'review:workspace'
    ])
    await expect(service.expand(workspace, '/align')).resolves.toMatchObject({
      origin: 'workspace',
      text: 'The workspace one.'
    })

    rmSync(join(workspace, '.crucible', 'commands', 'align.md'))
    // With the workspace file gone the user's own file wins, and the built-in
    // is still behind it.
    await expect(service.expand(workspace, '/align')).resolves.toMatchObject({
      origin: 'user',
      text: 'The user one.'
    })
  })

  it('reads one folder deep, `*.md` only', async () => {
    write('user', 'review.md', 'Review.')
    write('user', join('nested', 'deep.md'), 'Not a command.')
    write('user', 'notes.txt', 'Not a command either.')

    expect(await names()).toEqual(['review'])
  })

  it('tolerates every folder being missing, and creates none of them', async () => {
    expect(await service.list(workspace)).toEqual([])
    expect(await service.expand(workspace, '/align')).toEqual({ kind: 'plain' })
    // Nothing was written anywhere, least of all a dotfolder nobody asked for.
    expect(() => rmSync(join(workspace, '.crucible'), { recursive: true })).toThrow()
  })

  it('sees a file written between two calls, because nothing is cached', async () => {
    write('user', 'review.md', 'Review.')
    expect(await names()).toEqual(['review'])

    write('workspace', 'standup.md', 'Write the standup.')

    expect(await names()).toEqual(['review', 'standup'])
  })

  it('skips a file it cannot read and says which one, without failing', async () => {
    write('user', 'review.md', 'Review.')
    const denied = write('user', 'locked.md', 'Secret.')
    chmodSync(denied, 0o000)

    expect(await names()).toEqual(['review'])
    expect(unreadable).toEqual([denied])

    chmodSync(denied, 0o600)
  })
})

describe('what a command says about itself', () => {
  it('keeps the hint verbatim and falls back to the first line for a description', async () => {
    write('user', 'standup.md', '---\nargument-hint: "[days]"\n---\n\nSummarize the week.\n')

    expect(await service.list(workspace)).toEqual([
      {
        name: 'standup',
        description: 'Summarize the week.',
        argumentHint: '[days]',
        origin: 'user'
      }
    ])
  })

  it('lists a file whose frontmatter does not parse, and expands it', async () => {
    write('user', 'broken.md', '---\nnot a field\n---\nDo the thing with $1.')

    expect(await service.list(workspace)).toEqual([
      { name: 'broken', description: 'Do the thing with $1.', origin: 'user' }
    ])
    await expect(service.expand(workspace, '/broken now')).resolves.toMatchObject({
      text: 'Do the thing with now.'
    })
  })
})

describe('expansion', () => {
  it('substitutes the arguments and delivers the body alone', async () => {
    write(
      'workspace',
      'component.md',
      '---\ndescription: Create a React component\n---\nCreate a component named $1 with features: ${@:2}\n'
    )

    await expect(
      service.expand(workspace, '/component Button "click handler" a11y')
    ).resolves.toEqual({
      kind: 'command',
      name: 'component',
      origin: 'workspace',
      text: 'Create a component named Button with features: click handler a11y'
    })
  })

  it('answers plain for a draft that names no command, and for ordinary text', async () => {
    write('user', 'review.md', 'Review.')

    await expect(service.expand(workspace, '/nothing here')).resolves.toEqual({ kind: 'plain' })
    await expect(service.expand(workspace, 'just a message')).resolves.toEqual({ kind: 'plain' })
    await expect(service.expand(workspace, '/')).resolves.toEqual({ kind: 'plain' })
  })

  it('refuses display-safely when the file has gone since it was listed', async () => {
    const path = write('user', 'review.md', 'Review $1.')
    chmodSync(path, 0o000)

    await expect(service.expand(workspace, '/review')).rejects.toThrow(
      'The file behind /review could not be read.'
    )

    chmodSync(path, 0o600)
  })
})
