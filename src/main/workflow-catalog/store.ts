import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkflowReading } from '../../shared/workflows/catalog'
import {
  readCatalogReaderSettings,
  type CatalogReaderSettings
} from '../../shared/workflows/catalog-settings'

// The catalog's own file under Crucible's state directory: the reader setting
// and the last good reading of each workflow file by each reader. Readings
// are what a model was paid for, so they outlive the launch; a failure is
// not kept, which is what makes the next launch try again.

/** A reading, and the key of the source set and reader it was made from. */
export interface KeptReading {
  readonly key: string
  readonly reading: WorkflowReading
}

export interface CatalogStore {
  /** Settles once the file has been read, or found absent. */
  readonly ready: Promise<void>
  reader(): CatalogReaderSettings
  setReader(settings: CatalogReaderSettings): void
  /** The last good reading of a file by one reader. */
  reading(path: string, reader: string): KeptReading | undefined
  keep(path: string, reader: string, kept: KeptReading): void
}

interface Stored {
  readonly version: 1
  readonly reader: CatalogReaderSettings
  readonly readings: readonly {
    readonly path: string
    readonly reader: string
    readonly key: string
    readonly reading: WorkflowReading
  }[]
}

/** Writes coalesce: a burst of readings landing together is one write. */
const WRITE_MS = 250

export function createCatalogStore(file: string, onFailure: (cause: unknown) => void): CatalogStore {
  let reader = readCatalogReaderSettings(undefined)
  const readings = new Map<string, KeptReading>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> = Promise.resolve()

  const slot = (path: string, by: string): string => `${by}\n${path}`

  // Off the loop like every other read here; a file from an older or broken
  // build is read past rather than trusted.
  const ready = readFile(file, 'utf8')
    .then((text) => {
      const stored = JSON.parse(text) as Partial<Stored>
      reader = readCatalogReaderSettings(stored.reader)
      for (const entry of Array.isArray(stored.readings) ? stored.readings : []) {
        if (typeof entry?.path !== 'string' || typeof entry.key !== 'string') continue
        if (typeof entry.reader !== 'string' || typeof entry.reading !== 'object') continue
        readings.set(slot(entry.path, entry.reader), { key: entry.key, reading: entry.reading })
      }
    })
    .catch(() => {})

  function persist(): void {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      const stored: Stored = {
        version: 1,
        reader,
        readings: [...readings.entries()].map(([at, kept]) => {
          const split = at.indexOf('\n')
          return { reader: at.slice(0, split), path: at.slice(split + 1), ...kept }
        })
      }
      const body = JSON.stringify(stored)
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
    reading: (path, by) => readings.get(slot(path, by)),
    keep(path, by, kept) {
      readings.set(slot(path, by), kept)
      persist()
    }
  }
}

/** The same shape over memory alone: what a test, and nothing else, holds. */
export function memoryCatalogStore(reader?: CatalogReaderSettings): CatalogStore {
  let current = readCatalogReaderSettings(reader)
  const readings = new Map<string, KeptReading>()
  return {
    ready: Promise.resolve(),
    reader: () => current,
    setReader(settings) {
      current = readCatalogReaderSettings(settings)
    },
    reading: (path, by) => readings.get(`${by}\n${path}`),
    keep(path, by, kept) {
      readings.set(`${by}\n${path}`, kept)
    }
  }
}
