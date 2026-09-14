import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FileView } from '../../../shared/agent/port'
import type { WorkspaceService } from '../../../shared/workspace/service'
import { namedPath, type NamedPath } from './named-path'

// Whether a path an agent named is a file, and what a click on one does. A
// path is text until the disk has answered for it, so nothing an agent writes
// becomes a control on its own say-so.
//
// The answers are cached by directory and path together: the same relative
// path names another file in another worktree, and a session switch must not
// inherit the answer given for the session before it.

// What one click opens in the context panel: a file, in the view the click
// asked for, or a local address. The file tree and a message both click, and
// they differ in nothing but the view.
export type ClickTarget =
  | { readonly kind: 'file'; readonly path: string; readonly view: FileView }
  | { readonly kind: 'address'; readonly address: string }

/** What a click named, for matching the double-click that may follow it. */
export function targetKey(target: ClickTarget): string {
  return target.kind === 'file' ? target.path : target.address
}

export interface PathLinks {
  /** True once the disk has answered that this path is a file. */
  opens(path: string): boolean
  /** Asks the disk about a path. A path already asked about costs nothing. */
  check(path: string): void
  /** The single click: the session's preview tab. */
  open(target: ClickTarget): void
  /** The second press of a double-click: keep the tab the click opened. */
  keep(target: ClickTarget): void
}

// Nothing is a link where no session's chat is being read: an exhibit's
// markdown, an issue's body, a run node's transcript.
const NONE: PathLinks = {
  opens: () => false,
  check: () => {},
  open: () => {},
  keep: () => {}
}

export const PathLinksContext = createContext<PathLinks>(NONE)

export function usePathLinks({
  service,
  directory,
  open,
  keep
}: {
  readonly service: WorkspaceService
  // The session's working directory, worktree included. Without one there is
  // nothing to resolve a relative path against, so nothing is clickable.
  readonly directory: string | undefined
  readonly open: (target: ClickTarget) => void
  readonly keep: (target: ClickTarget) => void
}): PathLinks {
  // State rather than a cache off to the side: an answer landing is what makes
  // this hook's value a new one, and a path already drawn is drawn again
  // with the answer in hand.
  const [answers, setAnswers] = useState<ReadonlyMap<string, boolean>>(new Map())
  const waiting = useRef(new Set<string>())
  const scheduled = useRef(false)

  return useMemo(() => {
    const keyed = (path: string): string => `${directory ?? ''}\n${path}`

    function land(asked: readonly string[], files: ReadonlySet<string>): void {
      setAnswers((before) => {
        const after = new Map(before)
        for (const path of asked) after.set(keyed(path), files.has(path))
        return after
      })
    }

    function flush(): void {
      scheduled.current = false
      if (directory === undefined) return
      const asked = [...waiting.current]
      waiting.current.clear()
      if (asked.length === 0) return
      void service
        .existingFiles(directory, asked)
        .then((found) => land(asked, new Set(found)))
        // A folder that could not be read answers for none of them: they stay
        // text, which is what they were.
        .catch(() => land(asked, new Set()))
    }

    return {
      opens: (path) => directory !== undefined && answers.get(keyed(path)) === true,
      check(path) {
        if (directory === undefined) return
        if (answers.has(keyed(path)) || waiting.current.has(path)) return
        // One message names a dozen paths, and every one of them asks in the
        // same commit: they cross together, rather than one round trip each.
        waiting.current.add(path)
        if (scheduled.current) return
        scheduled.current = true
        queueMicrotask(flush)
      },
      open,
      keep
    }
  }, [service, directory, open, keep, answers])
}

/**
 * The file this text names, once the disk has said it is one; nothing until
 * then, and nothing for text that could not be naming a file at all.
 */
export function useNamedPath(text: string): NamedPath | undefined {
  const links = useContext(PathLinksContext)
  const named = useMemo(() => namedPath(text), [text])
  const path = named?.path

  useEffect(() => {
    if (path !== undefined) links.check(path)
  }, [links, path])

  return path !== undefined && links.opens(path) ? named : undefined
}
