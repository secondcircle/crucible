// @vitest-environment node
//
// The file format and the `$`-argument grammar, which both implementations
// read through this one module. π's semantics, Crucible's spec (ADR 0007).
import { describe, expect, it } from 'vitest'
import type { CommandInfo } from './service'
import {
  commandFragment,
  describe as descriptionOf,
  expandBody,
  filterCommands,
  parseCommandFile,
  splitInvocation,
  substitute,
  tokenize
} from './template'

/** The body of a file, expanded with an argument string, as a caller sees it. */
function expand(body: string, args: string): string {
  return expandBody({ body }, args)
}

describe('the file format', () => {
  it('reads the description and the argument hint out of the frontmatter', () => {
    const file = parseCommandFile(
      ['---', 'description: Review a pull request', 'argument-hint: "<PR-URL>"', '---', 'Review $1.'].join(
        '\n'
      )
    )

    expect(file.description).toBe('Review a pull request')
    expect(file.argumentHint).toBe('<PR-URL>')
    // Frontmatter is never substituted into and never delivered.
    expect(file.body.trim()).toBe('Review $1.')
  })

  it('falls back to the first non-empty line when no description is given', () => {
    const file = parseCommandFile('---\nargument-hint: "[days]"\n---\n\n\nSummarize the week.\n')

    expect(descriptionOf(file)).toBe('Summarize the week.')
    expect(file.argumentHint).toBe('[days]')
  })

  it('still expands a file whose frontmatter does not parse', () => {
    const file = parseCommandFile('---\nthis is not a field at all\n---\nDo the thing with $1.')

    expect(file.description).toBeUndefined()
    expect(file.argumentHint).toBeUndefined()
    expect(descriptionOf(file)).toBe('Do the thing with $1.')
    expect(expand(file.body, 'branches')).toBe('Do the thing with branches.')
  })

  it('treats an unterminated fence as a fence and keeps the rest as the body', () => {
    const file = parseCommandFile('---\ndescription: never closed\nStill the body.')

    expect(descriptionOf(file)).toBe('description: never closed')
    expect(file.body.trim()).toBe('description: never closed\nStill the body.')
  })

  it('takes a file with no frontmatter at all', () => {
    const file = parseCommandFile('Just a prompt.\n')

    expect(file.body.trim()).toBe('Just a prompt.')
    expect(descriptionOf(file)).toBe('Just a prompt.')
  })
})

describe('the invocation', () => {
  it('splits the name from the argument string', () => {
    expect(splitInvocation('/align the command system')).toEqual({
      name: 'align',
      args: 'the command system'
    })
    expect(splitInvocation('/standup')).toEqual({ name: 'standup', args: '' })
  })

  it('is nothing at all without a leading slash or a name', () => {
    expect(splitInvocation('align now')).toBeUndefined()
    expect(splitInvocation('/')).toBeUndefined()
    expect(splitInvocation('/ align')).toBeUndefined()
  })

  it('names the fragment only while the name is still being typed', () => {
    expect(commandFragment('/ali')).toBe('ali')
    expect(commandFragment('/')).toBe('')
    expect(commandFragment('/align x')).toBeUndefined()
    expect(commandFragment('hello')).toBeUndefined()
  })
})

describe('tokenizing an argument string', () => {
  it('splits on whitespace and keeps a quoted span whole', () => {
    expect(tokenize('Button "click handler"')).toEqual(['Button', 'click handler'])
  })

  it('collapses runs of whitespace and answers nothing for an empty string', () => {
    expect(tokenize('  a   b  ')).toEqual(['a', 'b'])
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })

  it('keeps an empty quoted span as an argument that is genuinely empty', () => {
    expect(tokenize('a "" b')).toEqual(['a', '', 'b'])
  })
})

describe('the substitution forms', () => {
  const tokens = ['one', 'two', 'three', 'four']

  const table: readonly [string, readonly string[], string][] = [
    ['$1 and $2', tokens, 'one and two'],
    ['$5', tokens, ''],
    ['$@', tokens, 'one two three four'],
    ['$ARGUMENTS', tokens, 'one two three four'],
    ['$@', [], ''],
    ['${1:-seven}', [], 'seven'],
    ['${1:-seven}', ['nine'], 'nine'],
    ['${1:-seven}', [''], 'seven'],
    ['${@:-a subject}', [], 'a subject'],
    ['${@:-a subject}', tokens, 'one two three four'],
    ['${ARGUMENTS:-a subject}', [], 'a subject'],
    ['${@:2}', tokens, 'two three four'],
    ['${@:2:2}', tokens, 'two three'],
    ['${@:9}', tokens, '']
  ]

  for (const [body, given, expected] of table) {
    it(`turns ${body} with ${given.length} argument(s) into ${JSON.stringify(expected)}`, () => {
      expect(substitute(body, given)).toBe(expected)
    })
  }

  it('leaves text that only resembles the grammar exactly as written', () => {
    expect(substitute('$ 1 and ${} and $x and 100$ and ${1', tokens)).toBe(
      '$ 1 and ${} and $x and 100$ and ${1'
    )
  })

  it('delivers the body substituted and trimmed, from the argument string', () => {
    expect(expand('\n\nCreate a component named $1 with features: ${@:2}\n\n', 'Button "click handler" a11y')).toBe(
      'Create a component named Button with features: click handler a11y'
    )
  })
})

describe('filtering the popover', () => {
  const commands: readonly CommandInfo[] = [
    { name: 'align', description: 'a', origin: 'built-in' },
    { name: 'component', description: 'c', origin: 'workspace' },
    { name: 'review', description: 'r', origin: 'user' }
  ]

  it('matches a case-insensitive subsequence of the name', () => {
    expect(filterCommands(commands, 'cmp').map((found) => found.name)).toEqual(['component'])
    expect(filterCommands(commands, 'AL').map((found) => found.name)).toEqual(['align'])
  })

  it('shows everything for an empty fragment and nothing for a miss', () => {
    expect(filterCommands(commands, '')).toHaveLength(3)
    expect(filterCommands(commands, 'zz')).toHaveLength(0)
  })
})
