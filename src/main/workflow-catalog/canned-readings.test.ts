// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cannedReply } from '../../shared/workflows/canned-readings'
import type { WorkflowReadRequest } from '../../shared/workflows/catalog'
import { DEFAULT_CATALOG_READER } from '../../shared/workflows/catalog-settings'
import { readingOf } from '../../shared/workflows/reader'

// The fake flavor's readings of this repository's own workflows, put through
// the same check a model's reply is: what the catalog shows in a fake launch
// is what passes here.

const FOLDER = join(__dirname, '..', '..', '..', '.crucible', 'workflows')

function requestFor(name: string, text = readFileSync(join(FOLDER, `${name}.ts`), 'utf8')): WorkflowReadRequest {
  return {
    reader: DEFAULT_CATALOG_READER,
    name,
    files: [{ path: join(FOLDER, `${name}.ts`), label: `${name}.ts`, text }],
    manifest: { description: `the ${name} workflow`, inputs: {} }
  }
}

function joined(lines: readonly (readonly { text: string }[])[]): string {
  return lines.map((line) => line.map((segment) => segment.text).join('')).join('\n')
}

describe('canned readings of this repository’s workflows', () => {
  for (const name of ['adhoc', 'adr-audit', 'build', 'main-thread-audit']) {
    it(`reads ${name} with citations the file bears out`, () => {
      const request = requestFor(name)
      const reading = readingOf(cannedReply(request), request, '2026-09-01T00:00:00.000Z')
      expect(reading.agents.length).toBeGreaterThan(0)
      for (const agent of reading.agents) {
        expect(agent.system?.name).toBe('NODE_SYSTEM')
        expect(joined(agent.system?.lines ?? [])).toContain('You are one node of an automated workflow run')
        expect(agent.prompt).toBeDefined()
        const quoted = joined(agent.prompt?.lines ?? [])
        expect(quoted.split('\n')[0]).toContain(agent.prompt?.name)
        // The whole declaration, and nothing of the next one.
        expect(quoted.trimEnd().endsWith('`') || quoted.trimEnd().endsWith('`;')).toBe(true)
        for (const quote of [agent.system, agent.prompt]) {
          const rest = joined(quote?.lines ?? []).split('\n').slice(1)
          expect(rest.filter((line) => /^(export )?(const|function) /.test(line))).toEqual([])
        }
      }
    })
  }

  it('names build’s two models where the file writes them', () => {
    const request = requestFor('build')
    const reading = readingOf(cannedReply(request), request, '2026-09-01T00:00:00.000Z')
    const models = Object.fromEntries(reading.agents.map((agent) => [agent.role, agent.model?.value]))
    expect(models).toEqual({
      Builder: 'anthropic/claude-opus-5-5:high',
      'Check fixer': 'anthropic/claude-opus-5-5:high',
      Reviewer: 'anthropic/claude-fable-5:high',
      Fixer: 'anthropic/claude-opus-5-5:high'
    })
  })

  it('names no model for main-thread-audit, whose nodes take the engine default', () => {
    const request = requestFor('main-thread-audit')
    const reading = readingOf(cannedReply(request), request, '2026-09-01T00:00:00.000Z')
    expect(reading.agents.map((agent) => agent.model)).toEqual([undefined, undefined, undefined])
  })

  it('highlights what a prompt fills in at run time', () => {
    const request = requestFor('build')
    const reading = readingOf(cannedReply(request), request, '2026-09-01T00:00:00.000Z')
    const builder = reading.agents.find((agent) => agent.role === 'Builder')
    const filled = (builder?.prompt?.lines ?? []).flat().filter((segment) => segment.filled)
    expect(filled.map((segment) => segment.text)).toEqual(['${intent}'])
  })

  it('follows a prompt that moved, so an edit never strands the quote', () => {
    const moved = `// a new first line\n\n${readFileSync(join(FOLDER, 'adhoc.ts'), 'utf8')}`
    const request = requestFor('adhoc', moved)
    const reading = readingOf(cannedReply(request), request, '2026-09-01T00:00:00.000Z')
    const original = readingOf(cannedReply(requestFor('adhoc')), requestFor('adhoc'), 'x')
    expect(reading.agents[0].prompt?.start).toBe((original.agents[0].prompt?.start ?? 0) + 2)
  })

  it('fails a reading whose prompt was renamed away rather than quoting the wrong lines', () => {
    const renamed = readFileSync(join(FOLDER, 'adhoc.ts'), 'utf8').replaceAll('taskPrompt', 'workPrompt')
    const request = requestFor('adhoc', renamed)
    expect(() => readingOf(cannedReply(request), request, 'x')).toThrow(/does not name it/)
  })
})
