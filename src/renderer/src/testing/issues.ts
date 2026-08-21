import { classifyIssues, type IssueFact } from '../../../shared/workspace/classify-issues'
import type { IssueBoardSnapshot, IssueRow } from '../../../shared/workspace/service'

// Issue board snapshots for component tests, minted against the clock so ages
// and the "refreshed N ago" line read the same way on every run.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const URL = 'https://github.com/secondcircle/crucible'

/** One of every group, so the board's whole grammar is on screen at once. */
export function hostedIssues(now = Date.now()): IssueBoardSnapshot {
  const hours = (count: number): string => new Date(now - count * HOUR_MS).toISOString()
  const days = (count: number): string => new Date(now - count * DAY_MS).toISOString()

  const rows: readonly IssueRow[] = [
    {
      group: 'assignedToYou',
      number: 128,
      reference: 'crucible#128',
      title: 'Quota strip misaligns under the Add workspace button',
      url: `${URL}/issues/128`,
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'ui' }
      ],
      assignees: ['ike'],
      authorLogin: 'ike',
      createdAt: days(2),
      updatedAt: hours(4),
      comments: 3,
      body: 'At 248px sidebar width the percent column wraps.\n\n## Steps\n\n1. Sign in',
      latestComment: {
        login: 'maya',
        at: days(1),
        body: 'Reproduced on Max.'
      }
    },
    {
      group: 'assignedToYou',
      number: 131,
      reference: 'crucible#131',
      title: 'Session tree: jumping from a tool chain loses the collapse state',
      url: `${URL}/issues/131`,
      labels: [{ name: 'bug', color: 'd73a4a' }],
      assignees: ['ike'],
      authorLogin: 'ike',
      createdAt: days(6),
      updatedAt: days(5),
      comments: 1,
      body: 'Every chain in the path comes back open.'
    },
    {
      group: 'mentionsYou',
      number: 124,
      reference: 'crucible#124',
      title: 'Should the standing prompt ship the communication style?',
      url: `${URL}/issues/124`,
      labels: [{ name: 'design', color: '0075ca' }],
      assignees: ['maya'],
      authorLogin: 'maya',
      createdAt: days(3),
      updatedAt: days(1),
      comments: 7,
      body: 'Half of what @ike keeps re-typing is style.'
    },
    {
      group: 'unclaimed',
      number: 133,
      reference: 'crucible#133',
      title: 'Bash run output should keep ANSI colour in the conversation',
      url: `${URL}/issues/133`,
      labels: [{ name: 'feature', color: 'a2eeef' }],
      assignees: [],
      authorLogin: 'ike',
      createdAt: hours(6),
      updatedAt: hours(6),
      comments: 0,
      body: ''
    },
    {
      group: 'pickedUp',
      number: 117,
      reference: 'crucible#117',
      title: 'Worktree script failures should print the whole output',
      url: `${URL}/issues/117`,
      labels: [{ name: 'bug', color: 'd73a4a' }],
      assignees: ['ike'],
      authorLogin: 'ike',
      createdAt: days(12),
      updatedAt: days(8),
      comments: 2,
      body: 'The chip says it failed; the script said why.',
      pr: { number: 130, state: 'open', url: `${URL}/pull/130` }
    },
    {
      // Somebody else's, which is what widening the scope reveals.
      group: 'assignedToOthers',
      number: 134,
      reference: 'crucible#134',
      title: 'Sidebar drag-reorder for sessions',
      url: `${URL}/issues/134`,
      labels: [{ name: 'feature', color: 'a2eeef' }],
      assignees: ['maya'],
      authorLogin: 'maya',
      createdAt: hours(3),
      updatedAt: hours(3),
      comments: 4,
      body: 'Sessions sort by activity, which moves them under the cursor.'
    }
  ]

  return {
    collectedAt: new Date(now).toISOString(),
    repoLabel: 'secondcircle/crucible',
    host: { kind: 'github' },
    login: 'ike',
    rows
  }
}

const JIRA_URL = 'https://secondcircle.atlassian.net'

/** You on the Jira instance: an account id to group by, a name to show. */
export const JIRA_YOU = { id: '557058:you', name: 'Ike Melancon' }
const JIRA_MATE = { id: '557058:dev', name: 'Devi Raman' }

/**
 * A Jira project judged by the real classifier, so the groups, the references
 * and the order are the ones the board would actually get. No mentions group:
 * Jira answers no such question.
 */
export function jiraIssues(now = Date.now()): IssueBoardSnapshot {
  const at = (hours: number): string => new Date(now - hours * HOUR_MS).toISOString()
  const fact = (number: number, over: Partial<IssueFact>): IssueFact => ({
    number,
    title: `issue ${number}`,
    url: `${JIRA_URL}/browse/EK-${number}`,
    body: '',
    createdAt: at(200),
    updatedAt: at(number),
    authorLogin: JIRA_MATE.name,
    assignees: [],
    labels: [],
    comments: 0,
    pullRequests: [],
    ...over
  })

  return classifyIssues(
    {
      repoLabel: 'EK',
      host: { kind: 'jira' },
      you: JIRA_YOU,
      issues: [
        fact(341, {
          title: 'Enrolment import drops the second address line',
          body: 'The importer reads both address lines and writes one.',
          assignees: [JIRA_YOU],
          labels: [{ name: 'defect' }, { name: 'sev-high' }],
          comments: 2,
          latestComment: { login: JIRA_MATE.name, at: at(4), body: 'Confirmed on staging.' }
        }),
        fact(352, { title: 'Nobody owns the onboarding checklist', labels: [{ name: 'onboarding' }] }),
        fact(349, {
          title: 'Master data sync retries forever on a 409',
          assignees: [JIRA_MATE],
          labels: [{ name: 'platform-gap' }]
        })
      ],
      mentioned: []
    },
    now
  )
}
