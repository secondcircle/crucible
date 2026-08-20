// @vitest-environment node
//
// What Crucible ships inside the app, read through the same service and the
// same assembly the running app uses.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCS_INDEX_PLACEHOLDER } from './agent/system-prompt'
import { createCommandService } from './commands/service'
import {
  readShippedRolePrompt,
  readShippedStandingPrompt,
  shippedCommandsPath,
  shippedDocsIndexPath,
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
    expect(role()).toContain('- Show file paths clearly when working with files')
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
