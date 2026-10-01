import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  QuotedPrompt,
  ReadAgent,
  SourceQuote,
  WorkflowReading,
  WorkflowSourceFile
} from '../../shared/workflows/catalog'

// What a reader is shown of a workflow: its file and every local file it
// imports, followed as far as they go. The same set is what a reading is
// keyed by, so an edit to a helper the workflow imports rereads it too.

/** Past this many files the set is a library, not a workflow's own code. */
const MOST_FILES = 25

/** Past this a file is not something to put in front of a reader. */
const LARGEST_FILE = 256 * 1024

const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
]

const EXTENSIONS = ['', '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']

export type ReadText = (path: string) => Promise<string>

const readText: ReadText = (path) => readFile(path, 'utf8')

/** The workflow file first, then what it imports, in the order they were found. */
export async function workflowSources(
  workflowPath: string,
  read: ReadText = readText
): Promise<readonly WorkflowSourceFile[]> {
  const folder = dirname(workflowPath)
  const files: WorkflowSourceFile[] = []
  const seen = new Set<string>()
  const pending = [workflowPath]
  while (pending.length > 0 && files.length < MOST_FILES) {
    const path = pending.shift() as string
    if (seen.has(path)) continue
    seen.add(path)
    const text = await read(path)
    if (text.length > LARGEST_FILE) {
      if (path === workflowPath) throw new Error(`${path} is too large to read.`)
      continue
    }
    files.push({ path, label: labelOf(folder, path), text })
    for (const specifier of localSpecifiers(text)) {
      const found = await firstReadable(resolve(dirname(path), specifier), read)
      if (found !== undefined && !seen.has(found)) pending.push(found)
    }
  }
  return files
}

/** One hash over the whole set, names and bytes: what "the same files" means. */
export function sourcesHash(files: readonly WorkflowSourceFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.label).update('\0').update(file.text).update('\0')
  return hash.digest('hex')
}

function localSpecifiers(text: string): readonly string[] {
  const found = new Set<string>()
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier.startsWith('./') || specifier.startsWith('../')) found.add(specifier)
    }
  }
  return [...found]
}

async function firstReadable(base: string, read: ReadText): Promise<string | undefined> {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`
    try {
      await read(candidate)
      return candidate
    } catch {
      // Not this spelling; try the next.
    }
  }
  return undefined
}

// A reading's quotes name absolute paths so a page can link to the line, but
// the reading itself is of bytes, not of a place: the same source set at two
// paths is one reading. So it is kept with every quote naming its file by
// label, as the reader was shown it, and rooted again in whichever workflow
// file it is shown for.

/** The reading with every quote naming its file by label, relative to the workflow's folder. */
export function detachedReading(reading: WorkflowReading, workflowPath: string): WorkflowReading {
  const folder = dirname(workflowPath)
  return quotesMoved(reading, (file) => labelOf(folder, file))
}

/** The reading with every quote naming its file where it lies beside this workflow file. */
export function rootedReading(reading: WorkflowReading, workflowPath: string): WorkflowReading {
  const folder = dirname(workflowPath)
  return quotesMoved(reading, (label) => resolve(folder, label))
}

function quotesMoved(reading: WorkflowReading, move: (file: string) => string): WorkflowReading {
  const quote = <Q extends SourceQuote>(cited: Q): Q => ({ ...cited, file: move(cited.file) })
  const agents = reading.agents.map((agent): ReadAgent => {
    const { model, system, prompt, ...rest } = agent
    return {
      ...rest,
      ...(model === undefined ? {} : { model: { ...model, quote: quote(model.quote) } }),
      ...(system === undefined ? {} : { system: quote<QuotedPrompt>(system) }),
      ...(prompt === undefined ? {} : { prompt: quote<QuotedPrompt>(prompt) })
    }
  })
  return { ...reading, agents }
}

function labelOf(folder: string, path: string): string {
  const named = relative(folder, path)
  return named === '' || isAbsolute(named) ? join(path) : named
}
