import { useEffect, useRef, useState } from 'react'
import type { AgentPort, SessionId, TabId } from '../../../shared/agent/port'

// One read of one exhibit's text, for every view built on it: the rendered
// markdown, the source view, and the line count the header states. Read
// through the port and never off the disk.

export type ExhibitBody =
  | { readonly kind: 'body'; readonly text: string }
  | { readonly kind: 'failure'; readonly message: string }

/** What to read: the tab, and which mount and refresh the answer belongs to. */
export interface ExhibitRead {
  readonly sessionId: SessionId
  readonly tabId: TabId
  /** The mount this read belongs to; a change means a different body. */
  readonly of: string
  /** The refresh count, so the newest answer wins however they land. */
  readonly at: number
}

interface Landed {
  readonly of: string
  readonly at: number
  readonly answer: ExhibitBody
}

/**
 * The body for `read`, or nothing until the first answer lands. Nothing of
 * another tab is ever shown under this one's title, and the body already on
 * screen stays until a newer answer arrives: a refresh replaces content, it
 * never blanks the view first.
 */
export function useExhibitBody(port: AgentPort, read: ExhibitRead | undefined): ExhibitBody | undefined {
  const [held, setHeld] = useState<Landed | undefined>(undefined)

  const of = read?.of
  const showing = useRef(of)
  useEffect(() => {
    showing.current = of
  }, [of])

  const sessionId = read?.sessionId
  const tabId = read?.tabId
  const at = read?.at ?? 0
  useEffect(() => {
    if (of === undefined || sessionId === undefined || tabId === undefined) return
    void port
      .exhibit(sessionId, tabId)
      .then(({ body }) => {
        if (showing.current === of) setHeld(newest({ of, at, answer: { kind: 'body', text: body } }))
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (showing.current === of) {
          setHeld(newest({ of, at, answer: { kind: 'failure', message } }))
        }
      })
  }, [port, sessionId, tabId, of, at])

  return held !== undefined && held.of === of ? held.answer : undefined
}

// Two ⟳ clicks put two reads of one file in flight, and the older one may land
// last. The newest read that has come back wins, never the last to arrive.
function newest(landed: Landed): (held: Landed | undefined) => Landed {
  return (held) =>
    held !== undefined && held.of === landed.of && held.at > landed.at ? held : landed
}
