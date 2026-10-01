import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkflowReading } from '../../shared/workflows/catalog'
import {
  readCatalogReaderSettings,
  type CatalogReaderSettings
} from '../../shared/workflows/catalog-settings'

// The catalog's own file under Crucible's state directory: the reader setting,
// every reading a reader made, and which of them is each workflow file's last
// good one. Readings are what a model was paid for, so they outlive the
// launch; a failure is not kept, which is what makes the next launch try again.
//
// A reading is the work of one reader on one source set, so that pair, the
// set's hash, is what it is kept by: the same bytes at two paths, as two
// worktrees of one repository hold them, are one reading, paid for once and
// shown in both. Its quotes name their files by label, relative to the
// workflow's folder, so it belongs to no one path; the catalog roots it in
// whichever file it is shown for. What is kept by path is only the pointer
// from a file to the reading of its last good bytes, which a failure or a
// reading in flight shows beside itself.

export interface CatalogStore {
  /** Settles once the file has been read, or found absent. */
  readonly ready: Promise<void>
  reader(): CatalogReaderSettings
  setReader(settings: CatalogReaderSettings): void
  /** The reading one reader made of the source set with this hash; its quotes name files by label. */
  reading(reader: string, hash: string): WorkflowReading | undefined
  /** The hash of the last source set of this file the reader read well. */
  lastRead(path: string, reader: string): string | undefined
  /** A reading landed: it is kept, and it is the last good one of every file named. */
  keep(reader: string, hash: string, reading: WorkflowReading, paths: readonly string[]): void
  /** The file holds a source set the reader has already read well, so that reading is its last good one. */
  holds(path: string, reader: string, hash: string): void
}

interface Stored {
  readonly version: 2
  readonly reader: CatalogReaderSettings
  readonly readings: readonly {
    readonly reader: string
    readonly hash: string
    readonly reading: WorkflowReading
  }[]
  readonly files: readonly {
    readonly path: string
    readonly reader: string
    readonly hash: string
  }[]
}

/** Writes coalesce: a burst of readings landing together is one write. */
const WRITE_MS = 250

/** The readings and the pointers to them, in memory: what both stores are over. */
interface Index {
  reading(reader: string, hash: string): WorkflowReading | undefined
  lastRead(path: string, reader: string): string | undefined
  keep(reader: string, hash: string, reading: WorkflowReading, paths: readonly string[]): void
  holds(path: string, reader: string, hash: string): boolean
  stored(reader: CatalogReaderSettings): Stored
  load(stored: Partial<Stored>): void
}

const slot = (first: string, second: string): string => `${first}\n${second}`

function createIndex(): Index {
  // By reader and hash.
  const readings = new Map<string, { reader: string; hash: string; reading: WorkflowReading }>()
  // By reader and path: the hash of that file's last good reading.
  const files = new Map<string, { path: string; reader: string; hash: string }>()

  // A reading no file points at any more is one nothing will show again,
  // so it goes rather than growing the file with every edit ever read.
  function prune(): void {
    const wanted = new Set([...files.values()].map((file) => slot(file.reader, file.hash)))
    for (const at of readings.keys()) if (!wanted.has(at)) readings.delete(at)
  }

  function point(path: string, reader: string, hash: string): boolean {
    if (files.get(slot(reader, path))?.hash === hash) return false
    files.set(slot(reader, path), { path, reader, hash })
    return true
  }

  return {
    reading: (reader, hash) => readings.get(slot(reader, hash))?.reading,
    lastRead: (path, reader) => files.get(slot(reader, path))?.hash,
    keep(reader, hash, reading, paths) {
      readings.set(slot(reader, hash), { reader, hash, reading })
      for (const path of paths) point(path, reader, hash)
      prune()
    },
    holds(path, reader, hash) {
      if (!readings.has(slot(reader, hash)) || !point(path, reader, hash)) return false
      prune()
      return true
    },
    stored: (reader) => ({ version: 2, reader, readings: [...readings.values()], files: [...files.values()] }),
    load(stored) {
      // A file from an older or broken build is read past rather than trusted.
      if (stored.version !== 2) return
      for (const entry of Array.isArray(stored.readings) ? stored.readings : []) {
        if (typeof entry?.reader !== 'string' || typeof entry.hash !== 'string') continue
        if (typeof entry.reading !== 'object' || entry.reading === null) continue
        readings.set(slot(entry.reader, entry.hash), entry)
      }
      for (const entry of Array.isArray(stored.files) ? stored.files : []) {
        if (typeof entry?.path !== 'string' || typeof entry.reader !== 'string') continue
        if (typeof entry.hash !== 'string') continue
        files.set(slot(entry.reader, entry.path), entry)
      }
      prune()
    }
  }
}

export function createCatalogStore(file: string, onFailure: (cause: unknown) => void): CatalogStore {
  let reader = readCatalogReaderSettings(undefined)
  const index = createIndex()
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> = Promise.resolve()

  // Off the loop like every other read here.
  const ready = readFile(file, 'utf8')
    .then((text) => {
      const stored = JSON.parse(text) as Partial<Stored>
      reader = readCatalogReaderSettings(stored.reader)
      index.load(stored)
    })
    .catch(() => {})

  function persist(): void {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      const body = JSON.stringify(index.stored(reader))
      // One write at a time, each to a temporary file renamed over the real
      // one, so a quit mid-write never leaves half a file to read next launch.
      writing = writing.then(async () => {
        try {
          await mkdir(dirname(file), { recursive: true })
          await writeFile(`${file}.tmp`, body, 'utf8')
          await rename(`${file}.tmp`, file)
        } catch (cause) {
          onFailure(cause)
        }
      })
    }, WRITE_MS)
  }

  return {
    ready,
    reader: () => reader,
    setReader(settings) {
      reader = readCatalogReaderSettings(settings)
      persist()
    },
    reading: index.reading,
    lastRead: index.lastRead,
    keep(by, hash, reading, paths) {
      index.keep(by, hash, reading, paths)
      persist()
    },
    holds(path, by, hash) {
      if (index.holds(path, by, hash)) persist()
    }
  }
}

/** The same shape over memory alone: what a test, and nothing else, holds. */
export function memoryCatalogStore(reader?: CatalogReaderSettings): CatalogStore {
  let current = readCatalogReaderSettings(reader)
  const index = createIndex()
  return {
    ready: Promise.resolve(),
    reader: () => current,
    setReader(settings) {
      current = readCatalogReaderSettings(settings)
    },
    reading: index.reading,
    lastRead: index.lastRead,
    keep: index.keep,
    holds(path, by, hash) {
      index.holds(path, by, hash)
    }
  }
}
