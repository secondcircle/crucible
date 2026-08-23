// @vitest-environment node
//
// The origin ladder against real directories, through π's own loader: the
// loader is the decision (ADR 0021), so a test against a substitute would
// prove nothing about it. No session is constructed, no model is called and
// nothing is spent.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSkillService, foldersFor, narrowSkills, type LoadedSkill } from './service'

let root: string
let workspace: string
let user: string
let builtIn: string
const reported: { path?: string; message: string }[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crucible-skills-'))
  workspace = join(root, 'workspace')
  user = join(root, 'user-skills')
  builtIn = join(root, 'built-in-skills')
  mkdirSync(workspace, { recursive: true })
  reported.length = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function service(): ReturnType<typeof createSkillService> {
  return createSkillService({
    roots: { builtIn, user },
    onDiagnostic: (diagnostic) => reported.push(diagnostic)
  })
}

/** A skill folder at one of the three origins, with whatever frontmatter. */
function writeSkill(origin: string, name: string, frontmatter: string, body = 'the body\n'): string {
  const dir = join(origin, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}---\n${body}`, 'utf8')
  return dir
}

function projectOrigin(): string {
  return join(workspace, '.crucible', 'skills')
}

async function resolved(): Promise<readonly LoadedSkill[]> {
  return (await service().resolve(workspace)) ?? []
}

const named = (skills: readonly LoadedSkill[]): string[] => skills.map((skill) => skill.name).sort()

describe('the three origins', () => {
  it('are the workspace, the user and the built-ins, in that precedence', () => {
    expect(foldersFor({ builtIn, user }, workspace)).toEqual([projectOrigin(), user, builtIn])
  })

  it('offers every skill of every origin', async () => {
    writeSkill(projectOrigin(), 'local', 'name: local\ndescription: the workspace one\n')
    writeSkill(user, 'mine', 'name: mine\ndescription: the user one\n')
    writeSkill(builtIn, 'shipped', 'name: shipped\ndescription: the built-in one\n')

    expect(named(await resolved())).toEqual(['local', 'mine', 'shipped'])
  })

  it('lets a workspace skill shadow a user skill, and either shadow a built-in', async () => {
    const winner = writeSkill(projectOrigin(), 'review', 'name: review\ndescription: workspace\n')
    writeSkill(user, 'review', 'name: review\ndescription: user\n')
    writeSkill(builtIn, 'review', 'name: review\ndescription: built-in\n')

    const skills = await resolved()

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ description: 'workspace', baseDir: winner })
  })

  it('lets a user skill shadow a built-in when the workspace has none', async () => {
    writeSkill(user, 'review', 'name: review\ndescription: user\n')
    writeSkill(builtIn, 'review', 'name: review\ndescription: built-in\n')

    expect((await resolved())[0]).toMatchObject({ description: 'user' })
  })

  it('takes nothing at all from a folder that does not exist', async () => {
    writeSkill(builtIn, 'shipped', 'name: shipped\ndescription: the built-in one\n')

    expect(named(await resolved())).toEqual(['shipped'])
    // Two of the three origins are ordinarily absent, so their absence is not
    // an event and never reaches the log.
    expect(reported).toEqual([])
  })

  it('reads no folder of π\u2019s own', async () => {
    writeSkill(join(workspace, '.pi', 'skills'), 'theirs', 'name: theirs\ndescription: π\u2019s\n')

    expect(await resolved()).toEqual([])
  })
})

describe('a skill that cannot be used', () => {
  it('is skipped, silently, while the rest of its folder loads', async () => {
    writeSkill(projectOrigin(), 'broken', 'name: broken\n')
    writeSkill(projectOrigin(), 'fine', 'name: fine\ndescription: this one works\n')

    expect(named(await resolved())).toEqual(['fine'])
  })

  it('is on the run log, which is where the diagnosis happens', async () => {
    writeSkill(projectOrigin(), 'broken', 'name: broken\n')

    await resolved()

    expect(reported.some((entry) => entry.message.includes('description'))).toBe(true)
  })
})

describe('discovery on use', () => {
  it('finds a skill written after an earlier read, with no restart', async () => {
    const skills = service()
    expect(await skills.resolve(workspace)).toEqual([])

    writeSkill(projectOrigin(), 'fresh', 'name: fresh\ndescription: written just now\n')

    expect(named((await skills.resolve(workspace)) ?? [])).toEqual(['fresh'])
  })

  it('reads the folders of the workspace it was asked about', async () => {
    const other = join(root, 'other-workspace')
    mkdirSync(other, { recursive: true })
    writeSkill(join(other, '.crucible', 'skills'), 'theirs', 'name: theirs\ndescription: other\n')
    writeSkill(projectOrigin(), 'ours', 'name: ours\ndescription: this one\n')

    expect(named((await service().resolve(other)) ?? [])).toEqual(['theirs'])
    expect(named(await resolved())).toEqual(['ours'])
  })
})

describe('narrowing a node to a named subset', () => {
  const three: readonly LoadedSkill[] = [
    { name: 'one', description: 'a', filePath: '/s/one/SKILL.md', baseDir: '/s/one' },
    { name: 'two', description: 'b', filePath: '/s/two/SKILL.md', baseDir: '/s/two' },
    { name: 'three', description: 'c', filePath: '/s/three/SKILL.md', baseDir: '/s/three' }
  ]

  it('offers everything when the node asked for nothing', () => {
    expect(narrowSkills(three)).toEqual(three)
  })

  it('offers exactly the named ones', () => {
    expect(named(narrowSkills(three, ['one', 'three']))).toEqual(['one', 'three'])
  })

  it('offers nothing at all for an empty list', () => {
    expect(narrowSkills(three, [])).toEqual([])
  })

  it('ignores a name matching no skill', () => {
    expect(named(narrowSkills(three, ['two', 'nobody-has-this']))).toEqual(['two'])
  })
})
