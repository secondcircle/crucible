import { describe, expect, it } from 'vitest'
import { constantString, declarationRange, quotedLines } from './source-scan'

const FILE = [
  "import { workflow } from 'crucible:workflow'", // 1
  '', // 2
  "const MODEL = 'anthropic/claude-fable-5:high'", // 3
  '', // 4
  '/** The prompt. */', // 5
  'export const promptOf = (round: number, earlier: string[]): string => `\\', // 6
  '# Round ${round}', // 7
  '', // 8
  'Earlier: ${earlier.length === 0 ? `none` : `${earlier.join(", ")}`}.', // 9
  'A literal \\${not} and a brace } in text.`', // 10
  '', // 11
  '// a comment between', // 12
  'const SPEC = {', // 13
  "  file: 'x.md',", // 14
  '  desc: "it\'s here"', // 15
  '}', // 16
  'const chained = [1, 2]', // 17
  '  .map((n) => n * 2)', // 18
  '  .join(",");', // 19
  'export default workflow({ description: "d", inputs: {}, run: async () => {} })' // 20
].join('\n')

describe('declaration ranges', () => {
  it('ends a template declaration at its closing backtick, past braces and backticks inside it', () => {
    expect(declarationRange(FILE, 'promptOf')).toEqual({ start: 6, end: 10 })
  })

  it('ends an object at its closing brace even when a comment follows', () => {
    expect(declarationRange(FILE, 'SPEC')).toEqual({ start: 13, end: 16 })
  })

  it('carries a statement across lines that continue it', () => {
    expect(declarationRange(FILE, 'chained')).toEqual({ start: 17, end: 19 })
  })

  it('finds nothing for a name that is not declared', () => {
    expect(declarationRange(FILE, 'missing')).toBeUndefined()
  })
})

describe('constant strings', () => {
  it('reads a one-line string constant and its line', () => {
    expect(constantString(FILE, 'MODEL')).toEqual({ value: 'anthropic/claude-fable-5:high', line: 3 })
  })
})

describe('quoted lines', () => {
  it('marks each interpolation whole, nested templates and all, and nothing else', () => {
    const lines = quotedLines(FILE, 6, 10)
    const filled = lines.flat().filter((segment) => segment.filled).map((segment) => segment.text)
    expect(filled).toEqual(['${round}', '${earlier.length === 0 ? `none` : `${earlier.join(", ")}`}'])
    expect(lines).toHaveLength(5)
    expect(lines[4].map((segment) => segment.text).join('')).toBe('A literal \\${not} and a brace } in text.`')
  })

  it('knows a range that opens inside a template is in one', () => {
    const lines = quotedLines(FILE, 7, 7)
    expect(lines[0]).toEqual([
      { text: '# Round ', filled: false },
      { text: '${round}', filled: true }
    ])
  })
})
