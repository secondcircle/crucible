import { describe, expect, it } from 'vitest'
import { highlight, type Token } from './highlight'

/** The colored runs alone, as `kind:text`, so plain code stays out of the way. */
function colored(line: readonly Token[]): string[] {
  return line.filter((token) => token.kind !== 'plain').map((token) => `${token.kind}:${token.text}`)
}

describe('a brace language', () => {
  it('colors keywords, strings, numbers and capitalized names', () => {
    const [line] = highlight('const shown: PanelTab = read("plan.md", 42)', 'ts')

    expect(colored(line ?? [])).toEqual([
      'keyword:const',
      'type:PanelTab',
      'string:"plan.md"',
      'number:42'
    ])
  })

  it('takes a line comment to the end of the line, whatever is in it', () => {
    const [line] = highlight('call() // const "not a string" 12', 'ts')

    expect(colored(line ?? [])).toEqual(['comment:// const "not a string" 12'])
  })

  it('carries a block comment across the lines it spans, and stops at its end', () => {
    const lines = highlight('/* open\nstill inside\nclosed */ const x = 1', 'ts')

    expect(colored(lines[0] ?? [])).toEqual(['comment:/* open'])
    expect(colored(lines[1] ?? [])).toEqual(['comment:still inside'])
    expect(colored(lines[2] ?? [])).toEqual(['comment:closed */', 'keyword:const', 'number:1'])
  })

  it('carries a template string across lines the same way', () => {
    const lines = highlight('const t = `one\ntwo` + 3', 'ts')

    expect(colored(lines[0] ?? [])).toEqual(['keyword:const', 'string:`one'])
    expect(colored(lines[1] ?? [])).toEqual(['string:two`', 'number:3'])
  })

  it('does not end a string on an escaped quote', () => {
    const [line] = highlight('const a = "he said \\"no\\"" ', 'ts')

    expect(colored(line ?? [])).toEqual(['keyword:const', 'string:"he said \\"no\\""'])
  })
})

describe('a hash language', () => {
  it('comments from the hash and knows its own keywords', () => {
    const [line] = highlight('def run(): # not a keyword: const', 'py')

    expect(colored(line ?? [])).toEqual(['keyword:def', 'comment:# not a keyword: const'])
  })

  it('leaves `//` alone, because it is not a comment there', () => {
    const [line] = highlight('echo a//b', 'sh')

    expect(colored(line ?? [])).toEqual([])
  })
})

describe('a file the highlighter has no grammar for', () => {
  it('hands every line back whole and uncolored', () => {
    const lines = highlight('# A plan\n\nconst is not code here\n', 'md')

    expect(lines.map((line) => line.map((token) => token.kind))).toEqual([
      ['plain'],
      ['plain'],
      ['plain']
    ])
  })
})

describe('every file', () => {
  it('splits into lines, line endings included, and keeps the text intact', () => {
    const lines = highlight('one\r\ntwo\n', 'ts')

    // The closing newline ends the second line rather than starting a third.
    expect(lines.map((line) => line.map((token) => token.text).join(''))).toEqual(['one', 'two'])
  })

  it('keeps a genuinely empty last line, which is a line somebody wrote', () => {
    expect(highlight('one\n\n', 'ts')).toHaveLength(2)
  })

  it('leaves a line too long to be worth coloring exactly as it is', () => {
    const long = `const ${'x'.repeat(3000)} = "one"`
    const [line] = highlight(long, 'ts')

    expect(line).toEqual([{ kind: 'plain', text: long }])
  })
})
