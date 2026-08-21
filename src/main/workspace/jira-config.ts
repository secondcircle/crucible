import {
  JIRA_API_TOKEN,
  JIRA_BASE_URL,
  JIRA_CREDENTIAL_KEYS,
  JIRA_EMAIL,
  JIRA_POINTER_FILE,
  missingPiece
} from '../../shared/workspace/jira-setup'
import type { MissingPiece } from '../../shared/workspace/service'

// Jira's configuration is two files in the workspace and nothing else: the
// credentials in `.env.local`, the project pointer in `.crucible/jira.json`.
// Everything here is a pure function of those files' text, so every branch is
// checkable without a disk.
//
// The OS environment is never consulted. A Dock-launched app inherits no shell,
// so a variable exported in a terminal would work in dev and be missing in the
// installed app — the one failure mode worth designing out.

export interface JiraConfig {
  /** No trailing slash: every request appends its own path. */
  readonly baseUrl: string
  readonly email: string
  readonly token: string
  readonly projectKey: string
}

export type JiraSetup =
  | { readonly kind: 'ready'; readonly config: JiraConfig }
  // Every missing piece at once: a person fixing this wants the whole list, not
  // one round trip per key.
  | { readonly kind: 'incomplete'; readonly missing: readonly MissingPiece[] }

/**
 * dotenv-minimal: `KEY=VALUE` lines, blank lines and `#` comments ignored, the
 * value being everything after the first `=`, trimmed. No quote stripping, no
 * interpolation, no `export` — a fuller dialect would be a second contract to
 * keep, and the file this reads is one a person copies by hand.
 */
export function parseEnvFile(text: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const split = trimmed.indexOf('=')
    if (split <= 0) continue
    const key = trimmed.slice(0, split).trim()
    if (key === '') continue
    // A later line wins, which is how a person overriding by appending expects
    // it to read.
    values[key] = trimmed.slice(split + 1).trim()
  }
  return values
}

/**
 * The site to send requests to, with any trailing slash gone, or `undefined`
 * where the value cannot form a request. A hostname with the scheme dropped
 * (`secondcircle.atlassian.net`) is what a person copying the site out of a
 * browser writes, and it is not a URL: it has to be caught here, where the
 * board can say which key to fix, rather than at the first request.
 */
export function parseJiraBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  // `mailto:ike@example.com` parses, so the scheme is checked too: a Jira site
  // answers on http or https and nothing else.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  if (parsed.hostname === '') return undefined
  return trimmed
}

/** The project key the pointer names, or `undefined` where it names none. */
export function parseJiraPointer(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Unreadable is the same as absent to the person fixing it: the pointer
    // still has to be written.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  // Unknown fields are ignored, so a board id can join this file later without
  // a format break.
  const key = (parsed as Record<string, unknown>)['projectKey']
  if (typeof key !== 'string' || key.trim() === '') return undefined
  return key.trim()
}

/** True where the file names any of the three keys, however incomplete. */
export function hasJiraCredentialKey(envText: string | undefined): boolean {
  if (envText === undefined) return false
  const values = parseEnvFile(envText)
  return JIRA_CREDENTIAL_KEYS.some((key) => key in values)
}

/**
 * The two files together, read as one answer: a usable configuration or the
 * list of what is not there yet.
 */
export function readJiraSetup(files: {
  readonly pointer?: string
  readonly env?: string
}): JiraSetup {
  const values = files.env === undefined ? {} : parseEnvFile(files.env)
  const projectKey = parseJiraPointer(files.pointer)
  const baseUrl = parseJiraBaseUrl(values[JIRA_BASE_URL])

  const missing: MissingPiece[] = []
  for (const key of JIRA_CREDENTIAL_KEYS) {
    const value = values[key]
    if (value === undefined || value === '') {
      missing.push(missingPiece(key))
      continue
    }
    // A base URL that cannot form a request is as unusable as one that is not
    // there, so it is listed the same way, exactly as an unparseable pointer
    // file counts as a missing pointer. The sentence beside it shows the shape,
    // scheme and all, which is the part a bad value is usually missing.
    if (key === JIRA_BASE_URL && baseUrl === undefined) missing.push(missingPiece(key))
  }
  // The pointer is listed last: a person reading this fixes the file they can
  // commit after the ones they cannot.
  if (projectKey === undefined) missing.push(missingPiece(JIRA_POINTER_FILE))
  if (missing.length > 0) return { kind: 'incomplete', missing }

  return {
    kind: 'ready',
    config: {
      // Usable by here: an absent or unparseable one was listed above.
      baseUrl: baseUrl as string,
      email: values[JIRA_EMAIL] ?? '',
      token: values[JIRA_API_TOKEN] ?? '',
      projectKey: projectKey as string
    }
  }
}

export type IssueHostChoice = 'none' | 'github' | 'jira'

/**
 * Which host this workspace's issues come from. Explicit configuration beats
 * remote inference: a repository with a pointer file is a Jira repository even
 * where its remote is GitHub.
 */
export function chooseIssueHost(facts: {
  readonly repository: boolean
  readonly jiraPointer: boolean
  readonly githubRemote: boolean
  /** Any of the three keys in `.env.local`, complete or not. */
  readonly jiraCredential: boolean
}): IssueHostChoice {
  if (!facts.repository) return 'none'
  if (facts.jiraPointer) return 'jira'
  if (facts.githubRemote) return 'github'
  // Keys but no pointer: Jira was intended here, and the board says what is
  // still missing rather than going dark.
  if (facts.jiraCredential) return 'jira'
  return 'none'
}
