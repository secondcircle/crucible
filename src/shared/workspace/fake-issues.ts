import { classifyIssues, type IssueFact, type IssuePerson } from './classify-issues'
import {
  JIRA_API_TOKEN,
  JIRA_POINTER_FILE,
  missingPiece
} from './jira-setup'
import type { IssueBoardAnswer } from './service'

// Canned issue boards, judged by the real classifier so the fake launch
// exercises the grouping rather than hard-coding its answer. No gh run, no Jira
// call, no network, no cost.
//
// Three states, each reached by a word in the workspace path, because the fake
// launch has no settings to flip: `nohost` for no issue host, `nojira` for Jira
// configured badly, `jira` for a Jira board.

/** A path holding this word has no issue host, as it has no branch host. */
const NO_HOST = 'nohost'

/** Jira is the host here and its configuration is not finished. */
const JIRA_UNSET = 'nojira'

/** Jira is the host here and answered. Checked after `nojira`, which contains it. */
const JIRA = 'jira'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const REPO = 'secondcircle/crucible'
const URL = 'https://github.com/secondcircle/crucible'

// A GitHub login is both identity and display name; on Jira they differ, which
// is the whole reason a person carries two fields.
const IKE: IssuePerson = { id: 'ike', name: 'ike' }
const MAYA: IssuePerson = { id: 'maya', name: 'maya' }
const DEV: IssuePerson = { id: 'dev', name: 'dev' }

const PROJECT = 'EK'
const JIRA_URL = 'https://secondcircle.atlassian.net'

const JIRA_YOU: IssuePerson = { id: '557058:1f0e-you', name: 'Ike Melancon' }
const JIRA_MATE: IssuePerson = { id: '557058:9a2b-dev', name: 'Devi Raman' }
// Same display name as the teammate above, a different account: the reason the
// grouping compares ids and never names.
const JIRA_NAMESAKE: IssuePerson = { id: '557058:44c1-dv2', name: 'Devi Raman' }

export function cannedIssues(workspacePath: string, now: number): IssueBoardAnswer {
  if (workspacePath.includes(NO_HOST)) return { kind: 'noIssueHost' }
  if (workspacePath.includes(JIRA_UNSET)) {
    // Two pieces missing at once, which is what the board must list in full.
    return { kind: 'notConfigured', missing: [missingPiece(JIRA_API_TOKEN), missingPiece(JIRA_POINTER_FILE)] }
  }
  if (workspacePath.includes(JIRA)) {
    return {
      kind: 'board',
      board: classifyIssues(
        {
          repoLabel: PROJECT,
          host: { kind: 'jira' },
          you: JIRA_YOU,
          issues: cannedJiraFacts(now),
          // Jira answers no mention question, so that group never occurs.
          mentioned: []
        },
        now
      )
    }
  }
  return {
    kind: 'board',
    board: classifyIssues(
      {
        repoLabel: REPO,
        host: { kind: 'github' },
        you: IKE,
        issues: cannedFacts(now),
        mentioned: [124]
      },
      now
    )
  }
}

function cannedFacts(now: number): readonly IssueFact[] {
  const hours = (count: number): string => new Date(now - count * HOUR_MS).toISOString()
  const days = (count: number): string => new Date(now - count * DAY_MS).toISOString()

  return [
    {
      number: 128,
      title: 'Quota strip misaligns under the Add workspace button',
      url: `${URL}/issues/128`,
      body: [
        "At 248px sidebar width the quota strip's percent column wraps, and the reset",
        'instant lands under the **Add workspace** button instead of beside its meter.',
        'Only shows with three or more windows, so the Max plan hits it and Pro does not.',
        '',
        '## Steps',
        '',
        '1. Sign in with a plan reporting 3+ windows',
        '2. Leave the sidebar at its default width',
        '3. Watch the bottom of the sidebar',
        '',
        'Suspect the strip is sizing from the meter label rather than the strip, so a',
        'long window label (`weekly · opus`) pushes past the fold.'
      ].join('\n'),
      createdAt: days(2),
      updatedAt: hours(4),
      authorLogin: 'ike',
      assignees: [IKE],
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'ui', color: '5319e7' }
      ],
      comments: 3,
      latestComment: {
        login: 'maya',
        at: days(1),
        body: "Reproduced on Max. Also happens at any sidebar width under ~270px, so it isn't the default that's special."
      },
      pullRequests: []
    },
    {
      number: 131,
      title: 'Session tree: jumping from a tool chain loses the collapse state',
      url: `${URL}/issues/131`,
      body: 'Jump from inside a collapsed chain and every chain in the path comes back open.',
      createdAt: days(5),
      updatedAt: days(5),
      authorLogin: 'ike',
      assignees: [IKE],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      comments: 1,
      latestComment: {
        login: 'ike',
        at: days(4),
        body: 'The tree is refetched on every open, so the collapse map has nothing to survive in.'
      },
      pullRequests: []
    },
    {
      number: 124,
      title: 'Should the standing prompt ship the communication style?',
      url: `${URL}/issues/124`,
      body: 'Half of what @ike keeps re-typing is style. Worth a section in the standing prompt, or is that a per-workspace thing?',
      createdAt: days(3),
      updatedAt: days(1),
      authorLogin: 'maya',
      assignees: [MAYA],
      labels: [{ name: 'design', color: '0075ca' }],
      comments: 7,
      latestComment: {
        login: 'maya',
        at: days(1),
        body: 'Leaning per-workspace: the tone a repository wants is a fact about the repository.'
      },
      pullRequests: []
    },
    {
      number: 133,
      title: 'Bash run output should keep ANSI colour in the conversation',
      url: `${URL}/issues/133`,
      body: 'A shared run arrives as plain text, so a failing test suite loses the red that made it readable.',
      createdAt: hours(6),
      updatedAt: hours(6),
      authorLogin: 'ike',
      assignees: [],
      labels: [{ name: 'feature', color: 'a2eeef' }],
      comments: 0,
      pullRequests: []
    },
    {
      number: 119,
      title: 'Model ring skips a model the adapter listed under two ids',
      url: `${URL}/issues/119`,
      body: 'Shift+Tab lands on the same model twice when the adapter lists an alias beside the canonical id.',
      createdAt: days(9),
      updatedAt: days(9),
      authorLogin: 'ike',
      assignees: [],
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'p1', color: 'd9a441' }
      ],
      comments: 2,
      latestComment: {
        login: 'ike',
        at: days(8),
        body: 'MODEL_RING filters by what the adapter listed, and both ids pass that filter.'
      },
      pullRequests: []
    },
    {
      number: 102,
      title: "Context panel tabs survive a session reset and shouldn't",
      url: `${URL}/issues/102`,
      body: 'Reset the session and the panel still holds the old conversation\u2019s exhibits.',
      createdAt: days(21),
      updatedAt: days(21),
      authorLogin: 'maya',
      assignees: [],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      comments: 0,
      pullRequests: []
    },
    {
      number: 117,
      title: 'Worktree script failures should print the whole output',
      url: `${URL}/issues/117`,
      body: 'The chip says it failed; the script said why, and that is what the person needs.',
      createdAt: days(12),
      updatedAt: days(8),
      authorLogin: 'ike',
      assignees: [IKE],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      comments: 2,
      latestComment: {
        login: 'ike',
        at: days(8),
        body: 'Carrying the output as a value rather than a throw, so none of it is lost on the way up.'
      },
      pullRequests: [{ number: 130, state: 'open', url: `${URL}/pull/130` }]
    },
    {
      number: 134,
      title: 'Sidebar drag-reorder for sessions',
      url: `${URL}/issues/134`,
      body: 'Sessions sort by activity, which moves them under the cursor mid-click.',
      createdAt: hours(3),
      updatedAt: hours(3),
      authorLogin: 'maya',
      assignees: [MAYA],
      labels: [{ name: 'feature', color: 'a2eeef' }],
      comments: 4,
      latestComment: {
        login: 'dev',
        at: hours(2),
        body: 'A manual order has to survive a relaunch, so it belongs in the store.'
      },
      pullRequests: []
    },
    {
      number: 121,
      title: 'Run log grows without bound',
      url: `${URL}/issues/121`,
      body: 'The run log is appended to forever and is never rotated.',
      createdAt: days(11),
      updatedAt: days(11),
      authorLogin: 'dev',
      assignees: [DEV],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      comments: 0,
      pullRequests: []
    }
  ]
}

/**
 * One canned Jira project: keys rather than numbers, labels with no colour,
 * one assignee at most, and no pull request anywhere — Bitbucket is not this
 * round, so nothing here is picked up except through a session.
 */
function cannedJiraFacts(now: number): readonly IssueFact[] {
  const hours = (count: number): string => new Date(now - count * HOUR_MS).toISOString()
  const days = (count: number): string => new Date(now - count * DAY_MS).toISOString()
  const issue = (number: number, over: Partial<IssueFact>): IssueFact => ({
    number,
    title: '',
    url: `${JIRA_URL}/browse/${PROJECT}-${number}`,
    body: '',
    createdAt: days(20),
    updatedAt: days(20),
    authorLogin: JIRA_MATE.name,
    assignees: [],
    labels: [],
    comments: 0,
    pullRequests: [],
    ...over
  })

  return [
    issue(341, {
      title: 'Enrolment import drops the second address line',
      body: [
        'The importer reads `address1` and `address2` but writes only the first, so every',
        'imported enrolment loses its apartment number.',
        '',
        '## Reproduce',
        '',
        '1. Import the sample file from the ticket EK-330',
        '2. Open any enrolment with two address lines',
        '',
        'Suspect the mapper, not the parser: the raw row still has both.'
      ].join('\n'),
      createdAt: days(6),
      updatedAt: hours(3),
      authorLogin: JIRA_MATE.name,
      assignees: [JIRA_YOU],
      labels: [{ name: 'defect' }, { name: 'sev-high' }],
      comments: 4,
      latestComment: {
        login: JIRA_MATE.name,
        at: hours(5),
        body: 'Confirmed against staging. The parser keeps both lines, so it is the mapper.'
      }
    }),
    issue(338, {
      title: 'Accounting export needs the period close date',
      body: 'The export carries the period id but not its close date, so the downstream ledger has to look it up.',
      createdAt: days(9),
      updatedAt: days(1),
      assignees: [JIRA_YOU],
      labels: [{ name: 'architecture' }],
      comments: 1,
      latestComment: {
        login: JIRA_YOU.name,
        at: days(1),
        body: 'Adding the date to the export contract rather than a second lookup.'
      }
    }),
    issue(352, {
      title: 'Nobody owns the onboarding checklist for the new BC',
      body: 'Free to pick up: the checklist exists, the owner does not.',
      createdAt: hours(20),
      updatedAt: hours(20),
      labels: [{ name: 'onboarding' }],
      comments: 0
    }),
    issue(349, {
      title: 'Master data sync retries forever on a 409',
      body: 'A conflict is retried with the same payload, so the queue never drains.',
      createdAt: days(3),
      updatedAt: days(2),
      assignees: [JIRA_MATE],
      labels: [{ name: 'platform-gap' }, { name: 'defect' }],
      comments: 6,
      latestComment: {
        login: JIRA_MATE.name,
        at: days(2),
        body: 'Backing off and dropping the payload on the third conflict.'
      }
    }),
    issue(344, {
      title: 'Rate card upload rejects a valid CSV with a BOM',
      body: 'A file saved from Excel starts with a byte-order mark and the header check fails on it.',
      createdAt: days(12),
      updatedAt: days(4),
      // Same display name as EK-349's assignee, a different account.
      assignees: [JIRA_NAMESAKE],
      labels: [{ name: 'defect' }, { name: 'sev-low' }],
      comments: 2,
      latestComment: {
        login: JIRA_NAMESAKE.name,
        at: days(4),
        body: 'Stripping the BOM before the header check, and a test with a BOM in it.'
      }
    })
  ]
}
