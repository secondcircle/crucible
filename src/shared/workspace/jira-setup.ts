import type { MissingPiece } from './service'

// The names and homes of Jira's configuration, in one place: the collector that
// finds a piece missing and the canned board that pretends to name the same
// words. Nothing here reads a file or holds a credential; it is vocabulary.

/** Committable, and never holds the token. */
export const JIRA_POINTER_FILE = '.crucible/jira.json'

/** The only credential source, and the file that must be gitignored. */
export const JIRA_ENV_FILE = '.env.local'

export const JIRA_BASE_URL = 'JIRA_BASE_URL'
export const JIRA_EMAIL = 'JIRA_EMAIL'
export const JIRA_API_TOKEN = 'JIRA_API_TOKEN'

/** Every credential key, in the order the not-configured state lists them. */
export const JIRA_CREDENTIAL_KEYS: readonly string[] = [JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN]

// One sentence each, naming the file the piece belongs in, because the board
// shows exactly these words and nothing else explains them.
const WHERE: Readonly<Record<string, string>> = {
  [JIRA_BASE_URL]: `Your Jira site, like https://your-team.atlassian.net. A KEY=VALUE line in ${JIRA_ENV_FILE} at the workspace root.`,
  [JIRA_EMAIL]: `The Atlassian account the API token belongs to. A KEY=VALUE line in ${JIRA_ENV_FILE} at the workspace root.`,
  [JIRA_API_TOKEN]: `An Atlassian API token from id.atlassian.com. A KEY=VALUE line in ${JIRA_ENV_FILE} at the workspace root, which must be gitignored before the token goes into it.`,
  [JIRA_POINTER_FILE]: `Names the project this repository tracks: {"projectKey": "EK"}. Committable, and it never holds the token.`
}

/** The named piece, with the sentence that says where it goes. */
export function missingPiece(name: string): MissingPiece {
  return { name, where: WHERE[name] ?? '' }
}
