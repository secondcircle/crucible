import { createRequire } from 'node:module'
import { extname } from 'node:path'
import { Language, Parser, Query, type Tree } from 'web-tree-sitter'

const require = createRequire(import.meta.url)
const grammarDir = require.resolve('tree-sitter-wasms/package.json').replace(/package\.json$/, 'out/')

const byExtension: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.go': 'go',
  '.py': 'python',
}

let ready: Promise<void> | undefined
const languages = new Map<string, Promise<Language>>()

export function languageFor(path: string): string | undefined {
  return byExtension[extname(path)]
}

async function language(name: string): Promise<Language> {
  ready ??= Parser.init()
  await ready
  let lang = languages.get(name)
  if (!lang) {
    lang = Language.load(`${grammarDir}tree-sitter-${name}.wasm`)
    languages.set(name, lang)
  }
  return lang
}

const parsers = new Map<string, Parser>()
const queries = new Map<string, Query>()

export interface Parsed {
  tree: Tree
  lang: Language
  /** Compiled once per language and source, and kept. */
  query(source: string): Query
}

/**
 * Parse, hand the tree to `use`, and free it: web-tree-sitter trees live in wasm memory
 * and are never collected, so a survey over thousands of files runs out without this.
 */
export async function withTree<T>(path: string, text: string, use: (p: Parsed) => T): Promise<T | undefined> {
  const name = languageFor(path)
  if (!name) return undefined
  const lang = await language(name)
  let parser = parsers.get(name)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(lang)
    parsers.set(name, parser)
  }
  const tree = parser.parse(text)
  if (!tree) return undefined
  try {
    return use({
      tree,
      lang,
      query: (source) => {
        const key = `${name}\0${source}`
        let q = queries.get(key)
        if (!q) {
          q = new Query(lang, source)
          queries.set(key, q)
        }
        return q
      },
    })
  } finally {
    tree.delete()
  }
}
