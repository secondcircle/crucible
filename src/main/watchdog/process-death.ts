import type { LogSink } from '../log/sink'

// The processes Crucible does not run itself: the renderer that draws the
// window, the GPU and utility children Chromium starts, and the guest
// webContents an exhibit renders in. When one of them dies the window goes
// black or a panel goes blank, and the app carries on as if nothing
// happened — so the run log is the only place the death could be recorded,
// and until this module nothing listened for it at all.
//
// Nothing here recovers anything. It records: what died, why Chromium says
// it died, and what it exited with, on the same log the stall watchdog
// writes to, so the two are read together in one order.

/** A webContents, as far as this needs to read one. */
export interface WatchedContents {
  getType(): string
  getURL(): string
  isDestroyed(): boolean
  on(event: 'unresponsive' | 'responsive', listener: () => void): void
}

/** Chromium's report of a renderer's death. */
export interface RenderGone {
  readonly reason: string
  readonly exitCode: number
}

/** Chromium's report of a child process's death: GPU, utility, zygote. */
export interface ChildGone {
  readonly type: string
  readonly reason: string
  readonly exitCode: number
  readonly serviceName?: string
  readonly name?: string
}

/** The little of Electron's `app` this watches, so a test can be the app. */
export interface ProcessDeathSource {
  on(
    event: 'render-process-gone',
    listener: (event: unknown, contents: WatchedContents, details: RenderGone) => void
  ): void
  on(event: 'child-process-gone', listener: (event: unknown, details: ChildGone) => void): void
  on(
    event: 'web-contents-created',
    listener: (event: unknown, contents: WatchedContents) => void
  ): void
}

/**
 * Subscribes for the life of the app: there is nothing to dispose, because
 * the app going away is what ends it.
 */
export function watchProcessDeath(app: ProcessDeathSource, log: LogSink): void {
  app.on('render-process-gone', (_event, contents, details) => {
    log.append({
      source: 'main',
      event: 'render_process_gone',
      reason: details.reason,
      exitCode: details.exitCode,
      // Which renderer: the window itself, or an exhibit's guest.
      contentsType: typeOf(contents),
      url: urlOf(contents)
    })
  })

  app.on('child-process-gone', (_event, details) => {
    log.append({
      source: 'main',
      event: 'child_process_gone',
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      ...(details.serviceName === undefined ? {} : { serviceName: details.serviceName }),
      ...(details.name === undefined ? {} : { name: details.name })
    })
  })

  // Every webContents, not only the window's: an exhibit guest that hangs
  // takes the panel with it and says nothing otherwise.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('unresponsive', () => {
      log.append({
        source: 'main',
        event: 'renderer_unresponsive',
        contentsType: typeOf(contents),
        url: urlOf(contents)
      })
    })
    contents.on('responsive', () => {
      log.append({
        source: 'main',
        event: 'renderer_responsive',
        contentsType: typeOf(contents),
        url: urlOf(contents)
      })
    })
  })
}

// A dead webContents answers neither question, and asking throws: a record
// that says nothing about which renderer it was still beats no record.
function typeOf(contents: WatchedContents): string {
  try {
    return contents.isDestroyed() ? 'destroyed' : contents.getType()
  } catch {
    return 'unknown'
  }
}

function urlOf(contents: WatchedContents): string {
  try {
    return contents.isDestroyed() ? '' : contents.getURL()
  } catch {
    return ''
  }
}
