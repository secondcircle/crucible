// @vitest-environment jsdom
//
// The chord and its label come out of one module, so what the app answers to
// and what it prints on screen cannot disagree.
import { describe, expect, it } from 'vitest'
import { chordPressed, keyLabel, keyPlatform, runningOn } from './keys'

describe('which modifier is this platform’s chord', () => {
  it('is ⌘ on a Mac, and only ⌘', () => {
    runningOn('darwin')

    expect(chordPressed({ metaKey: true, ctrlKey: false })).toBe(true)
    // The Mac behavior this change owns: Ctrl+R stops being a chord there.
    expect(chordPressed({ metaKey: false, ctrlKey: true })).toBe(false)
    expect(chordPressed({ metaKey: true, ctrlKey: true })).toBe(false)
    expect(chordPressed({ metaKey: false, ctrlKey: false })).toBe(false)
  })

  it('is Ctrl on Windows and Linux, and only Ctrl', () => {
    for (const platform of ['win32', 'linux']) {
      runningOn(platform)

      expect(chordPressed({ metaKey: false, ctrlKey: true })).toBe(true)
      expect(chordPressed({ metaKey: true, ctrlKey: false })).toBe(false)
      expect(chordPressed({ metaKey: true, ctrlKey: true })).toBe(false)
    }
  })

  it('reads the platform’s own name, however it is spelled', () => {
    runningOn('darwin')
    expect(keyPlatform()).toBe('mac')
    // The navigator's spelling, for a window without the preload's fact.
    runningOn('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(keyPlatform()).toBe('mac')
    runningOn('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(keyPlatform()).toBe('other')
  })
})

describe('how a key is spelled on screen', () => {
  it('keeps the Mac glyphs on a Mac', () => {
    runningOn('darwin')

    for (const chord of ['⌘I', '⌥⏎', '⌘V', '⌘⏎', '⌘C', '⌘B', '⌘R', '⌥↑']) {
      expect(keyLabel(chord)).toBe(chord)
    }
  })

  it('names the real key everywhere else', () => {
    runningOn('win32')

    expect(keyLabel('⌘I')).toBe('Ctrl+I')
    expect(keyLabel('⌥⏎')).toBe('Alt+⏎')
    expect(keyLabel('⌘V')).toBe('Ctrl+V')
    expect(keyLabel('⌘⏎')).toBe('Ctrl+⏎')
    expect(keyLabel('⌘C')).toBe('Ctrl+C')
    expect(keyLabel('⌘B')).toBe('Ctrl+B')
    expect(keyLabel('⌘R')).toBe('Ctrl+R')
    expect(keyLabel('⌥↑')).toBe('Alt+↑')
  })

  it('leaves the glyphs every keyboard shares exactly as they are', () => {
    runningOn('linux')

    expect(keyLabel('⏎')).toBe('⏎')
    expect(keyLabel('esc')).toBe('esc')
    expect(keyLabel('↑↓')).toBe('↑↓')
  })
})
