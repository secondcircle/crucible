import type {
  CacheMissFacts,
  CacheRetention,
  ChangeFact,
  RetentionSource
} from '../../../shared/agent/port'

// The cache surfaces' display formats, in one place so the strip, the dialog,
// the badge and the seam cannot drift into four spellings of one fact.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

/** `1 miss`, `9 misses` — the count the strip prints in bold. */
export function missesText(count: number): string {
  return `${count} ${count === 1 ? 'miss' : 'misses'}`
}

/** `$2.80 re-billed`, and nothing at all with no misses to have paid for. */
export function moneyText(count: number, dollars: number): string {
  if (count === 0) return ''
  return `$${dollars.toFixed(2)} re-billed`
}

// π's own compact token form, mirrored from its `formatTokens`: 118211 reads
// as 118k, 4210 as 4.2k.
export function compactTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

function clock(at: Date, minutes: boolean): string {
  const hour = at.getHours()
  const suffix = hour < 12 ? 'am' : 'pm'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  if (!minutes) return `${twelve}${suffix}`
  return `${twelve}:${String(at.getMinutes()).padStart(2, '0')}${suffix}`
}

function date(at: Date, now: number): string {
  const stamp = `${MONTHS[at.getMonth()]} ${at.getDate()}`
  // A date a year back is ambiguous without its year.
  return now - at.getTime() >= YEAR ? `${stamp} ${at.getFullYear()}` : stamp
}

// The span the count covers. Within the week the weekday and the hour is what
// a person remembers doing; past it, the date. The strip's number always
// states the span it covers, because a bare count is a lie once resets exist.
export function spanStart(iso: string, now = Date.now()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  if (now - at.getTime() < WEEK) return `${DAYS[at.getDay()]} ${clock(at, false)}`
  return date(at, now)
}

/** The same instant, to the minute, which is what the dialog has room for. */
export function spanStartFull(iso: string, now = Date.now()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  if (now - at.getTime() < WEEK) return `${DAYS[at.getDay()]} ${clock(at, true)}`
  return `${date(at, now)} ${clock(at, true)}`
}

/** The gap since the previous turn, in the largest unit that still says something. */
export function gapText(gapMs: number): string {
  const gap = Math.max(0, gapMs)
  if (gap < MINUTE) return `${Math.round(gap / 1000)}s`
  if (gap < HOUR) return `${Math.round(gap / MINUTE)}m`
  if (gap < 2 * DAY) return `${Math.round(gap / HOUR)}h`
  return `${Math.round(gap / DAY)}d`
}

/** How the retention reads where the word "retention" is already on the line. */
export function retentionText(retention: CacheRetention): string {
  return retention === '1h' ? '1 hour' : '5 min'
}

// Where the setting came from, named as whoever actually decided: Crucible's
// own default, or the environment variable when it overrode.
export function retentionSource(
  retention: CacheRetention,
  source: RetentionSource
): string {
  if (source === 'crucible') return 'Crucible default'
  return retention === '1h' ? 'PI_CACHE_RETENTION=long' : 'PI_CACHE_RETENTION override'
}

// How long a conversation has been sitting, in the two largest units that
// still say something: `47m`, `2h 13m`, `1d 3h`. The cache expiry choice's
// first fact, and the one the person recognizes as their own afternoon.
export function idleText(idleMs: number): string {
  const idle = Math.max(0, idleMs)
  if (idle < MINUTE) return `${Math.floor(idle / 1000)}s`
  if (idle < HOUR) return `${Math.floor(idle / MINUTE)}m`
  if (idle < DAY) {
    const hours = Math.floor(idle / HOUR)
    const minutes = Math.floor((idle - hours * HOUR) / MINUTE)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }
  const days = Math.floor(idle / DAY)
  const hours = Math.floor((idle - days * DAY) / HOUR)
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

// An estimated re-bill, always to two decimals and never rounded away: a
// two-cent break still shows its two cents, because the number is the whole
// reason the dialog is worth interrupting for.
export function rebillText(dollars: number): string {
  return `$${Math.max(0, dollars).toFixed(2)}`
}

// An unknown fact is omitted rather than guessed: honest data holds, and a
// surface says nothing at all about what Crucible does not know.
function changeText(fact: ChangeFact, subject: string): string | undefined {
  if (fact === 'unknown') return undefined
  return `${subject} ${fact === 'yes' ? 'changed' : 'unchanged'}`
}

// The seam's one line of facts, in the ruled reading order. No cause, no
// severity, no judgment: what happened, and what it cost.
export function seamFacts(miss: CacheMissFacts): readonly string[] {
  const rebilled = `${compactTokens(miss.tokensRebilled)} tokens re-billed`
  // π's own rule: below a cent the parenthetical says nothing worth the room.
  const money = miss.dollarsRebilled >= 0.01 ? ` (+$${miss.dollarsRebilled.toFixed(2)})` : ''
  return [
    `${rebilled}${money}`,
    `${gapText(miss.gapMs)} since previous turn`,
    changeText(miss.modelChanged, 'model'),
    changeText(miss.thinkingChanged, 'thinking'),
    `retention ${retentionText(miss.retention)}`,
    miss.jump === 'yes' ? 'after a jump' : undefined
  ].filter((fact): fact is string => fact !== undefined)
}

// Display only: the copy is always the absolute path. Crucible's state lives
// under the user's own home, so the ledger reads as `~/…` and the whole of it
// fits the dialog's width — which is the one thing that dialog is 520px wide
// to buy.
export function homePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, '~/')
}

/** What the strip's accessible name says, count and span in one sentence. */
export function stripLabel(count: number): string {
  return `Cache health — ${missesText(count)} since your last reset`
}
