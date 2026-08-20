import { classifyIssues, type IssueFact } from './classify-issues'
import type { IssueBoardAnswer } from './service'

// One canned repository of issues, judged by the real classifier so the fake
// launch exercises the grouping rather than hard-coding its answer. No gh run,
// no network, no cost.

/** A path holding this word has no issue host, as it has no branch host. */
const NO_HOST = 'nohost'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const REPO = 'secondcircle/crucible'
const URL = 'https://github.com/secondcircle/crucible'

export function cannedIssues(workspacePath: string, now: number): IssueBoardAnswer {
  if (workspacePath.includes(NO_HOST)) return { kind: 'noIssueHost' }
  return {
    kind: 'board',
    board: classifyIssues(
      {
        repoLabel: REPO,
        login: 'ike',
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
      assignees: ['ike'],
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
      assignees: ['ike'],
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
      assignees: ['maya'],
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
      assignees: ['ike'],
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
      assignees: ['maya'],
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
      title: 'Installer log rotates into the repo root',
      url: `${URL}/issues/121`,
      body: '`logs/install-stable.log` grows without bound and is never rotated.',
      createdAt: days(11),
      updatedAt: days(11),
      authorLogin: 'dev',
      assignees: ['dev'],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      comments: 0,
      pullRequests: []
    }
  ]
}
