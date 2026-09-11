// @vitest-environment node
//
// Only the rule and the log line: building the live service would mean an
// Electron window, and what it does with one is tested in service.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { LogEntry, LogSink } from '../log/sink'
import { bannerWords, needsYouServiceKind, selectNeedsYouService } from './select-service'

vi.mock('electron', () => ({
  app: { setBadgeCount: () => {} },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

function memorySink(): { sink: LogSink; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return { sink: { append: (entry) => entries.push(entry) }, entries }
}

describe('choosing a needs-you service', () => {
  it('lets only the sdk flavor reach the dock and the notification centre', () => {
    expect(needsYouServiceKind('sdk')).toBe('live')
    // An agent driving a fake-flavor window must not post banners onto the
    // human's machine from an app they are not using.
    expect(needsYouServiceKind('fake')).toBe('quiet')
  })

  it('names the question in the banner an open question posts', () => {
    expect(
      bannerWords({
        sessionId: 's1',
        workspace: 'crucible',
        title: 'Provider quota adapters',
        asks: 'Where should the OpenAI API key come from?'
      })
    ).toEqual({
      title: 'Provider quota adapters · asks',
      body: 'Where should the OpenAI API key come from?'
    })
  })

  it('leaves a finished turn’s banner exactly as it was', () => {
    expect(
      bannerWords({ sessionId: 's1', workspace: 'crucible', title: 'Provider quota adapters' })
    ).toEqual({ title: 'crucible · finished', body: 'Provider quota adapters' })
  })

  it('records the choice, so every launch says which one it made', () => {
    const log = memorySink()

    selectNeedsYouService('fake', {} as BrowserWindow, log.sink, () => {})

    expect(log.entries).toEqual([
      { source: 'main', event: 'needs_you_service_selected', service: 'quiet' }
    ])
  })
})
