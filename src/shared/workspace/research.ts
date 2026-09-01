// The research seam's vocabulary: what one reading of the research CLI found,
// and what a mutating call to it produced. Imports nothing, for the same reason
// `service.ts` imports nothing — both cross from main into the renderer.

declare const redacted: unique symbol

/**
 * Every field below that carries CLI output is one of these, so a path that
 * forgets to redact does not compile.
 */
export type Redacted = string & { readonly [redacted]: true }

/** What replaces anything key-shaped, wherever text is redacted. */
export const REDACTION = '[key redacted]'

// The CLI's keys are `fc-` and a run of key characters. Six is short enough to
// catch a masked preview (`fc-...dead`) and long enough not to eat prose.
const KEY_SHAPED = /fc-[A-Za-z0-9._-]{6,}/g

/**
 * The only way to make a `Redacted`. Shared rather than main's alone, because
 * the renderer mints one too, for a message of its own.
 */
export function redactKeys(text: string): Redacted {
  return text.replace(KEY_SHAPED, REDACTION) as Redacted
}

/** What one reading of the research CLI found. Never partially filled in. */
export type ResearchStatus =
  /** The binary did not start because nothing by that name is on PATH. */
  | { readonly kind: 'notInstalled' }
  /** Started, but nothing readable came back: a non-zero exit, a timeout,
      output nobody can parse, a spawn error that is not a missing binary. */
  | { readonly kind: 'unreadable'; readonly reason: Redacted }
  | { readonly kind: 'signedOut'; readonly version: Redacted }
  | {
      readonly kind: 'signedIn'
      readonly version: Redacted
      /** Absent where the CLI reported no figure. Never 0 as a stand-in. */
      readonly credits?: number
    }

/** A connect or a log-out: the status read after it, or why not. */
export type ResearchOutcome =
  | { readonly kind: 'settled'; readonly status: ResearchStatus }
  | { readonly kind: 'refused'; readonly message: Redacted }

/**
 * A connect attempt has a third ending: it was cancelled, or a second attempt
 * superseded it. Nobody is owed a message for one of these.
 */
export type ConnectOutcome = ResearchOutcome | { readonly kind: 'abandoned' }
