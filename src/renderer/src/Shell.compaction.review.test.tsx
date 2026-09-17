// @vitest-environment jsdom
//
// Review 2, finding 5. Delete this file with the fix.
//
// The threshold field commits on blur. Escape closes the Settings card
// without blurring it, so a number the user typed and then dismissed the card
// over is discarded in silence: the port is never called and the field is back
// at the old value when the card is reopened.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

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
  return port
}

async function openCompactionSettings(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  })
  await settled()
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
        name: /Compaction/
      })
    )
  })
  await settled()
}

describe('a threshold typed and then dismissed with Escape', () => {
  it('is written rather than discarded in silence', async () => {
    const port = await shell()
    await openCompactionSettings()

    const field = screen.getByLabelText('Compact at, in thousands of tokens')
    await act(async () => {
      fireEvent.change(field, { target: { value: '100' } })
    })
    await settled()

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    await settled()

    expect(port.compaction).toEqual({ enabled: true, thresholdK: 100 })
  })
})
