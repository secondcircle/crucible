// @vitest-environment node
//
// What Crucible ships inside the app, read through the same service and the
// same assembly the running app uses.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCS_INDEX_PLACEHOLDER } from './agent/system-prompt'
import { createCommandService } from './commands/service'
import { createSkillService, type LoadedSkill } from './skills/service'
import {
  readShippedRolePrompt,
  readShippedStandingPrompt,
  shippedCommandsPath,
  shippedDocsIndexPath,
  shippedSkillsPath,
  shippedSystemPrompt
} from './shipped'

// Word-bounded and case-insensitive, so "typing" passes and "~/.pi" does not:
// the agent must not learn the name of the layer below it.
const PI_BY_NAME = /\bpi\b/i

// The app's own directory, which in dev is the repository: the same value
// `app.getAppPath()` hands the composition root.
const APP = join(import.meta.dirname, '..', '..')

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'crucible-shipped-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** The real service, pointed at the shipped folder and nothing else. */
function shipped(): ReturnType<typeof createCommandService> {
  return createCommandService({
    roots: { builtIn: shippedCommandsPath(APP), user: join(workspace, 'no-user-folder') }
  })
}

describe('the built-in commands', () => {
  it('are exactly /align and /quick-align, at the built-in origin, with their hints', async () => {
    expect(await shipped().list(workspace)).toEqual([
      {
        name: 'align',
        description:
          'Grill an idea into shared understanding — glossary entries and ADRs as they crystallize, an intent brief on the confirming yes.',
        argumentHint: '[subject]',
        origin: 'built-in'
      },
      {
        name: 'quick-align',
        description:
          'Fast functional alignment — settle the end-user experience in a handful of questions, leave the technical shape to the implementation.',
        argumentHint: '[subject]',
        origin: 'built-in'
      }
    ])
  })

  it('expands /align with the subject, and with its default when none is given', async () => {
    const withSubject = await shipped().expand(workspace, '/align the command system')
    const without = await shipped().expand(workspace, '/align')

    expect(withSubject).toMatchObject({ kind: 'command', origin: 'built-in' })
    expect(withSubject.kind === 'command' ? withSubject.text : '').toContain(
      'The subject: the command system'
    )
    expect(without.kind === 'command' ? without.text : '').toContain(
      'The subject: (none given - make asking for it your first question)'
    )
  })

  it('keeps the interview whole: the ritual, the brief and its template', async () => {
    const expansion = await shipped().expand(workspace, '/align')
    const text = expansion.kind === 'command' ? expansion.text : ''

    expect(text).toContain('Do you agree we are fully aligned?')
    expect(text).toContain('<workspace>/.crucible/align/<YYMMDD>-<slug>.md')
    for (const heading of [
      "## What we're building",
      '## Rulings — what the user settled',
      '## Constraints and non-negotiables',
      '## Still open',
      '## Durable residue from this interview',
      '## Source material'
    ]) {
      expect(text).toContain(heading)
    }
    // The interview's own discipline, each recognizable in the shipped text.
    expect(text).toContain('design tree')
    expect(text).toContain('frontier')
    expect(text).toContain('CONTEXT.md')
    expect(text).toContain('docs/adr/')
  })

  it('carries no workflow machinery and no π folder', async () => {
    const expansion = await shipped().expand(workspace, '/align')
    const text = expansion.kind === 'command' ? expansion.text : ''

    for (const gone of [
      'crucible stage',
      'crucible start',
      'crucible run',
      'sub-agent',
      '.pi/prompts',
      '~/.pi',
      '<repo>'
    ]) {
      expect(text).not.toContain(gone)
    }
  })

  it('expands /quick-align whole: the ritual, the brief, the veto section', async () => {
    const withSubject = await shipped().expand(workspace, '/quick-align blank screen after summarize')
    const text = withSubject.kind === 'command' ? withSubject.text : ''

    expect(withSubject).toMatchObject({ kind: 'command', origin: 'built-in' })
    expect(text).toContain('The subject: blank screen after summarize')
    expect(text).toContain('Do you agree we are fully aligned?')
    expect(text).toContain('<workspace>/.crucible/align/<YYMMDD>-<slug>.md')
    expect(text).toContain('## Decided without asking — veto anything here')
  })

  it('keeps /quick-align ignorant of /align, sub-agents and π', async () => {
    const expansion = await shipped().expand(workspace, '/quick-align')
    const text = expansion.kind === 'command' ? expansion.text : ''

    // Its own name and the brief path both contain "align", so match /align
    // not preceded by "quick-" or ".crucible".
    expect(text).not.toMatch(/(?<!quick-)(?<!\.crucible)\/align/)
    for (const gone of ['sub-agent', '~/.pi', '<repo>']) {
      expect(text).not.toContain(gone)
    }
  })
})

describe('the shipped commands doc', () => {
  // Read where the index says it is, which is the only way a session finds it
  // now that no doc rides the system prompt.
  const doc = (): string =>
    readFileSync(join(dirname(shippedDocsIndexPath(APP)), 'commands.md'), 'utf8')

  it('names both Crucible folders, the built-in origin and the precedence', () => {
    expect(doc()).toContain('~/.crucible/commands/')
    expect(doc()).toContain('.crucible/commands/')
    expect(doc()).toContain('built-in')
    expect(doc()).toMatch(/workspace first, then user,\s+then built-in/)
  })

  it('teaches every substitution form and the quoting rule', () => {
    const text = doc()
    for (const form of [
      '$1',
      '$@',
      '$ARGUMENTS',
      '${1:-default}',
      '${@:-default}',
      '${ARGUMENTS:-default}',
      '${@:2}',
      '${@:2:3}'
    ]) {
      expect(text).toContain(form)
    }
    expect(text).toContain('"click handler"')
  })

  it('says Crucible does not read π\u2019s prompt folders, and cites no repository path', () => {
    const text = doc()
    expect(text).toContain('.pi/prompts')
    expect(text).toMatch(/does not read/)
    expect(text).not.toContain('src/')
    expect(text).not.toContain('docs/adr')
  })

  it('is the file that ships, byte for byte', () => {
    expect(doc()).toBe(readFileSync(join(APP, 'resources', 'agent-docs', 'commands.md'), 'utf8'))
  })
})

describe('the built-in skills', () => {
  // The real service, pointed at the shipped folder and nothing else, so what
  // is asserted is what π's own loader makes of the files that ship.
  const loaded = async (): Promise<readonly LoadedSkill[]> =>
    (await createSkillService({
      roots: { builtIn: shippedSkillsPath(APP), user: join(workspace, 'no-user-folder') }
    }).resolve(workspace)) ?? []

  const body = (): string =>
    readFileSync(join(shippedSkillsPath(APP), 'writing-agent-prompts', 'SKILL.md'), 'utf8')

  it('are exactly one skill, and it loads through π’s own loader', async () => {
    const skills = await loaded()

    expect(skills.map((skill) => skill.name)).toEqual(['writing-agent-prompts'])
    expect(skills[0].filePath).toBe(
      join(shippedSkillsPath(APP), 'writing-agent-prompts', 'SKILL.md')
    )
  })

  it('describe what they cover and when to read them', async () => {
    const [skill] = await loaded()

    expect(skill.description).toMatch(/instructions/)
    expect(skill.description).toMatch(/[Rr]ead it before/)
    expect(skill.description.length).toBeLessThanOrEqual(1024)
  })

  it('carry the doctrine forward: the goal, and why a rubric is not one', () => {
    const text = body()

    expect(text).toMatch(/## What a prompt carries/)
    for (const carried of ['The goal', 'The reason', 'The constraints']) {
      expect(text).toContain(carried)
    }
    // The load-bearing reason, not just the rule.
    expect(text).toMatch(/a goal survives a model upgrade untouched/)
    expect(text).toMatch(/rubric\s+encodes the weaknesses/)
  })

  it('correct the doctrine: the shape, the fragility, the omissions', () => {
    const text = body()

    // An example of the answer stays banned; an example of the shape is how
    // format and tone are steered.
    expect(text).toMatch(/expected answer\* is the one thing an example must never be/)
    expect(text).toMatch(/example of the \*shape\*/)
    expect(text).toMatch(/## Specificity matches fragility/)
    expect(text).toMatch(/Where exactly one route works, give it exactly/)
    expect(text).toMatch(/How far the work goes/)
    expect(text).toMatch(/when to stop/)
    expect(text).toMatch(/do not ask an agent to verify what it\s+already verifies/)
    // Deliberate vagueness under-delivers rather than producing variety.
    expect(text).toMatch(/smallest defensible interpretation/)
  })

  it('are behavior, never model trivia: no model named and no dated claim', () => {
    for (const text of [body(), supporting()]) {
      expect(text).not.toMatch(/\d{4}/)
      expect(text).not.toMatch(/\bas of\b/i)
      for (const model of ['claude', 'gpt', 'opus', 'sonnet', 'haiku', 'gemini', 'llama']) {
        expect(text.toLowerCase()).not.toContain(model)
      }
    }
  })

  it('are portable in fact: no Crucible, no π, no path inside this repository', () => {
    for (const text of [body(), supporting()]) {
      expect(text).not.toMatch(/crucible/i)
      expect(text).not.toMatch(PI_BY_NAME)
      expect(text).not.toContain('\u03c0')
      expect(text).not.toContain('src/')
      expect(text).not.toContain('docs/adr')
      expect(text).not.toContain('.crucible')
    }
  })

  // Short body, detail behind a relative path: the progressive disclosure the
  // transcript's skill marker is there to make visible.
  const supporting = (): string =>
    readFileSync(
      join(shippedSkillsPath(APP), 'writing-agent-prompts', 'scope-boundaries.md'),
      'utf8'
    )

  it('keep the body short and put the long part behind a relative path', () => {
    expect(body().split('\n').length).toBeLessThan(200)
    expect(body()).toContain('`scope-boundaries.md`')
    expect(supporting()).toMatch(/# Scope boundaries/)
  })

  it('ship markdown and nothing else', () => {
    const folder = join(shippedSkillsPath(APP), 'writing-agent-prompts')
    expect(readdirSync(folder).sort()).toEqual(['SKILL.md', 'scope-boundaries.md'])
  })
})

describe('the shipped skills doc', () => {
  const doc = (): string =>
    readFileSync(join(dirname(shippedDocsIndexPath(APP)), 'skills.md'), 'utf8')

  it('says what a skill is and that the model reaches for it on its own', () => {
    const text = doc()
    expect(text).toContain('SKILL.md')
    expect(text).toMatch(/read for yourself/)
    expect(text).toMatch(/Nobody invokes a\s+skill/)
  })

  it('names all three folders, the built-in origin and the precedence', () => {
    const text = doc()
    expect(text).toContain('~/.crucible/skills/')
    expect(text).toContain('.crucible/skills/')
    expect(text).toContain('built-in')
    expect(text).toMatch(/workspace first, then user,\s+then built-in/)
  })

  it('gives the frontmatter contract, both fields and their limits', () => {
    const text = doc()
    expect(text).toContain('name')
    expect(text).toContain('description')
    expect(text).toContain('64 characters')
    expect(text).toContain('1024 characters')
    expect(text).toMatch(/third person/)
    expect(text).toMatch(/resolve against that skill’s own directory|against that skill's own directory/)
  })

  it('says discovery is re-read on use, so a skill written now works next message', () => {
    expect(doc()).toMatch(/fresh on every turn/)
    expect(doc()).toMatch(/very next message/)
    expect(doc()).toMatch(/No\s+restart, no reload/)
  })

  it('says π’s own skill folders are invisible, and that there is no slash invocation', () => {
    const text = doc()
    expect(text).toContain('.pi/skills')
    expect(text).toMatch(/does not read/)
    expect(text).toContain('/skill:name')
    expect(text).toMatch(/never will be/)
  })

  it('says a workflow node may narrow its skills', () => {
    const text = doc()
    expect(text).toContain("skills: ['writing-agent-prompts']")
    expect(text).toMatch(/an empty\s+list means none at all/)
    expect(text).toMatch(/matching no skill is ignored/)
  })

  it('ends with a worked example, the way the commands doc does', () => {
    const text = doc()
    expect(text).toContain('## A worked example')
    expect(text.indexOf('## A worked example')).toBeGreaterThan(text.length / 2)
    expect(text).toContain('.crucible/skills/writing-migrations/SKILL.md')
  })

  it('is the file that ships, byte for byte', () => {
    expect(doc()).toBe(readFileSync(join(APP, 'resources', 'agent-docs', 'skills.md'), 'utf8'))
  })
})

describe('the shipped workflow-authoring doc', () => {
  const doc = (): string =>
    readFileSync(join(dirname(shippedDocsIndexPath(APP)), 'workflow-authoring.md'), 'utf8')

  it('documents the skills field: its default, an empty list, an unknown name', () => {
    const text = doc()
    expect(text).toContain('`skills`')
    expect(text).toMatch(/Omitted means every skill/)
    expect(text).toMatch(/empty\s+list means none at all/)
    expect(text).toMatch(/matching no skill is ignored/)
  })
})

describe('the shipped worktrees doc', () => {
  const doc = (): string =>
    readFileSync(join(dirname(shippedDocsIndexPath(APP)), 'worktrees.md'), 'utf8')

  it('gives the script contract whole: where, executable, no arguments, last line, exit 0', () => {
    const text = doc()
    expect(text).toContain('.crucible/worktree')
    expect(text).toContain('chmod +x .crucible/worktree')
    expect(text).toMatch(/last non-empty line/)
    expect(text).toMatch(/absolute/)
    expect(text).toMatch(/no arguments/)
    expect(text).toMatch(/[Ee]xit 0/)
    // Any language, and everything else is the script's own business.
    expect(text).toMatch(/Any language/)
  })

  it('says what happens with no script, so an agent knows when one is needed', () => {
    const text = doc()
    expect(text).toContain('git worktree add')
    expect(text).toContain('.crucible/worktrees/')
    expect(text).toMatch(/crucible\/</)
  })

  it('says branch names are throwaway and renaming later is the agent’s job', () => {
    const text = doc()
    expect(text).toMatch(/throwaway/)
    expect(text).toContain('git branch -m')
  })

  it('says Crucible never deletes a worktree, and how cleanup is done instead', () => {
    const text = doc()
    expect(text).toMatch(/never deletes/i)
    expect(text).toContain('git worktree remove')
    expect(text).toContain('git worktree prune')
  })

  it('names no π, and cites no path inside Crucible’s own repository', () => {
    const text = doc()
    expect(text).not.toMatch(PI_BY_NAME)
    expect(text).not.toContain('\u03c0')
    expect(text).not.toContain('src/')
    expect(text).not.toContain('docs/adr')
  })

  it('is the file that ships, byte for byte', () => {
    expect(doc()).toBe(
      readFileSync(join(APP, 'resources', 'agent-docs', 'worktrees.md'), 'utf8')
    )
  })
})

describe('the shipped Jira doc', () => {
  const doc = (): string =>
    readFileSync(join(dirname(shippedDocsIndexPath(APP)), 'jira.md'), 'utf8')

  it('gives both files by exact path and exact shape', () => {
    const text = doc()
    expect(text).toContain('.crucible/jira.json')
    expect(text).toContain('{ "projectKey": "EK" }')
    expect(text).toContain('.env.local')
    for (const key of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) {
      expect(text).toContain(key)
    }
    // The pointer is committable; the project key comes from nowhere else.
    expect(text).toMatch(/meant to be committed/)
    expect(text).toContain('JIRA_PROJECT_KEY')
    expect(text).toMatch(/is not read/)
  })

  it('puts the gitignore check before the token is ever written', () => {
    const text = doc()
    expect(text).toContain('git check-ignore -q .env.local')
    expect(text.indexOf('git check-ignore')).toBeLessThan(text.indexOf('JIRA_API_TOKEN=ATATT'))
    expect(text).toMatch(/before you write a single\s+credential/)
  })

  it('says where the values come from: a sibling repository or a fresh token', () => {
    const text = doc()
    expect(text).toMatch(/sibling repository/)
    expect(text).toContain('id.atlassian.com/manage-profile/security/api-tokens')
  })

  it('says what open means, and that the reading is all it ever does', () => {
    const text = doc()
    expect(text).toMatch(/status category is not done/)
    expect(text).toMatch(/[Nn]ot a status name/)
    expect(text).toMatch(/No transition, no assignment, no label,\s*\n?no comment/)
  })

  it('says how the board groups and orders, and that teammates stay visible', () => {
    const text = doc()
    expect(text).toMatch(/assigned to you, unclaimed, already picked/)
    expect(text).toMatch(/never hidden/)
    expect(text).toMatch(/account ids/)
  })

  it('describes the not-configured state and that reopening re-checks', () => {
    const text = doc()
    expect(text).toMatch(/not set up in this workspace yet/)
    expect(text).toMatch(/press \u2318I again/)
    expect(text).toMatch(/nothing to restart/)
  })

  it('names no \u03c0, and cites no path inside Crucible\u2019s own repository', () => {
    const text = doc()
    expect(text).not.toMatch(PI_BY_NAME)
    expect(text).not.toContain('\u03c0')
    expect(text).not.toContain('src/')
    expect(text).not.toContain('docs/adr')
  })

  it('is the file that ships, byte for byte', () => {
    expect(doc()).toBe(readFileSync(join(APP, 'resources', 'agent-docs', 'jira.md'), 'utf8'))
  })
})

describe('the shipped docs index', () => {
  const index = (): string => readFileSync(shippedDocsIndexPath(APP), 'utf8')

  it('names commands.md, and when to read it', () => {
    expect(index()).toContain('commands.md')
    expect(index()).toMatch(/asks about Crucible's commands/)
  })

  it('names worktrees.md, and when to read it', () => {
    expect(index()).toContain('worktrees.md')
    expect(index()).toMatch(/worktrees work with\s+Crucible/)
  })

  it('names jira.md, and when to read it', () => {
    expect(index()).toContain('jira.md')
    expect(index()).toMatch(/connect a repository to Jira/)
  })

  it('names skills.md, and when to read it', () => {
    expect(index()).toContain('skills.md')
    expect(index()).toMatch(/asks about Crucible's skills/)
  })

  it('says the docs it lists resolve beside itself', () => {
    expect(index()).toMatch(/relative to this file/i)
  })

  it('names no \u03c0', () => {
    expect(index()).not.toMatch(PI_BY_NAME)
    expect(index()).not.toContain('\u03c0')
  })
})

describe('the shipped role prompt', () => {
  const role = (): string => readShippedRolePrompt(APP)

  it('carries the two stock guidelines, in their own words', () => {
    expect(role()).toContain('- Be concise in your responses')
    expect(role()).toContain('- Name file paths accurately when working with files')
  })

  it('makes the panel the place a pertinent document lands, not a path in chat', () => {
    const text = role()
    expect(text).toMatch(/Open a document there whenever it is pertinent/)
    expect(text).toMatch(/say in\s+chat that you did/)
    expect(text).toMatch(/Close documents the conversation has moved past/)
    expect(text).toMatch(/renders markdown and HTML/)
  })

  it('points at the docs index by placeholder, and only when the user asks', () => {
    expect(role()).toContain(DOCS_INDEX_PLACEHOLDER)
    expect(role()).toMatch(/read only when the user asks about Crucible/)
    expect(role()).toMatch(/relative to the index file/)
  })

  it('names nothing of the layer below it', () => {
    const text = role()
    expect(text).not.toMatch(PI_BY_NAME)
    for (const gone of ['\u03c0', '/opt/homebrew', '~/.pi', 'harness', 'TUI', 'skills', 'themes']) {
      expect(text.toLowerCase()).not.toContain(gone.toLowerCase())
    }
  })
})

describe('the shipped standing prompt', () => {
  const standing = (): string => readShippedStandingPrompt(APP)

  it('is the communication style block, wrapped in its tags', () => {
    const text = standing().trim()
    expect(text.startsWith('<communication-style>')).toBe(true)
    expect(text.endsWith('</communication-style>')).toBe(true)
  })

  it('is the legacy block itself, recognizable sentence by sentence', () => {
    const text = standing()
    expect(text).toContain('# Unslop')
    expect(text).toContain('Edit text to remove AI patterns and add human voice.')
    expect(text).toContain('**Em dash overuse.**')
    expect(text).toContain('**Prefer the plain word.**')
  })
})

describe('the system prompt a launch composes', () => {
  it('substitutes the shipped index path and ends with the standing block', () => {
    const composed = shippedSystemPrompt(APP)

    expect(composed.startsWith('You are an expert coding assistant')).toBe(true)
    expect(composed).toContain(shippedDocsIndexPath(APP))
    expect(composed).not.toContain(DOCS_INDEX_PLACEHOLDER)
    expect(composed.endsWith('</communication-style>')).toBe(true)
  })

  it('never says the name of the layer below it', () => {
    expect(shippedSystemPrompt(APP)).not.toMatch(PI_BY_NAME)
  })

  it('names the file it ships and cannot read, rather than answering with less', () => {
    expect(() => shippedSystemPrompt(workspace)).toThrow(
      join(workspace, 'resources', 'prompts', 'role-coding-agent.md')
    )
  })
})
