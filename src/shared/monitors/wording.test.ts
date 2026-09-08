import { describe, expect, it } from 'vitest'
import { RETAINED_OUTPUT_CHARS, WAKE_OUTPUT_CHARS, type WakeFacts } from './monitor'
import {
  briefDuration,
  exactDuration,
  composeWake,
  isWakeMessage,
  listAnswer,
  longDuration,
  lostMonitorsNotice,
  monitorCallSummary,
  setAnswer,
  stopAnswer,
  stopRefusal,
  stoppedNote,
  WAKE_MESSAGE_PREFIX
} from './wording'

// Every sentence a monitor says, checked where it is written. One module says
// them, so a wake in the fake flavor and a wake in the SDK flavor cannot read
// two different ways.

function facts(overrides: Partial<WakeFacts> = {}): WakeFacts {
  return {
    monitorId: 'm-1f3a',
    description: 'CI on PR #482 to finish',
    ending: { reason: 'met' },
    waitedMs: 400_000,
    checks: 13,
    lastOutput: { text: 'completed · e2e: failure', truncated: false },
    ...overrides
  }
}

describe('the wake', () => {
  it('names the monitor, the ending, the wait, the checks and the last output', () => {
    const wake = composeWake(facts())
    expect(wake.text).toContain('CI on PR #482 to finish')
    expect(wake.text).toContain('condition met')
    expect(wake.text).toContain('6m 40s')
    expect(wake.text).toContain('13 checks')
    expect(wake.text).toContain('completed · e2e: failure')
  })

  it('opens with the prefix, so nobody mistakes it for something the user typed', () => {
    expect(composeWake(facts()).text.startsWith(WAKE_MESSAGE_PREFIX)).toBe(true)
    expect(isWakeMessage(composeWake(facts()).text)).toBe(true)
    expect(isWakeMessage('CI is done, please look')).toBe(false)
  })

  it('carries the error when the check broke', () => {
    const wake = composeWake(
      facts({ ending: { reason: 'broke', error: 'gh: Not logged in to github.com.' } })
    )
    expect(wake.text).toContain('check broke')
    expect(wake.text).toContain('gh: Not logged in to github.com.')
    expect(wake.card?.body).toContain('gh: Not logged in to github.com.')
  })

  it('says the error once when it is also what the check printed', () => {
    const error = 'gh: Not logged in to github.com.'
    const wake = composeWake(
      facts({
        ending: { reason: 'broke', error },
        lastOutput: { text: `${error}\n`, truncated: false }
      })
    )
    expect(wake.card?.body).toBe(error)
    expect(wake.text.split(error)).toHaveLength(2)
  })

  it('bounds the output it carries and says it was cut', () => {
    const wake = composeWake(
      facts({ lastOutput: { text: 'x'.repeat(WAKE_OUTPUT_CHARS + 500), truncated: false } })
    )
    expect(wake.text).toMatch(/cut to the first part/)
    expect(wake.text.length).toBeLessThan(WAKE_OUTPUT_CHARS + 800)
  })

  // A broken check's error is the output the wake carries for that ending, so
  // it is bounded like any other: a compile dump or a stack trace on stderr
  // must not become a megabyte of a model's context, and the detail's retained
  // copy must not end up the poorer of the two.
  it('bounds the error a broken check carries, as it bounds any other output', () => {
    const noise = 'x'.repeat(500_000)
    const wake = composeWake(
      facts({
        ending: { reason: 'broke', error: noise },
        lastOutput: { text: noise.slice(0, RETAINED_OUTPUT_CHARS), truncated: true }
      })
    )
    expect(wake.text.length).toBeLessThan(WAKE_OUTPUT_CHARS + 800)
    expect(wake.card?.body?.length ?? 0).toBeLessThan(WAKE_OUTPUT_CHARS + 800)
  })

  it('says plainly when the check printed nothing at all', () => {
    const bare: WakeFacts = { ...facts() }
    delete (bare as { lastOutput?: unknown }).lastOutput
    expect(composeWake(bare).text).toContain('The check printed nothing.')
  })

  it('says the monitor is over, so nobody waits on a second wake', () => {
    expect(composeWake(facts()).text).toMatch(/will not check again/)
  })

  it('tells the three endings apart by tone as well as by words', () => {
    expect(composeWake(facts()).card?.tone).toBe('monitor')
    expect(composeWake(facts({ ending: { reason: 'timedOut' } })).card?.tone).toBe('warn')
    expect(composeWake(facts({ ending: { reason: 'broke', error: 'x' } })).card?.tone).toBe('bad')
  })

  it('carries a card badged as a monitor, in the mock\u2019s order', () => {
    expect(composeWake(facts()).card).toMatchObject({
      badge: 'monitor',
      title: 'CI on PR #482 to finish',
      meta: 'condition met · 6m 40s · 13 checks'
    })
  })
})

describe('the answers the tools give', () => {
  it('names the id to stop by and the timing actually in force', () => {
    const answer = setAnswer(
      { id: 'm-1f3a', description: 'CI on PR #482 to finish', cwd: '/repos/crucible' },
      { intervalMs: 5_000, timeoutMs: 60_000 }
    )
    expect(answer).toContain('m-1f3a')
    expect(answer).toContain('every 5s')
    expect(answer).toContain('after 1m')
    expect(answer).toContain('/repos/crucible')
    expect(answer).toMatch(/End your turn now/)
  })

  // Review 3. R3 and R15: the answer states the interval and timeout actually
  // in force, which is what lets a clamped agent know it was clamped. An
  // answer that rounds 90s to "2m" states a cadence the monitor is not
  // running at, and an agent asking for 90s cannot tell rounding from a clamp.
  it('states the timing in force exactly, never rounded to a neater unit', () => {
    const timing = { intervalMs: 90_000, timeoutMs: 2_700_000 }
    const answer = setAnswer(
      { id: 'm-1f3a', description: 'CI on PR #482 to finish', cwd: '/repos/crucible' },
      timing
    )
    expect(answer).not.toContain('every 2m')
    expect(answer).toMatch(/every (90s|1m 30s)/)

    const listed = listAnswer(
      [
        {
          id: 'm-1f3a',
          description: 'CI on PR #482 to finish',
          intervalMs: 90_000,
          timeoutMs: 2_700_000,
          setAt: '2026-09-08T10:04:00.000Z',
          checks: 1
        }
      ],
      Date.parse('2026-09-08T10:05:00.000Z')
    )
    expect(listed).not.toContain('every 2m')
    expect(listed).toMatch(/every (90s|1m 30s)/)
  })

  it('lists each live monitor with everything an agent has to know about it', () => {
    const now = Date.parse('2026-09-08T10:10:00.000Z')
    const listed = listAnswer(
      [
        {
          id: 'm-1f3a',
          description: 'CI on PR #482 to finish',
          intervalMs: 30_000,
          timeoutMs: 1_800_000,
          setAt: '2026-09-08T10:04:00.000Z',
          checks: 12,
          last: {
            at: '2026-09-08T10:09:30.000Z',
            output: { text: 'in_progress', truncated: false },
            result: { kind: 'exited', exitCode: 1 }
          }
        }
      ],
      now
    )
    expect(listed).toContain('m-1f3a')
    expect(listed).toContain('CI on PR #482 to finish')
    expect(listed).toContain('every 30s')
    expect(listed).toContain('up to 30m')
    expect(listed).toContain('waited 6m')
    expect(listed).toContain('12 checks')
    expect(listed).toContain('in_progress')
  })

  it('has its own sentence for waiting on nothing', () => {
    expect(listAnswer([], Date.now())).toMatch(/Nothing is being watched/)
  })

  it('says a stop stopped it, and that no wake is coming', () => {
    expect(stopAnswer('CI on PR #482 to finish')).toContain('CI on PR #482 to finish')
    expect(stopAnswer('x')).toMatch(/No wake will arrive/)
  })

  it('refuses an id it does not hold without hinting at anybody else\u2019s', () => {
    expect(stopRefusal('m-9999')).toContain('m-9999')
    expect(stopRefusal('m-9999')).toMatch(/nothing was stopped/)
  })
})

describe('what the user\u2019s stop and a quit leave behind', () => {
  it('reads as Crucible\u2019s own, never as the user speaking', () => {
    const note = stoppedNote([
      { description: 'CI on PR #482 to finish', waitedMs: 250_000, checks: 8 }
    ])
    expect(note).toMatch(/^Crucible status update — automatic, and not sent by the user\./)
    expect(note).toContain('CI on PR #482 to finish')
    expect(note).toContain('4m 10s')
    expect(note).toContain('8 checks')
    expect(note).toMatch(/No wake is coming/)
  })

  it('names each lost node monitor with its command and how far it got', () => {
    const notice = lostMonitorsNotice([
      {
        description: 'the npm publish of 0.4.12 to land',
        command: 'npm view pkg version | grep -q 0.4.12',
        waitedMs: 660_000,
        timeoutMs: 3_600_000
      }
    ])
    expect(notice).toContain('the npm publish of 0.4.12 to land')
    expect(notice).toContain('npm view pkg version | grep -q 0.4.12')
    expect(notice).toContain('11m of 1h')
    expect(notice).toMatch(/no wake is coming/)
  })
})

describe('the tool row\u2019s summary', () => {
  it('names what is awaited and the cadence in force, never the command', () => {
    expect(
      monitorCallSummary({
        description: 'CI on PR #482 to finish',
        command: 'gh pr checks 482 | grep -q IN_PROGRESS && exit 1'
      })
    ).toBe('CI on PR #482 to finish · every 30s · up to 30m')
  })

  it('states the clamped values, so the row never claims a cadence nothing runs at', () => {
    expect(monitorCallSummary({ description: 'a port to free up', intervalSeconds: 1 })).toContain(
      'every 5s'
    )
  })

  // The row is composed from the raw tool arguments, and the model boundary
  // reads a numeric string as the number it means, so the row has to read it
  // the same way or it states a cadence the monitor is not running at.
  it('reads a numeric string as the number the monitor was set with', () => {
    expect(
      monitorCallSummary({
        description: 'CI on PR #482 to finish',
        reason: 'so I can read the failing job',
        command: 'gh pr checks 482',
        intervalSeconds: '45',
        timeoutSeconds: '600'
      })
    ).toBe('CI on PR #482 to finish · every 45s · up to 10m')
  })

  it('says something sensible about a call that named nothing', () => {
    expect(monitorCallSummary(undefined)).toBe('a monitor · every 30s · up to 30m')
  })
})

describe('the three duration formats', () => {
  it('is the chip\u2019s shorthand', () => {
    expect(briefDuration(30_000)).toBe('30s')
    expect(briefDuration(240_000)).toBe('4m')
    expect(briefDuration(3_600_000)).toBe('1h')
    expect(briefDuration(24 * 3_600_000)).toBe('1d')
  })

  it('is the detail\u2019s and the wake\u2019s longer form', () => {
    expect(longDuration(45_000)).toBe('45s')
    expect(longDuration(400_000)).toBe('6m 40s')
    expect(longDuration(252_000)).toBe('4m 12s')
    expect(longDuration(240_000)).toBe('4m')
    expect(longDuration(3_840_000)).toBe('1h 4m')
  })

  // What a tool answer says a monitor's timing is. It may not drop a unit that
  // is not zero: the number an agent reads back is the number in force, so a
  // clamp is visible and a rounding is never mistaken for one.
  it('is exact wherever a value in force is stated', () => {
    expect(exactDuration(90_000)).toBe('1m 30s')
    expect(exactDuration(5_000)).toBe('5s')
    expect(exactDuration(2_700_000)).toBe('45m')
    expect(exactDuration(3_845_000)).toBe('1h 4m 5s')
    expect(exactDuration(24 * 3_600_000)).toBe('24h')
    expect(exactDuration(0)).toBe('0s')
  })
})
