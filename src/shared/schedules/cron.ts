// The cron dialect a schedule speaks, as pure functions: parsing, the next
// slot, and the human reading the board prints beside the raw expression.
// Five fields, numeric only, evaluated in the machine's local time — no
// presets, no plain-English input, no names for months or days.
//
// Nothing here reads a clock: every answer is a function of the instants it
// is given, which is what makes "fires at 9am daily" testable.

export interface ParsedCron {
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  readonly daysOfWeek: readonly number[]
  /** Whether the day-of-month field was written as `*`; the dom/dow rule needs it. */
  readonly everyDayOfMonth: boolean
  readonly everyDayOfWeek: boolean
}

interface FieldRange {
  readonly min: number
  readonly max: number
}

const MINUTE: FieldRange = { min: 0, max: 59 }
const HOUR: FieldRange = { min: 0, max: 23 }
const DAY_OF_MONTH: FieldRange = { min: 1, max: 31 }
const MONTH: FieldRange = { min: 1, max: 12 }
// 0 and 7 both mean Sunday, which is why this range runs to seven.
const DAY_OF_WEEK: FieldRange = { min: 0, max: 7 }

/** How far ahead a search for the next slot looks before giving up. */
const HORIZON_DAYS = 1500

/** The expression's fields, or nothing at all when it is not one Crucible fires. */
export function parseCron(expression: string): ParsedCron | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined

  const minutes = parseField(fields[0], MINUTE)
  const hours = parseField(fields[1], HOUR)
  const daysOfMonth = parseField(fields[2], DAY_OF_MONTH)
  const months = parseField(fields[3], MONTH)
  const daysOfWeek = parseField(fields[4], DAY_OF_WEEK)
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    daysOfWeek === undefined
  ) {
    return undefined
  }

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    // Sunday is 0 to the Date object, so a 7 collapses onto it here.
    daysOfWeek: unique(daysOfWeek.map((day) => (day === 7 ? 0 : day))),
    everyDayOfMonth: fields[2] === '*',
    everyDayOfWeek: fields[4] === '*'
  }
}

/** Whether a local instant sits on one of the expression's slots. */
export function cronMatches(cron: ParsedCron, at: Date): boolean {
  if (!cron.minutes.includes(at.getMinutes())) return false
  if (!cron.hours.includes(at.getHours())) return false
  if (!cron.months.includes(at.getMonth() + 1)) return false
  return dayMatches(cron, at)
}

// The dom/dow rule every cron implementation shares: with both restricted,
// either one matching is a match; with one restricted, that one decides.
function dayMatches(cron: ParsedCron, at: Date): boolean {
  const dom = cron.daysOfMonth.includes(at.getDate())
  const dow = cron.daysOfWeek.includes(at.getDay())
  if (cron.everyDayOfMonth && cron.everyDayOfWeek) return true
  if (cron.everyDayOfMonth) return dow
  if (cron.everyDayOfWeek) return dom
  return dom || dow
}

/**
 * The first slot strictly after `after`, in local time. Nothing at all when
 * the expression cannot be parsed, or when no slot falls inside the horizon
 * (`0 0 30 2 *` — the thirtieth of February).
 */
export function nextCronSlot(expression: string, after: Date): Date | undefined {
  const cron = parseCron(expression)
  if (cron === undefined) return undefined

  // The next whole minute after the instant given: a slot is a minute, and a
  // slot already passed is never the next one.
  const from = new Date(after.getTime())
  from.setSeconds(0, 0)
  from.setMinutes(from.getMinutes() + 1)

  // Day by day, so an expression that fires once a year costs a few hundred
  // date comparisons rather than half a million minute ones.
  for (let day = 0; day <= HORIZON_DAYS; day += 1) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + day)
    if (!cron.months.includes(date.getMonth() + 1)) continue
    if (!dayMatches(cron, date)) continue
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const slot = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute)
        if (slot.getTime() < from.getTime()) continue
        // A slot that daylight saving moved off its own hour is still this
        // day's slot; what matters is that it is the earliest one left.
        if (slot.getDate() !== date.getDate()) continue
        return slot
      }
    }
  }
  return undefined
}

/**
 * Whether at least one slot has passed since the last-considered instant,
 * which is the whole of what makes a schedule due. However many slots passed,
 * the answer is the same one: due.
 */
export function cronDue(expression: string, lastConsidered: number, now: number): boolean {
  const next = nextCronSlot(expression, new Date(lastConsidered))
  return next !== undefined && next.getTime() <= now
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The human reading beside the raw expression: every-N-minutes, daily at a
 * time, weekly at a day-and-time. Anything else has none, and the board shows
 * the raw cron alone.
 */
export function cadenceText(expression: string): string | undefined {
  const cron = parseCron(expression)
  if (cron === undefined) return undefined
  const fields = expression.trim().split(/\s+/)
  const [minute, hour, dom, month, dow] = fields

  const everyDay = dom === '*' && month === '*'
  if (everyDay && dow === '*' && hour === '*') {
    if (minute === '*') return 'every minute'
    const step = /^\*\/(\d+)$/.exec(minute)
    if (step !== null) return `every ${step[1]} min`
    return undefined
  }
  if (cron.minutes.length !== 1 || cron.hours.length !== 1) return undefined
  const at = `${pad(cron.hours[0])}:${pad(cron.minutes[0])}`
  if (everyDay && dow === '*') return `daily ${at}`
  if (everyDay && cron.daysOfWeek.length === 1) {
    return `weekly ${DAY_NAMES[cron.daysOfWeek[0]]} ${at}`
  }
  return undefined
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** One field's values, or nothing at all when it is not one this dialect has. */
function parseField(field: string | undefined, range: FieldRange): readonly number[] | undefined {
  if (field === undefined || field === '') return undefined
  const values: number[] = []
  for (const term of field.split(',')) {
    const parsed = parseTerm(term, range)
    if (parsed === undefined) return undefined
    values.push(...parsed)
  }
  return values.length === 0 ? undefined : unique(values)
}

function parseTerm(term: string, range: FieldRange): readonly number[] | undefined {
  const [spec, stepText, ...extra] = term.split('/')
  if (extra.length > 0 || spec === undefined) return undefined

  let step = 1
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText)) return undefined
    step = Number(stepText)
    if (step < 1) return undefined
  }

  let from: number
  let to: number
  if (spec === '*') {
    from = range.min
    to = range.max
  } else if (/^\d+$/.test(spec)) {
    from = Number(spec)
    // `5/10` counts up from five to the end of the field, as cron has always
    // read it; a bare `5` is that one value.
    to = stepText === undefined ? from : range.max
  } else {
    const dash = /^(\d+)-(\d+)$/.exec(spec)
    if (dash === null) return undefined
    from = Number(dash[1])
    to = Number(dash[2])
  }
  if (from < range.min || to > range.max || from > to) return undefined

  const values: number[] = []
  for (let value = from; value <= to; value += step) values.push(value)
  return values
}

function unique(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}
