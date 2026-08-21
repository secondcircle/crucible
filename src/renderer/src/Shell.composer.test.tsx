// @vitest-environment jsdom
//
// The composer's height, driven through the shell. jsdom lays nothing out, so
// the mirror the composer measures is given a height per character here, and
// what is pinned is what the composer does with a measurement — never how it
// looks.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { CEILING_HEIGHT, RESTING_HEIGHT } from './components/composer-height'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

/** What a line of wrapped text is worth in this fake layout. */
const PER_CHARACTER = 4

async function shell(): Promise<ScriptedPort> {
  const port = createScriptedPort(oneSession())
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />
  )
  await settled()
  // The measuring twin is a stable node, so one definition covers every
  // re-render of the composer.
  const mirror = document.querySelector('.boxmirror') as HTMLElement
  Object.defineProperty(mirror, 'scrollHeight', {
    configurable: true,
    get: () => (mirror.textContent ?? '').length * PER_CHARACTER
  })
  return port
}

const box = (): HTMLTextAreaElement => screen.getByLabelText('Message') as HTMLTextAreaElement

const height = (): string => box().style.height

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text } })
  })
  await settled()
}

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(box(), { key: 'Enter' })
  })
  await settled()
}

describe('the composer height', () => {
  it('rests at 46px with no draft', async () => {
    await shell()

    expect(height()).toBe(`${RESTING_HEIGHT}px`)
  })

  it('grows with the draft as it is typed', async () => {
    await shell()

    await type('x'.repeat(20))

    expect(height()).toBe('84px')
  })

  it('stops at the 300px ceiling however long the draft gets', async () => {
    await shell()

    await type('x'.repeat(400))

    expect(height()).toBe(`${CEILING_HEIGHT}px`)
  })

  it('reverses as the draft shrinks, and rests when it is deleted', async () => {
    await shell()
    await type('x'.repeat(40))
    expect(height()).toBe('164px')

    await type('x'.repeat(20))
    expect(height()).toBe('84px')

    await type('')
    expect(height()).toBe(`${RESTING_HEIGHT}px`)
  })

  it('snaps back to resting on send', async () => {
    const port = await shell()
    await type('a long dictated draft, reread before it goes'.repeat(3))
    expect(height()).toBe(`${CEILING_HEIGHT}px`)

    await send()

    expect(box()).toHaveValue('')
    expect(height()).toBe(`${RESTING_HEIGHT}px`)
    expect(port.calls.map((call) => call.op)).toContain('prompt')
  })

  it('snaps back on a queued send too', async () => {
    const port = await shell()
    await act(async () => {
      await port.prompt('s1', 'the turn already under way')
    })
    await settled()
    await type('x'.repeat(60))
    expect(height()).toBe('244px')

    await send()

    expect(port.calls.map((call) => call.op)).toContain('steer')
    expect(height()).toBe(`${RESTING_HEIGHT}px`)
  })

  it('follows a restored draft rather than only what was typed', async () => {
    const port = await shell()

    // A queued message handed back is a draft nobody typed into the box.
    await act(async () => {
      port.flushQueue('s1', [{ kind: 'steering', text: 'x'.repeat(30) }])
    })
    await settled()

    expect(box()).toHaveValue('x'.repeat(30))
    expect(height()).toBe('124px')
  })

  it('is content-driven and mode-blind: bash grows the same way', async () => {
    await shell()

    await type(`!${'x'.repeat(30)}`)

    expect(document.querySelector('.cbox.bash')).not.toBeNull()
    expect(height()).toBe('128px')
  })
})
