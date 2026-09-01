// Where the panel says an exhibit is. Pure, so the rule can be pinned without
// a browser: the row draws one string in two parts and copies the whole of it,
// and nothing here reads a file, resolves a path or asks the OS anything.

import type { PanelTab } from '../../../shared/agent/port'

/**
 * A location as the row draws it. `lead + tail` is the whole location, always:
 * the row shows a split of one string, never two strings that could disagree.
 */
export interface ShownLocation {
  /** What a copy writes, untruncated. */
  readonly whole: string
  /** Gives way first, and may be empty: the directory, or the origin. */
  readonly lead: string
  /** Stays: the filename, or everything from the pathname onward. */
  readonly tail: string
}

/**
 * Where the active tab's exhibit is. `navigated` is where a url guest has gone
 * in place since it mounted; a file tab ignores it, because its row names the
 * file that was read.
 */
export function shownLocation(tab: PanelTab, navigated?: string): ShownLocation {
  if (tab.kind === 'url') return webLocation(navigated ?? tab.address)
  return fileLocation(tab.path)
}

/** What the guest loads. A markdown tab has none: its body rides the port. */
export function guestSrc(tab: Extract<PanelTab, { readonly kind: 'html' | 'url' }>): string {
  if (tab.kind === 'url') return tab.address
  // Built by hand because the renderer has no node url module. Segments are
  // encoded so a space or a hash in a directory name survives the trip.
  return `file://${tab.path.split('/').map(encodeURIComponent).join('/')}`
}

// The directory keeps the separator it was cut at, so the tail is a bare
// filename and the two parts still concatenate to what a copy writes.
function fileLocation(path: string): ShownLocation {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut === -1) return { whole: path, lead: '', tail: path }
  return { whole: path, lead: path.slice(0, cut + 1), tail: path.slice(cut + 1) }
}

// The origin gives way; the pathname onward stays, query and hash with it. An
// address that will not parse, or that does not open with its own origin, is
// shown whole in the part that stays, so the row never hides a character of a
// location it cannot split.
function webLocation(address: string): ShownLocation {
  const origin = originOf(address)
  if (origin === undefined || !address.startsWith(origin)) {
    return { whole: address, lead: '', tail: address }
  }
  return { whole: address, lead: origin, tail: address.slice(origin.length) }
}

function originOf(address: string): string | undefined {
  try {
    const origin = new URL(address).origin
    // `null` is what a URL with no meaningful origin reports, and it is a
    // string that appears nowhere in the address.
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}
