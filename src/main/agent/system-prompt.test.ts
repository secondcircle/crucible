// @vitest-environment node
//
// The module is pure, so what an agent is told can be pinned here without
// constructing an adapter or spending anything.
import { describe, expect, it } from 'vitest'
import {
  composeNodeSystemPrompt,
  composeSystemPrompt,
  DOCS_INDEX_PLACEHOLDER
} from './system-prompt'

const ROLE = 'You are an expert coding assistant.'
const STANDING = '<communication-style>\nWrite plainly.\n</communication-style>'

describe('composing an agent\u2019s system prompt', () => {
  it('is the role, a blank line, then the standing prompt, and nothing else', () => {
    expect(composeSystemPrompt({ role: ROLE, standing: STANDING })).toBe(`${ROLE}\n\n${STANDING}`)
  })

  it('trims each layer, so a file\u2019s trailing newline is not a third blank line', () => {
    expect(composeSystemPrompt({ role: `\n${ROLE}\n\n`, standing: `${STANDING}\n` })).toBe(
      `${ROLE}\n\n${STANDING}`
    )
  })

  it('appends the standing prompt whatever the role says', () => {
    const reviewer = 'You review pull requests. You never touch files.'

    const composed = composeSystemPrompt({ role: reviewer, standing: STANDING })

    expect(composed.startsWith(reviewer)).toBe(true)
    expect(composed.endsWith(STANDING)).toBe(true)
  })

  it('substitutes every occurrence of the docs index placeholder', () => {
    const role = `Index: ${DOCS_INDEX_PLACEHOLDER}\nAgain: ${DOCS_INDEX_PLACEHOLDER}`

    const composed = composeSystemPrompt({
      role,
      standing: STANDING,
      docsIndexPath: '/Applications/Crucible.app/resources/agent-docs/index.md'
    })

    expect(composed).toContain('Index: /Applications/Crucible.app/resources/agent-docs/index.md')
    expect(composed).not.toContain(DOCS_INDEX_PLACEHOLDER)
  })

  // Each of these would be answered by π's own stock prompt or by a literal
  // placeholder in a paid call, so each is a throw instead.
  it('refuses a blank role prompt', () => {
    expect(() => composeSystemPrompt({ role: '  \n ', standing: STANDING })).toThrow(
      'A Crucible agent needs a role prompt; this one is blank.'
    )
  })

  it('refuses a blank standing prompt', () => {
    expect(() => composeSystemPrompt({ role: ROLE, standing: '' })).toThrow(
      'A Crucible agent needs a standing prompt; this one is blank.'
    )
  })

  it('refuses a placeholder nobody substituted', () => {
    expect(() =>
      composeSystemPrompt({ role: `${ROLE}\nIndex: ${DOCS_INDEX_PLACEHOLDER}`, standing: STANDING })
    ).toThrow(`The role prompt still names ${DOCS_INDEX_PLACEHOLDER}`)
  })
})

describe('composing a node\u2019s system prompt', () => {
  const BASE = 'You are an expert coding assistant.\n'
  const SYSTEM = 'You are one node of an automated run. Nobody reads your messages.'

  it('is the base alone when the workflow gives no system text', () => {
    expect(composeNodeSystemPrompt({ base: BASE })).toBe(BASE.trim())
    expect(composeNodeSystemPrompt({ base: BASE, system: '  \n' })).toBe(BASE.trim())
  })

  it('is the base, a blank line, then the workflow\u2019s text, whole', () => {
    expect(composeNodeSystemPrompt({ base: BASE, system: `\n${SYSTEM}\n\n` })).toBe(
      `${BASE.trim()}\n\n${SYSTEM}`
    )
  })

  // A blank base would hand the node the runtime's stock prompt, the one
  // thing every node must never open with.
  it('refuses a blank base', () => {
    expect(() => composeNodeSystemPrompt({ base: ' ', system: SYSTEM })).toThrow(
      'A Crucible node needs a base prompt; this one is blank.'
    )
  })
})
