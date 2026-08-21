// @vitest-environment node
//
// The text the adr-audit workflow emits: the doctrine it ships and the three
// prompts it interpolates that doctrine into. The file exports them so they
// can be read without a run, which is the only way to assert them at all —
// every one of them reaches a model and nothing else.
//
// No SDK session is constructed and no model is called: this reads a file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createJiti } from 'jiti'
import { beforeAll, describe, expect, it } from 'vitest'
import { shippedWorkflowLibPath, shippedWorkflowsPath } from '../shipped'
import type { WorkflowDef } from './authoring'

const APP = join(import.meta.dirname, '..', '..', '..')

interface AdrAuditModule {
  default: WorkflowDef
  ADR_DOCTRINE: string
  auditPrompt(): string
  sweepPrompt(): string
  reportPrompt(auditFindings: string, sweepFindings: string): string
}

let mod: AdrAuditModule

beforeAll(async () => {
  // Loaded the way the app loads a workflow — jiti with `crucible:workflow`
  // aliased to the shipped authoring module — but for the whole module, since
  // the engine's own loader hands back the default export alone.
  const jiti = createJiti(import.meta.filename, {
    moduleCache: false,
    interopDefault: true,
    alias: { 'crucible:workflow': shippedWorkflowLibPath(APP) }
  })
  mod = (await jiti.import(join(shippedWorkflowsPath(APP), 'adr-audit.ts'))) as AdrAuditModule
})

/**
 * Where a line happens to wrap is not something a prompt says, so these
 * assertions pin what it says and let the wrapping move.
 */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

function says(text: string, phrase: string, label?: string): void {
  expect(flat(text), label ?? phrase).toContain(flat(phrase))
}

/** Every word this workflow puts in front of a model, plus its catalog line. */
function everythingEmitted(): Record<string, string> {
  return {
    description: mod.default.description,
    doctrine: mod.ADR_DOCTRINE,
    audit: mod.auditPrompt(),
    sweep: mod.sweepPrompt(),
    report: mod.reportPrompt('/runs/40/audit-findings.md', '/runs/40/sweep-findings.md')
  }
}

describe('the doctrine adr-audit ships', () => {
  it('states what the folder is for, and that the old convention is not coming back', () => {
    says(mod.ADR_DOCTRINE, 'what is currently decided and nothing else')
    says(mod.ADR_DOCTRINE, 'git log --follow')
    expect(mod.ADR_DOCTRINE).toMatch(/tombstones/i)
    expect(mod.ADR_DOCTRINE).toMatch(/superseded/i)
    expect(mod.ADR_DOCTRINE).toMatch(/repair/i)
  })

  it('states the three-part test an ADR has to pass', () => {
    expect(mod.ADR_DOCTRINE).toMatch(/hard to reverse/i)
    expect(mod.ADR_DOCTRINE).toMatch(/surprising without context/i)
    expect(mod.ADR_DOCTRINE).toMatch(/real trade-off/i)
    says(mod.ADR_DOCTRINE, 'fails any leg no longer describes a decision worth a file')
  })

  it('states the deletion precondition, which is the whole of the safety', () => {
    says(mod.ADR_DOCTRINE, 'deleted only once everything load-bearing in it survives')
    says(mod.ADR_DOCTRINE, "surviving ADR's Considered Options")
    says(mod.ADR_DOCTRINE, 'the reason it failed')
    says(mod.ADR_DOCTRINE, 'make it true first by editing the survivor, and only then delete')
  })

  it('bans invented rationale, authoring, splitting and renumbering', () => {
    says(mod.ADR_DOCTRINE, 'only with evidence that can be found and cited in the repository')
    says(mod.ADR_DOCTRINE, 'indistinguishable from a recorded one')
    says(mod.ADR_DOCTRINE, 'flagged in the report and left unedited')
    says(mod.ADR_DOCTRINE, 'Writing a new ADR is authoring a decision nobody made')
    expect(mod.ADR_DOCTRINE).toMatch(/splitting one into two/i)
    says(mod.ADR_DOCTRINE, 'never reused and never renumbered')
    expect(mod.ADR_DOCTRINE).toMatch(/no ADR file is renamed/i)
  })

  it('states the citation rule, and what survives it', () => {
    says(mod.ADR_DOCTRINE, 'no prompt, no comment and no lint message names a specific ADR')
    says(mod.ADR_DOCTRINE, 'look for relevant ADRs')
    expect(flat(mod.ADR_DOCTRINE)).toMatch(/generic pointers at the folder stay/i)
    says(mod.ADR_DOCTRINE, 'Cross-references between documents survive, ADR to ADR included')
  })

  it('puts the historical records out of reach', () => {
    says(mod.ADR_DOCTRINE, '`.crucible/align/` and `.crucible/runs/`')
    expect(flat(mod.ADR_DOCTRINE)).toMatch(/nothing edits them/i)
  })

  it('reaches both the agents that enforce it', () => {
    says(mod.auditPrompt(), mod.ADR_DOCTRINE, 'the audit gets the doctrine')
    says(mod.sweepPrompt(), mod.ADR_DOCTRINE, 'the sweep gets the doctrine')
  })
})

describe('what the audit is told', () => {
  it('gives it four operations and the limit on each', () => {
    const prompt = mod.auditPrompt()

    says(prompt, '**Delete** an ADR that no longer describes a live decision')
    says(prompt, 'only under the deletion precondition')
    says(prompt, '**Fold** overlapping or mutually amending ADRs')
    says(prompt, 'survivor keeps its own number and its own filename')
    says(prompt, '**Strengthen** a warranted ADR that argues badly')
    says(prompt, 'No findable evidence means no edit')
    says(prompt, '**Flag** an ADR whose decision may never have been real')
    says(prompt, 'the question the user has to answer, and edit nothing about it')
  })

  it('forbids authoring, renumbering and every edit outside the folder', () => {
    says(
      mod.auditPrompt(),
      '**Forbidden**: authoring a new ADR, splitting one into two, renumbering, reusing a ' +
        'number, renaming a file, inventing a rationale, editing anything outside `docs/adr/`, ' +
        'and touching `.crucible/align/` or `.crucible/runs/`.'
    )
  })

  it('demands findings a user can judge the kept ADRs from, and counts that partition', () => {
    const prompt = mod.auditPrompt()

    says(prompt, 'one entry per ADR file that was present when you started')
    says(prompt, 'relational findings')
    says(prompt, 'a change the user cannot evaluate from this record alone is a defect')
    says(prompt, 'a kept ADR leaves no diff at all')
    says(prompt, "the four numbers sum to the folder's starting size")
  })

  it('rules an empty folder a result rather than an error', () => {
    says(mod.auditPrompt(), 'is a legitimate outcome, not an error')
  })
})

describe('what the sweep is told', () => {
  it('names both files whose citations are not citations', () => {
    const prompt = mod.sweepPrompt()

    says(prompt, '`src/shared/workspace/fake-service.ts`')
    says(prompt, '`docs/design/mock-h-queue-and-chains.html`')
    says(prompt, 'In a repository that has neither file, the exclusion costs nothing')
  })

  it('names the two directories nothing may edit', () => {
    says(mod.sweepPrompt(), '`.crucible/align/` and `.crucible/runs/`')
  })

  it('scopes the search to text, and spares the generic pointers', () => {
    const prompt = mod.sweepPrompt()

    says(prompt, '**In scope**')
    expect(flat(prompt)).toMatch(/lint messages among them/i)
    says(prompt, 'prompt text, and the code that builds prompt text')
    says(prompt, 'generic pointers at `docs/adr/`')
    says(prompt, 'cross-references between documents, ADR to ADR included')
  })

  it('has citations deleted rather than repointed, and logic left alone', () => {
    const prompt = mod.sweepPrompt()

    says(prompt, 'deleted, never rewritten to point somewhere else')
    says(prompt, 'A sentence that is nothing but the citation goes entirely')
    says(prompt, 'logic, identifiers and structure stay exactly as they are')
    says(prompt, 'Finding nothing is a legitimate outcome')
  })
})

describe('what the report is told', () => {
  it('carries the paths of both findings files it is built from', () => {
    const prompt = mod.reportPrompt('/runs/40/audit-findings.md', '/runs/40/sweep-findings.md')

    says(prompt, '`/runs/40/audit-findings.md`')
    says(prompt, '`/runs/40/sweep-findings.md`')
  })

  it('requires every section, present even when it is empty', () => {
    const prompt = mod.reportPrompt('/a.md', '/b.md')

    for (const section of [
      '**The verdict at a glance**',
      '**Every deletion**',
      '**Every fold**',
      '**Every strengthening**',
      '**Every flag**',
      '**Every ADR left alone**',
      '**The citation sweep**'
    ]) {
      says(prompt, section)
    }
    says(prompt, 'an empty walk is a result and a missing section reads as a silent omission')
  })

  it('holds the report to being judgeable on its own, and to changing nothing', () => {
    const prompt = mod.reportPrompt('/a.md', '/b.md')

    says(prompt, 'A change the user cannot evaluate from the report alone is a defect')
    says(prompt, 'verifying a findings claim against the diff is cheap, verify it')
    says(prompt, 'You change nothing in the worktree')
    says(prompt, 'dark-mode HTML document')
  })
})

// The citation rule binds the enforcer's own text first, since it lives
// outside the folder, and an example written to illustrate it would break it.
describe('the enforcer is clean of what it treats', () => {
  it('names no specific ADR in anything it emits', () => {
    for (const [what, text] of Object.entries(everythingEmitted())) {
      expect(text, what).not.toMatch(/\bADR\s*\d/i)
      expect(text, what).not.toMatch(/docs\/adr\/\d/i)
    }
  })

  it('names none in its own source either, comments included', () => {
    const source = readFileSync(join(shippedWorkflowsPath(APP), 'adr-audit.ts'), 'utf8')

    expect(source).not.toMatch(/\bADR\s*\d/i)
    expect(source).not.toMatch(/docs\/adr\/\d/i)
  })

  it('still points at the folder, which is what sends an agent to look', () => {
    expect(mod.ADR_DOCTRINE).toContain('`docs/adr/`')
    expect(mod.auditPrompt()).toContain('`docs/adr/`')
    expect(mod.sweepPrompt()).toContain('`docs/adr/`')
  })
})
