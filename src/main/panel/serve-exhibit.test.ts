// @vitest-environment node
//
// The whole decision, over a real panel model and real files: only Electron's
// translation into a `Response` sits above what is exercised here.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exhibitUrl, parseExhibitUrl } from '../../shared/agent/exhibit-url'
import type { SessionId } from '../../shared/agent/port'
import { createPanelModel, memoryPanelPersistence, type PanelModel } from './model'
import {
  EXHIBIT_POLICY,
  NOT_SHOWN,
  serveExhibit,
  unreadable,
  type ExhibitResponse
} from './serve-exhibit'

// Every read of a file goes through here, so a test can say that a refused
// request touched the disk not at all.
const disk = vi.hoisted(() => ({ read: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // Cast because the real one is a stack of overloads: the wrapper records the
  // path and hands the call straight on, whichever overload the caller meant.
  const readFileSync = ((path: never, options: never) => {
    disk.read.push(String(path))
    return actual.readFileSync(path, options)
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

const SESSION: SessionId = 's1'

let workspace: string
let panel: PanelModel

function file(name: string, body: string): string {
  const path = join(workspace, name)
  writeFileSync(path, body, 'utf8')
  return path
}

function get(url: string): ExhibitResponse {
  return serveExhibit(panel, { method: 'GET', url })
}

const text = (response: ExhibitResponse): string =>
  typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'crucible-exhibit-'))
  panel = createPanelModel({ persistence: memoryPanelPersistence() })
  disk.read.length = 0
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('what the scheme serves', () => {
  it('answers an open HTML tab with its bytes, under the exhibit policy', () => {
    const body = '<p id="out">measured</p><script>void 0</script>'
    panel.show(SESSION, workspace, file('benchmark.html', body), 'Benchmark')

    const response = get(exhibitUrl(SESSION, 'benchmark'))

    expect(response.status).toBe(200)
    expect(text(response)).toBe(body)
    expect(response.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"
    })
  })

  it('serves what the file says now, never a copy of what it said', () => {
    const path = file('benchmark.html', '<p>first</p>')
    panel.show(SESSION, workspace, path, 'Benchmark')
    expect(text(get(exhibitUrl(SESSION, 'benchmark')))).toBe('<p>first</p>')

    writeFileSync(path, '<p>second</p>', 'utf8')

    expect(text(get(exhibitUrl(SESSION, 'benchmark')))).toBe('<p>second</p>')
  })

  it('serves a tab of a session the user is not looking at', () => {
    panel.show('s2', workspace, file('other.html', '<p>other</p>'), 'Other')

    expect(text(get(exhibitUrl('s2', 'other')))).toBe('<p>other</p>')
  })

  it('serves ids that need encoding, through the shared builder', () => {
    panel.show('a session/one', workspace, file('a b.html', '<p>spaced</p>'), 'Spaced')

    expect(text(get(exhibitUrl('a session/one', 'a-b')))).toBe('<p>spaced</p>')
  })
})

describe('what the scheme refuses', () => {
  const refusal = (response: ExhibitResponse, body: string): void => {
    expect(response.status).toBe(404)
    expect(text(response)).toBe(body)
    expect(response.headers).toEqual({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': EXHIBIT_POLICY
    })
  }

  it('refuses a tab no session shows, and an unknown session', () => {
    panel.show(SESSION, workspace, file('benchmark.html', '<p>shown</p>'), 'Benchmark')

    refusal(get(exhibitUrl(SESSION, 'invented')), NOT_SHOWN)
    refusal(get(exhibitUrl('s404', 'benchmark')), NOT_SHOWN)
    expect(disk.read).toEqual([])
  })

  it('refuses a shown tab whose file vanished, and never the old bytes', () => {
    const path = file('benchmark.html', '<p>while it lasted</p>')
    panel.show(SESSION, workspace, path, 'Benchmark')
    expect(get(exhibitUrl(SESSION, 'benchmark')).status).toBe(200)

    rmSync(path)

    refusal(get(exhibitUrl(SESSION, 'benchmark')), 'That exhibit could not be read: benchmark.html.')
    expect(unreadable(path)).toBe('That exhibit could not be read: benchmark.html.')
  })

  it('refuses every smuggled shape, without reading a thing', () => {
    panel.show(SESSION, workspace, file('benchmark.html', '<p>shown</p>'), 'Benchmark')
    disk.read.length = 0

    const smuggled = [
      'exhibit://panel/s1/../../etc/passwd',
      'exhibit://panel/s1/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'exhibit://panel/s1/benchmark/extra',
      'exhibit://panel/s1',
      'exhibit://panel/s1/benchmark?path=/etc/passwd',
      'exhibit://panel/s1/benchmark#/etc/passwd',
      'exhibit://elsewhere/s1/benchmark',
      'file:///etc/passwd',
      `exhibit://panel/${encodeURIComponent(workspace)}/benchmark.html`
    ]

    for (const url of smuggled) refusal(get(url), NOT_SHOWN)
    expect(disk.read).toEqual([])
  })

  it('refuses a markdown tab: those keep their way through the port', () => {
    panel.show(SESSION, workspace, file('plan.md', '# the plan'), 'The plan')

    refusal(get(exhibitUrl(SESSION, 'plan')), NOT_SHOWN)
    expect(disk.read).toEqual([])
  })

  it('refuses a closed tab from then on', () => {
    panel.show(SESSION, workspace, file('benchmark.html', '<p>shown</p>'), 'Benchmark')
    expect(get(exhibitUrl(SESSION, 'benchmark')).status).toBe(200)

    panel.close(SESSION, 'benchmark')

    refusal(get(exhibitUrl(SESSION, 'benchmark')), NOT_SHOWN)
  })

  it('refuses every session\u2019s exhibits after a reset', () => {
    panel.show(SESSION, workspace, file('benchmark.html', '<p>shown</p>'), 'Benchmark')

    panel.reset(SESSION)

    refusal(get(exhibitUrl(SESSION, 'benchmark')), NOT_SHOWN)
  })

  it('refuses a method that is not GET', () => {
    panel.show(SESSION, workspace, file('benchmark.html', '<p>shown</p>'), 'Benchmark')

    const posted = serveExhibit(panel, { method: 'POST', url: exhibitUrl(SESSION, 'benchmark') })

    refusal(posted, NOT_SHOWN)
    expect(disk.read).toEqual([])
  })
})

describe('the shared URL format', () => {
  it('round-trips ids that need encoding', () => {
    const url = exhibitUrl('session/one two', 'tab #3')

    expect(url).toBe('exhibit://panel/session%2Fone%20two/tab%20%233')
    expect(parseExhibitUrl(url)).toEqual({
      kind: 'panel',
      sessionId: 'session/one two',
      tabId: 'tab #3'
    })
  })

  it('refuses every shape that is not exactly the contract', () => {
    for (const url of [
      'exhibits://panel/s1/plan',
      'https://panel/s1/plan',
      'exhibit://elsewhere/s1/plan',
      'exhibit://panel:9222/s1/plan',
      'exhibit://someone@panel/s1/plan',
      'exhibit://panel/s1',
      'exhibit://panel/s1/plan/extra',
      'exhibit://panel/s1/plan/',
      'exhibit://panel//plan',
      'exhibit://panel/s1/',
      'exhibit://panel/s1/plan?fresh=1',
      'exhibit://panel/s1/plan#top',
      'exhibit://panel/s1/%zz',
      'not a url at all'
    ]) {
      expect(parseExhibitUrl(url), url).toBeUndefined()
    }
  })
})
