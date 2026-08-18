import type { WebContents } from 'electron'
import type { LogSink } from './sink'

/**
 * The renderer's half of the one chronological stream (D9).
 *
 * Main is the sole writer of the run log, so the renderer writes nothing: what
 * it says on its console and any failure loading its preload are forwarded over
 * Electron's own documented hooks and appended here, with `source: 'renderer'`,
 * by the same sink that holds main's records. That is what makes "one
 * chronological stream" an ordering claim at all — one writer, one sequence.
 *
 * Everything the renderer says is forwarded, at all four levels (`debug`,
 * `info`, `warning`, `error`), unfiltered and unformatted; an uncaught exception
 * or an unhandled rejection reaches the console like anything else and takes
 * this same path, so there is no second channel for them. Nothing is prevented
 * or consumed, so DevTools shows exactly what it showed before.
 *
 * The forwarding lives as long as the `webContents` it is attached to, which is
 * a window's lifetime; there is nothing to dispose, so nothing is returned.
 */
export function forwardRendererOutput(webContents: WebContents, log: LogSink): void {
  webContents.on('console-message', (details) => {
    log.append({
      source: 'renderer',
      event: 'console',
      level: details.level,
      message: details.message,
      // Where in the renderer it was said — the whole of what Electron offers
      // to locate a line, and what makes a forwarded record diagnosable rather
      // than merely present.
      sourceId: details.sourceId,
      lineNumber: details.lineNumber
    })
  })

  webContents.on('preload-error', (_electronEvent, preloadPath, error) => {
    // A preload that fails takes `window.crucible` with it, so the renderer can
    // reach nothing agent-side and says so only as a downstream symptom. The
    // cause is this record, stack and all (D9).
    log.append({
      source: 'renderer',
      event: 'preload_error',
      preloadPath,
      message: error.message,
      stack: error.stack
    })
  })
}
