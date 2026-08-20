import type { BoardRow, BranchBoardSnapshot } from '../../../shared/workspace/service'

// Board snapshots for component tests, minted against the clock so ages and
// the "refreshed N ago" line read the same way on every run.

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(days: number, now: number): string {
  return new Date(now - days * DAY_MS).toISOString()
}

/** The work repository: a host, five groups, and one branch that is not yours. */
export function hostedBoard(now = Date.now()): BranchBoardSnapshot {
  const at = (days: number): string => daysAgo(days, now)
  const rows: readonly BoardRow[] = [
    {
      group: 'landed',
      name: 'issue-7-roster-parking',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: true,
      subject: 'the roster failure notices name the extension',
      drift: { kind: 'squashed' },
      touchedAt: at(8),
      signal: { kind: 'merged', byYou: true },
      pr: { number: 45, state: 'merged', url: 'https://github.com/x/y/pull/45' }
    },
    {
      group: 'landed',
      name: 'build/build-260819-f1wn',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'merge-gate: comment police fixes',
      drift: { kind: 'counts', ahead: 0, behind: 4 },
      touchedAt: at(1),
      signal: { kind: 'inTrunkHistory' }
    },
    {
      group: 'inFlight',
      name: 'issue-9-id-namespacing',
      yours: true,
      checkedOut: true,
      local: true,
      onOrigin: true,
      subject: "a lead's workers are numbered under its own id",
      drift: { kind: 'counts', ahead: 1, behind: 93 },
      touchedAt: at(2),
      signal: { kind: 'checksFailed', count: 2 },
      pr: { number: 54, state: 'open', url: 'https://github.com/x/y/pull/54' }
    },
    {
      group: 'inFlight',
      name: 'issue-6-monitor-leads',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: true,
      subject: 'rewrap two comment lines the reviewer flagged',
      drift: { kind: 'counts', ahead: 5, behind: 98 },
      touchedAt: at(3),
      signal: { kind: 'changesRequested' },
      pr: { number: 51, state: 'open', url: 'https://github.com/x/y/pull/51' }
    },
    {
      group: 'inFlight',
      name: 'crucible/synthesis-260818-7hci',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: true,
      subject: 'local venue lock and hold, fresh build',
      drift: { kind: 'counts', ahead: 43, behind: 1 },
      touchedAt: at(4),
      signal: { kind: 'checksRunning' },
      pr: { number: 57, state: 'draft', url: 'https://github.com/x/y/pull/57' }
    },
    {
      group: 'waitingOnYou',
      name: 'tam/retry-budget-guard',
      yours: false,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: 'a retry budget that cannot outlive its parent turn',
      drift: { kind: 'author', login: 'tamsin' },
      touchedAt: at(2),
      signal: { kind: 'yourReview' },
      pr: { number: 61, state: 'open', url: 'https://github.com/x/y/pull/61' }
    },
    {
      group: 'waitingOnYou',
      name: 'bot/deps-bump-aug',
      yours: false,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: 'bump 14 dev dependencies',
      drift: { kind: 'author', login: 'dependabot' },
      touchedAt: at(5),
      signal: { kind: 'assignedToYou' },
      pr: { number: 59, state: 'open', url: 'https://github.com/x/y/pull/59' }
    },
    {
      group: 'localOnly',
      name: 'role-delegation',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: '/family pins the column for the whole run',
      drift: { kind: 'counts', ahead: 87, behind: 3 },
      touchedAt: at(6)
    },
    {
      group: 'stale',
      name: 'backup-pre-surgery',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'chore(memory): backfill batch 1/6',
      drift: { kind: 'counts', ahead: 360, behind: 10 },
      touchedAt: at(45)
    },
    {
      // Somebody else's, which is what widening the scope reveals.
      group: 'stale',
      name: 'plan/plan-20260410-ueno',
      yours: false,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: 'plan: Oracle Audit Pass — worktree set',
      drift: { kind: 'counts', ahead: 430, behind: 100 },
      touchedAt: at(132)
    }
  ]

  return {
    collectedAt: new Date(now).toISOString(),
    trunk: 'main',
    repoLabel: 'secondcircle/pi-extensions',
    host: { kind: 'github', reachable: true },
    rows
  }
}

/** The home repository: no host at all, so nothing host-derived may render. */
export function gitOnlyBoard(now = Date.now()): BranchBoardSnapshot {
  const at = (days: number): string => daysAgo(days, now)
  return {
    collectedAt: new Date(now).toISOString(),
    trunk: 'main',
    repoLabel: '/repos/resume-site',
    rows: [
      {
        group: 'landed',
        name: 'og-image',
        yours: true,
        checkedOut: false,
        local: true,
        onOrigin: true,
        subject: "a card that doesn't look broken on Slack",
        drift: { kind: 'counts', ahead: 0, behind: 9 },
        touchedAt: at(9),
        signal: { kind: 'inTrunkHistory' }
      },
      {
        group: 'inFlight',
        name: 'card-grid',
        yours: true,
        checkedOut: true,
        local: true,
        onOrigin: true,
        subject: 'the project cards wrap instead of scrolling',
        drift: { kind: 'counts', ahead: 4, behind: 0 },
        touchedAt: at(2)
      },
      {
        group: 'localOnly',
        name: 'rewrite-about-page',
        yours: true,
        checkedOut: false,
        local: true,
        onOrigin: false,
        subject: 'third draft, still hate it',
        drift: { kind: 'counts', ahead: 6, behind: 2 },
        touchedAt: at(6)
      }
    ]
  }
}

/** A GitHub origin whose gh could not answer this collection. */
export function unreachableBoard(now = Date.now()): BranchBoardSnapshot {
  return {
    ...gitOnlyBoard(now),
    repoLabel: '/repos/pi-extensions',
    host: { kind: 'github', reachable: false }
  }
}
