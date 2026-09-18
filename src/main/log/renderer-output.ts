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
 *
 * ## `Uncaught Error: Invalid guestInstanceId: <n>`
 *
 * A line that shows up here, `sourceId: node:electron/js2c/isolated_bundle`,
 * once per session switch or context panel tab activation — 98 of them over
 * one six-day life of 0.1.22. It is Electron's own: the browser process throws
 * it from `guest-view-manager` when the renderer's `<webview>` implementation
 * calls a method or reads a property on a guest that has already been
 * detached, which is what unmounting the element does.
 *
 * It was chased on 09-17 because a leaked guest per switch would be a leaked
 * renderer process per switch, and the app had gone black. It is not a leak:
 * driven through 16 tab flips and 12 session switches, the debug port's target
 * list holds exactly one guest while an html exhibit is shown and none a second
 * after it stops being shown, and the DOM agrees (`Shell.panel.test.tsx` holds
 * that count). Crucible's own code touches a guest in one place, the panel's
 * refresh, and only while it is mounted.
 *
 * So: noise, and it is forwarded like everything else rather than filtered,
 * because a sink that hides lines is a sink nobody can trust. If it ever
 * arrives *with* a rising guest count behind it, that is a different bug and
 * the count is how you will know.
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
