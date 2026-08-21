import { classifyIssues, type IssueFacts } from '../../shared/workspace/classify-issues'
import { JIRA_ENV_FILE, JIRA_POINTER_FILE } from '../../shared/workspace/jira-setup'
import type { IssueBoardAnswer } from '../../shared/workspace/service'
import { isGitHubRemote, parseNameWithOwner } from './board-facts'
import type { CollectionClock, CommandOutcome, CommandRunner } from './collect-board'
import { collectJiraIssues } from './collect-jira-issues'
import { openIssuesQuery, parseIssueNumbers, parseIssues } from './issue-facts'
import type { JiraFetch } from './jira-client'
import { chooseIssueHost, hasJiraCredentialKey, readJiraSetup } from './jira-config'
import { readWorkspaceFile, type WorkspaceFileReader } from './workspace-files'

// Reads and nothing else: no issue is ever closed, assigned, labelled or
// commented from here, and no command below could grow into one.

/** A collection that cannot finish inside this fails rather than hanging. */
export const ISSUE_BUDGET_MS = 30_000

/** How long any single command may take. */
const COMMAND_MS = 15_000

// A human-sized board. A repository with more open issues than this shows its
// most recently updated hundred, which is the end of the list anyone reads.
export const ISSUE_LIMIT = 100

const NO_GH =
  'Crucible could not reach GitHub. Install the gh command line tool and sign in with `gh auth login`.'

export interface IssueSeams {
  /** The workspace's own files, injected so no test reads a disk. */
  readonly readFile?: WorkspaceFileReader
  /** The Jira transport, injected so no test opens a socket. */
  readonly fetchImpl?: JiraFetch
}

export async function collectIssues(
  runner: CommandRunner,
  workspacePath: string,
  clock: CollectionClock = { now: () => Date.now() },
  seams: IssueSeams = {}
): Promise<IssueBoardAnswer> {
  const started = clock.now()
  const readFile = seams.readFile ?? readWorkspaceFile

  function left(): number {
    return started + ISSUE_BUDGET_MS - clock.now()
  }

  async function run(command: string, ...args: readonly string[]): Promise<CommandOutcome> {
    const remaining = left()
    if (remaining <= 0) {
      return { ok: false, stdout: '', stderr: 'Reading this repository took too long.' }
    }
    return runner(command, args, {
      cwd: workspacePath,
      timeoutMs: Math.min(COMMAND_MS, remaining)
    })
  }

  const repository = await run('git', 'rev-parse', '--show-toplevel')
  // Not a git repository at all: the same normal answer the branch board gives,
  // and how the renderer learns to show no chip and no board here.
  if (!repository.ok) return { kind: 'noIssueHost' }

  const origin = await run('git', 'remote', 'get-url', 'origin')
  const pointer = await readFile(workspacePath, JIRA_POINTER_FILE)
  const env = await readFile(workspacePath, JIRA_ENV_FILE)

  const host = chooseIssueHost({
    repository: true,
    // Existence decides, not validity: a pointer file that is there says Jira,
    // and an unreadable one is then a missing piece the board names.
    jiraPointer: pointer !== undefined,
    githubRemote: origin.ok && isGitHubRemote(origin.stdout),
    jiraCredential: hasJiraCredentialKey(env)
  })
  if (host === 'none') return { kind: 'noIssueHost' }

  if (host === 'jira') {
    const setup = readJiraSetup({ pointer, env })
    if (setup.kind === 'incomplete') return { kind: 'notConfigured', missing: setup.missing }
    return collectJiraIssues({
      config: setup.config,
      ...(seams.fetchImpl === undefined ? {} : { fetchImpl: seams.fetchImpl }),
      remaining: left,
      limit: ISSUE_LIMIT,
      now: clock.now
    })
  }

  const identity = await run('gh', 'api', 'user', '--jq', '.login')
  const login = identity.ok ? identity.stdout.trim() : ''
  if (login === '') return { kind: 'unreachable', reason: reasonFrom(identity) }

  const named = await run('gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
  const repo = named.ok ? parseNameWithOwner(named.stdout) : undefined
  // gh reached the host but not this repository: no issues are readable here,
  // and an empty board would be a lie about that.
  if (repo === undefined) return { kind: 'unreachable', reason: reasonFrom(named) }

  const listed = await run(
    'gh',
    'api',
    'graphql',
    '-f',
    `query=${openIssuesQuery(repo.owner, repo.name, ISSUE_LIMIT)}`
  )
  if (!listed.ok) return { kind: 'unreachable', reason: reasonFrom(listed) }

  // Mentions are a search the host does, not something a body can be read for:
  // a mention in any comment counts, and this is the only way to hear about it.
  const mentions = await run(
    'gh',
    'issue',
    'list',
    '--state',
    'open',
    '--mention',
    '@me',
    '--limit',
    String(ISSUE_LIMIT),
    '--json',
    'number'
  )
  if (!mentions.ok) return { kind: 'unreachable', reason: reasonFrom(mentions) }

  let facts: IssueFacts
  try {
    facts = {
      repoLabel: `${repo.owner}/${repo.name}`,
      host: { kind: 'github' },
      // A GitHub login is both the identity and the display name.
      you: { id: login, name: login },
      issues: parseIssues(listed.stdout),
      mentioned: parseIssueNumbers(mentions.stdout)
    }
  } catch {
    // gh answered something this build cannot read. Said out loud rather than
    // shown as a repository with no issues in it.
    return { kind: 'unreachable', reason: 'GitHub answered something Crucible could not read.' }
  }

  return { kind: 'board', board: classifyIssues(facts, clock.now()) }
}

/** gh's own first line where it wrote one, and a sentence with a fix where not. */
function reasonFrom(outcome: CommandOutcome): string {
  const first = outcome.stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  return first === undefined || first === '' ? NO_GH : first
}
