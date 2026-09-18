import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FileView } from '../../../shared/agent/port'
import type { WorkspaceService } from '../../../shared/workspace/service'
import { namedPath, type NamedPath } from './named-path'

// Whether a path an agent named is a file, and what a click on one does. A
// path is text until the disk has answered for it, so nothing an agent writes
// becomes a control on its own say-so.
//
// The answers are held by directory and path together: the same relative path
// names another file in another worktree, and a session switch must not
// inherit the answer given for the session before it.
//
// And they are held only until the disk may have moved. "Is this a file" is
// not a fact about a path, it is a fact about the directory right now, and the
// agent under this very transcript writes and deletes files as its ordinary
// work: it says it will write `notes/plan.md`, writes it, and says it wrote
// it. An answer that outlived the write would leave the second mention dead
// text for the life of the window, and an answer that outlived a delete would
// leave a chip whose click fails. So every change under the directory retires
// the lot.
//
// "May have moved" rather than "moved", because the watch follows the session
// on screen and the user reads another session while this one works. What the
// answers are held against is therefore an epoch that only ever goes forward:
// it counts the changes the watcher saw and every watch that ended, since a
// directory nobody was watching can have moved without anyone counting it. A
// number that could return to a value it already had could not say that, and
// answers taken under it would come back after a switch away and back.
//
// What the watch reaches is what main's watcher watches: the session's
// directory, which is where the agent's own writes land. An absolute path
// somewhere else on disk — an installed document, another checkout — has no
// watcher of its own and is retired along with the rest whenever the epoch
// moves. Watching every folder an agent can name is the alternative, and it is
// not worth a case nobody has hit.

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
  epoch,
  open,
  keep
}: {
  readonly service: WorkspaceService
  // The session's working directory, worktree included. Without one there is
  // nothing to resolve a relative path against, so nothing is clickable.
  readonly directory: string | undefined
  // When the answers are being taken: a number that goes up whenever the disk
  // under the watch may have moved, which is every change the watcher
  // announces and every end of the watch itself. Every increment retires the
  // answers taken before it. The caller owes a watch that runs while chat is
  // being read, not only while the file tree is, and a number that never goes
  // back — `useWatchedFiles` gives both.
  readonly epoch: number
  readonly open: (target: ClickTarget) => void
  readonly keep: (target: ClickTarget) => void
}): PathLinks {
  // State rather than a cache off to the side: an answer landing is what makes
  // this hook's value a new one, and a path already drawn is drawn again
  // with the answer in hand.
  const [answers, setAnswers] = useState<ReadonlyMap<string, boolean>>(new Map())
  const waiting = useRef(new Set<string>())
  const scheduled = useRef(false)
  // When the answers were taken. The directory is no part of this: which disk
  // an answer is about lives in its key, and this says only how long ago it
  // was asked. Mixing the two would make a stamp that can come back — a count
  // of changes stands still for a directory nobody is watching, so the pair
  // remade after a session switch is the pair the stale answers were taken
  // under, and a stamp that comes back hands those answers back.
  const stamp = String(epoch)
  // What has been asked since that stamp. Retiring this rather than `answers`
  // is what keeps a chip from blinking back to text while it is asked again:
  // the old answer stays on screen for the one round trip the new one takes,
  // and every path a message names asks in that same round trip.
  const asked = useRef<{ stamp: string; keys: Set<string> }>({ stamp, keys: new Set() })

  return useMemo(() => {
    const keyed = (path: string): string => `${directory ?? ''}\n${path}`

    function land(at: string, paths: readonly string[], files: ReadonlySet<string>): void {
      // Taken from a disk that has since moved, and already asked again: what
      // this says about those paths is no longer about anything.
      if (asked.current.stamp !== at) return
      setAnswers((before) => {
        // The map is replaced only where an answer actually changed: a write
        // somewhere else under the directory retires every answer, and most of
        // them come back the same.
        let after: Map<string, boolean> | undefined
        for (const path of paths) {
          const key = keyed(path)
          const value = files.has(path)
          if (before.get(key) === value) continue
          after ??= new Map(before)
          after.set(key, value)
        }
        return after ?? before
      })
    }

    function flush(): void {
      scheduled.current = false
      if (directory === undefined) return
      const asking = [...waiting.current]
      waiting.current.clear()
      if (asking.length === 0) return
      const at = asked.current.stamp
      void service
        .existingFiles(directory, asking)
        .then((found) => land(at, asking, new Set(found)))
        // A folder that could not be read answers for none of them: they stay
        // text, which is what they were.
        .catch(() => land(at, asking, new Set()))
    }

    return {
      opens: (path) => directory !== undefined && answers.get(keyed(path)) === true,
      check(path) {
        if (directory === undefined) return
        // The first ask since the disk moved retires every answer taken from
        // the disk before it. Here rather than during render because this runs
        // from an effect, and every path on screen runs it: a path asks again
        // the moment it is drawn against a disk that has changed.
        if (asked.current.stamp !== stamp) asked.current = { stamp, keys: new Set() }
        const key = keyed(path)
        if (asked.current.keys.has(key)) return
        // Recorded when it is asked rather than when it answers, so the same
        // path drawn in ten messages costs one stat and a re-render lands in
        // no second one.
        asked.current.keys.add(key)
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
    // `stamp` belongs here as much as `answers` does: a new value is a new
    // hook value, which is how every path on screen is told to ask again.
  }, [service, directory, stamp, open, keep, answers])
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
