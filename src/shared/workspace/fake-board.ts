import type { BoardRow, BranchBoardSnapshot } from './service'

// Two canned boards, one with a host and one without, so both are drivable
// with no git run, no gh run and no cost.

/** A path holding this word gets the git-only board, as bash runs do. */
const NO_HOST = 'nohost'

const DAY_MS = 24 * 60 * 60 * 1000

export function cannedBoard(workspacePath: string, now: number): BranchBoardSnapshot {
  const at = (days: number): string => new Date(now - days * DAY_MS).toISOString()

  // Minted at call time, so the board's age reads fresh however long the app
  // has been open.
  const collectedAt = new Date(now).toISOString()

  return workspacePath.includes(NO_HOST)
    ? {
        collectedAt,
        trunk: 'main',
        repoLabel: workspacePath,
        rows: homeRows(at)
      }
    : {
        collectedAt,
        trunk: 'main',
        repoLabel: 'secondcircle/pi-extensions',
        host: { kind: 'github', reachable: true },
        rows: workRows(at)
      }
}

const PR = 'https://github.com/secondcircle/pi-extensions/pull'

function workRows(at: (days: number) => string): readonly BoardRow[] {
  return [
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
      pr: { number: 45, state: 'merged', url: `${PR}/45` }
    },
    {
      group: 'landed',
      name: 'compaction-economics',
      yours: true,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: 'the yield is stated in tokens, not turns',
      drift: { kind: 'squashed' },
      touchedAt: at(8.5),
      signal: { kind: 'merged', byYou: true },
      pr: { number: 33, state: 'merged', url: `${PR}/33` }
    },
    {
      group: 'landed',
      name: 'issue-11-tier-aware-addendum',
      yours: true,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: "record why the addendum's identity is pinned",
      drift: { kind: 'squashed' },
      touchedAt: at(9),
      signal: { kind: 'merged', byYou: true },
      pr: { number: 14, state: 'merged', url: `${PR}/14` }
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
      touchedAt: at(2),
      signal: { kind: 'checksRunning' },
      pr: { number: 57, state: 'draft', url: `${PR}/57` }
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
      touchedAt: at(8),
      signal: { kind: 'checksFailed', count: 2 },
      pr: { number: 54, state: 'open', url: `${PR}/54` }
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
      touchedAt: at(8.2),
      signal: { kind: 'changesRequested' },
      pr: { number: 51, state: 'open', url: `${PR}/51` }
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
      pr: { number: 61, state: 'open', url: `${PR}/61` }
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
      pr: { number: 59, state: 'open', url: `${PR}/59` }
    },
    {
      group: 'localOnly',
      name: 'run-control-and-wake',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'merge-gate round 1: fix the three blocking notes',
      drift: { kind: 'counts', ahead: 35, behind: 0 },
      touchedAt: at(1.2)
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
      touchedAt: at(7)
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
      group: 'stale',
      name: 'orchestrate-trial',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'a short context file or a skill name no longer throws',
      drift: { kind: 'counts', ahead: 364, behind: 5 },
      touchedAt: at(46)
    },
    {
      group: 'stale',
      name: 'wip/pre-wipe',
      yours: true,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: 'wip: snapshot before full repo wipe',
      drift: { kind: 'counts', ahead: 430, behind: 289 },
      touchedAt: at(47)
    },
    {
      // Somebody else's, so widening the scope has something to reveal.
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
}

function homeRows(at: (days: number) => string): readonly BoardRow[] {
  return [
    {
      group: 'landed',
      name: 'tighten-nav-spacing',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'nav items line up at every breakpoint',
      drift: { kind: 'counts', ahead: 0, behind: 2 },
      touchedAt: at(3),
      signal: { kind: 'inTrunkHistory' }
    },
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
      group: 'landed',
      name: 'drop-jquery',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'remove the last two call sites',
      drift: { kind: 'counts', ahead: 0, behind: 24 },
      touchedAt: at(24),
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
    },
    {
      group: 'localOnly',
      name: 'try-view-transitions',
      yours: true,
      checkedOut: false,
      local: true,
      onOrigin: false,
      subject: 'spike: cross-document view transitions',
      drift: { kind: 'counts', ahead: 2, behind: 19 },
      touchedAt: at(21)
    },
    {
      group: 'stale',
      name: 'old-tailwind-theme',
      yours: true,
      checkedOut: false,
      local: false,
      onOrigin: true,
      subject: 'before the css rewrite',
      drift: { kind: 'counts', ahead: 41, behind: 133 },
      touchedAt: at(171)
    }
  ]
}
