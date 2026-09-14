// @vitest-environment node
//
// What an agent's text could be naming, before any disk is asked. A false
// candidate costs a stat; a false link costs a click that goes nowhere, so the
// shape is where the rejections happen.
import { describe, expect, it } from 'vitest'
import { namedPath, pathPieces, viewOf } from './named-path'

describe('what reads as a path', () => {
  it('takes a path with a separator, and a bare name with an extension', () => {
    expect(namedPath('src/shared/agent/port.ts')).toEqual({ path: 'src/shared/agent/port.ts' })
    expect(namedPath('CONTEXT.md')).toEqual({ path: 'CONTEXT.md' })
    expect(namedPath('/Applications/Crucible.app/Contents/Resources/docs/index.md')).toEqual({
      path: '/Applications/Crucible.app/Contents/Resources/docs/index.md'
    })
    expect(namedPath('.crucible/align/260914-file-viewer.md')).toEqual({
      path: '.crucible/align/260914-file-viewer.md'
    })
  })

  it('takes the line, and the column with it, off the end', () => {
    expect(namedPath('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 })
    expect(namedPath('src/foo.ts:42:7')).toEqual({ path: 'src/foo.ts', line: 42 })
    // The suffix comes off before anything is checked, so the file is found
    // where a click could otherwise only fail.
    expect(namedPath('CONTEXT.md:1')?.path).toBe('CONTEXT.md')
  })

  it('refuses what is not a path at all', () => {
    // A commit hash, a tool name, a word: no separator and no extension.
    expect(namedPath('8dd033a')).toBeUndefined()
    expect(namedPath('panel_show')).toBeUndefined()
    expect(namedPath('CRUCIBLE_AGENT=sdk')).toBeUndefined()
    // A command, which is where the whitespace rule earns itself.
    expect(namedPath('npm run dev')).toBeUndefined()
    // A folder however it is spelled.
    expect(namedPath('docs/adr/')).toBeUndefined()
    // Addresses belong to the web door, never to this one.
    expect(namedPath('https://example.test/mock')).toBeUndefined()
    expect(namedPath('mailto:someone@example.test')).toBeUndefined()
    expect(namedPath('javascript:alert(1)')).toBeUndefined()
    expect(namedPath('')).toBeUndefined()
  })
})

describe('the view a click asks for', () => {
  it('opens on the line the text named, and otherwise on what the file renders', () => {
    expect(viewOf({ path: 'CONTEXT.md' })).toEqual({ kind: 'rendered' })
    expect(viewOf({ path: 'src/foo.ts', line: 42 })).toEqual({ kind: 'source', line: 42 })
  })
})

describe('a tool chain row header', () => {
  it('finds the path among the words, and keeps the rest as written', () => {
    expect(pathPieces('src/foo.ts')).toEqual([
      { kind: 'path', text: 'src/foo.ts', named: { path: 'src/foo.ts' } }
    ])
    expect(pathPieces('rm -rf build/icon.png')).toEqual([
      { kind: 'text', text: 'rm -rf ' },
      { kind: 'path', text: 'build/icon.png', named: { path: 'build/icon.png' } }
    ])
  })

  it('leaves a summary that names no file entirely alone', () => {
    expect(pathPieces('npm test')).toEqual([{ kind: 'text', text: 'npm test' }])
  })
})
