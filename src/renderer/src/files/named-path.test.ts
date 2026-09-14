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

  it('takes a name with no extension, because plenty of files have none', () => {
    // Nothing in the shape of `Makefile` separates it from `panel_show`, so
    // the disk is the only honest judge and these reach it.
    expect(namedPath('Makefile')).toEqual({ path: 'Makefile' })
    expect(namedPath('.gitignore')).toEqual({ path: '.gitignore' })
    expect(namedPath('LICENSE')).toEqual({ path: 'LICENSE' })
    // Which is the same reason a commit hash gets as far as a stat: it is a
    // candidate, and it is the disk that says no.
    expect(namedPath('8dd033a')).toEqual({ path: '8dd033a' })
  })

  it('refuses what could not be a path however the disk answered', () => {
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

  // Every word of every bash command passes through here, so a word taken out
  // of a line carries the shape rule a whole summary does not: a separator, or
  // an extension.
  it('takes no bare word of a command for a path, whatever the disk would say', () => {
    expect(pathPieces('rm -rf build')).toEqual([{ kind: 'text', text: 'rm -rf build' }])
    expect(pathPieces('cat Makefile')).toEqual([{ kind: 'text', text: 'cat Makefile' }])
  })

  // A `read` names one file and the summary is that file, extension or none.
  it('takes a summary that is one word whole, as a code span is taken', () => {
    expect(pathPieces('Makefile')).toEqual([
      { kind: 'path', text: 'Makefile', named: { path: 'Makefile' } }
    ])
    expect(pathPieces('CONTEXT.md:12')).toEqual([
      { kind: 'path', text: 'CONTEXT.md:12', named: { path: 'CONTEXT.md', line: 12 } }
    ])
  })
})
