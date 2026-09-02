import { platformFact } from './bridge'

// One module owns both halves of a keyboard chord: whether an event *is* this
// platform's chord, and how that chord is spelled on screen. They live
// together so a Windows machine can never be told `⌘I` and then refuse Ctrl+I.
//
// The platform's own modifier is the chord — ⌘ on a Mac, Ctrl everywhere else
// — rather than both accepted everywhere. A Mac that answered to Ctrl+R was
// answering to a chord no Mac app uses.

export type KeyPlatform = 'mac' | 'other'

// Read once, and here alone: the preload exposes the OS main is running on,
// and no component asks a second time.
let platform: KeyPlatform | undefined

/**
 * Declares which platform this window is on, by any name it goes by. A
 * component test has no OS and says which one it is pretending to be; the
 * running app never calls this, because the line below already knows.
 */
export function runningOn(name: string): void {
  platform = /darwin|mac/i.test(name) ? 'mac' : 'other'
}

export function keyPlatform(): KeyPlatform {
  // The navigator is the fallback for a window without the preload, which in
  // the running app there is not.
  if (platform === undefined) runningOn(platformFact() ?? navigator.userAgent)
  return platform ?? 'other'
}

/** What a modifier check needs, so a synthetic event is as good as a real one. */
export interface Modifiers {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}

/**
 * Whether this event carries this platform's chord modifier — and only it. A
 * chord is one key's job: on a Mac ⌘ alone, elsewhere Ctrl alone.
 */
export function chordPressed(pressed: Modifiers): boolean {
  return keyPlatform() === 'mac'
    ? pressed.metaKey && !pressed.ctrlKey
    : pressed.ctrlKey && !pressed.metaKey
}

/**
 * A key hint as this platform spells it: `⌘I` on a Mac, `Ctrl+I` elsewhere,
 * `⌥⏎` and `Alt+⏎`. Glyphs that name no modifier — `⏎`, `esc`, `↑` — are the
 * same key on every keyboard and are left exactly as they are.
 */
export function keyLabel(macChord: string): string {
  if (keyPlatform() === 'mac') return macChord
  return macChord.replaceAll('⌘', 'Ctrl+').replaceAll('⌥', 'Alt+')
}
