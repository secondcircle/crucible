// @vitest-environment node
//
// The split rule alone, pinned without a browser: what the row draws in two
// parts, and what a copy writes whole.
import { describe, expect, it } from 'vitest'
import { guestSrc, shownLocation } from './exhibit-location'

const BASE = { id: 't', title: 'a tab', shownAt: '2026-09-01T09:00:00.000Z' } as const

const mdTab = (path: string) => ({ ...BASE, kind: 'markdown', path }) as const
const htmlTab = (path: string) => ({ ...BASE, kind: 'html', path }) as const
const webTab = (address: string) => ({ ...BASE, kind: 'url', address }) as const

describe('a file tab', () => {
  it('keeps the filename whole and gives the directory away, separator included', () => {
    const location = shownLocation(mdTab('/repos/crucible/.crucible/align/260828-addons.md'))

    expect(location.lead).toBe('/repos/crucible/.crucible/align/')
    expect(location.tail).toBe('260828-addons.md')
    expect(location.whole).toBe('/repos/crucible/.crucible/align/260828-addons.md')
  })

  it('reads the same way for an html exhibit as for a markdown one', () => {
    expect(shownLocation(htmlTab('/repos/crucible/mock.html'))).toEqual({
      whole: '/repos/crucible/mock.html',
      lead: '/repos/crucible/',
      tail: 'mock.html'
    })
  })

  it('gives an empty lead rather than a missing one when there is no directory', () => {
    expect(shownLocation(mdTab('plan.md'))).toEqual({
      whole: 'plan.md',
      lead: '',
      tail: 'plan.md'
    })
  })

  it('ignores where a guest navigated: the row names the file that was read', () => {
    const location = shownLocation(htmlTab('/repos/crucible/mock.html'), 'http://elsewhere/')

    expect(location.whole).toBe('/repos/crucible/mock.html')
  })
})

describe('a web tab', () => {
  it('gives the origin away and keeps the pathname', () => {
    expect(shownLocation(webTab('http://localhost:5241/extras'))).toEqual({
      whole: 'http://localhost:5241/extras',
      lead: 'http://localhost:5241',
      tail: '/extras'
    })
  })

  it('keeps a query and a hash in the part that stays', () => {
    const location = shownLocation(webTab('https://example.com/docs/guide?page=2#truncation'))

    expect(location.lead).toBe('https://example.com')
    expect(location.tail).toBe('/docs/guide?page=2#truncation')
  })

  it('shows where the guest went in place, not where the agent pointed it', () => {
    const location = shownLocation(
      webTab('http://localhost:5241/extras'),
      'http://localhost:5241/extras/confirm'
    )

    expect(location.whole).toBe('http://localhost:5241/extras/confirm')
    expect(location.tail).toBe('/extras/confirm')
  })

  it('shows an address it cannot split whole, in the part that stays', () => {
    expect(shownLocation(webTab('not a url at all'))).toEqual({
      whole: 'not a url at all',
      lead: '',
      tail: 'not a url at all'
    })
  })
})

describe('the two parts and the whole', () => {
  it('concatenate, always: what is drawn is a split of what is copied', () => {
    const paths = [
      '/repos/crucible/.crucible/align/260828-addons.md',
      'plan.md',
      '/a/b/c/d/e/f/g/deeply nested/notes with spaces.md'
    ]
    for (const path of paths) {
      const location = shownLocation(mdTab(path))
      expect(location.lead + location.tail).toBe(location.whole)
    }
    for (const address of ['http://localhost:5241/extras?a=1#b', 'mailto:nobody', 'nonsense']) {
      const location = shownLocation(webTab(address))
      expect(location.lead + location.tail).toBe(location.whole)
    }
  })
})

describe('what a guest loads', () => {
  it('is a file URL for an html exhibit, with its segments encoded', () => {
    expect(guestSrc(htmlTab('/repos/my repo/mock #2.html'))).toBe(
      'file:///repos/my%20repo/mock%20%232.html'
    )
  })

  it('is the address itself for a web tab', () => {
    expect(guestSrc(webTab('http://localhost:5173/'))).toBe('http://localhost:5173/')
  })
})
