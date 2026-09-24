import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The two settings a judged rule needs, both Crucible's and neither the
// repository's: a repository can declare a rule, but it cannot hand itself a
// credential or decide on the user's behalf that its code may leave the
// machine. Both are read afresh whenever they are needed, so an edit takes
// effect at the next judged item without a restart.

/** `~/.crucible`, where the user's own Crucible settings live. */
export function crucibleHome(home: string): string {
  return join(home, '.crucible')
}

/** The judge credential: `TYPESAFE_API_KEY=...` in `~/.crucible/typesafe.env`. */
export function judgeCredentialPath(home: string): string {
  return join(crucibleHome(home), 'typesafe.env')
}

/** Which judges each workspace may send code to: `~/.crucible/judges.json`. */
export function allowedJudgesPath(home: string): string {
  return join(crucibleHome(home), 'judges.json')
}

/** The key, or absent when the file is missing or names none. */
export function readJudgeCredential(home: string): string | undefined {
  let text: string
  try {
    text = readFileSync(judgeCredentialPath(home), 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    const value = match[1]!.replace(/^(['"])(.*)\1$/, '$2')
    if (value !== '') return value
  }
  return undefined
}

/**
 * The judges one workspace allows, keyed by the workspace's path:
 * `{ "/Users/me/repos/app": ["jev-1.13.0"] }`. A workspace the file does not
 * name allows none, and a file that cannot be read allows nothing anywhere.
 */
export function readAllowedJudges(home: string, workspacePath: string): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(allowedJudgesPath(home), 'utf8')) as Record<string, unknown>
    const listed = parsed[workspacePath]
    return Array.isArray(listed) ? listed.filter((model): model is string => typeof model === 'string') : []
  } catch {
    return []
  }
}
