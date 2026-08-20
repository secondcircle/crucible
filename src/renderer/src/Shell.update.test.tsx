// @vitest-environment jsdom
//
// The update pill: absent until main announces a newer installed build,
// then one click that asks for the restart. The person decides when — the
// pill never restarts anything on its own.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AppUpdateListener,
  AppUpdateService
} from '../../shared/app-update/service'
import { Shell } from './Shell'
import { createScriptedPort, oneSession } from './testing/scripted-port'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const MODEL = { id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }

interface ScriptedUpdate extends AppUpdateService {
  announce(commit: string): void
  readonly restarts: ReadonlyArray<string>
}

function scriptedUpdate(pending: string | null = null): ScriptedUpdate {
  const listeners = new Set<AppUpdateListener>()
  const restarts: string[] = []
  return {
    pending: async () => pending,
    restart: async () => {
      restarts.push('restart')
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    announce(commit) {
      for (const listener of [...listeners]) listener({ type: 'update_ready', commit })
    },
    restarts
  }
}

async function shellWith(appUpdate?: AppUpdateService): Promise<void> {
  const port = createScriptedPort(oneSession({ model: MODEL.id, thinkingLevel: 'low' }))
  port.models = [MODEL]
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      appUpdate={appUpdate}
    />
  )
  await sessionsShown()
  await settled()
}

const pill = (): HTMLElement | null =>
  screen.queryByRole('button', { name: 'Restart into the updated app' })

describe('the update pill', () => {
  it('does not exist without the update seam, which is every dev launch', async () => {
    await shellWith(undefined)
    expect(pill()).toBeNull()
  })

  it('stays absent while no newer build waits', async () => {
    await shellWith(scriptedUpdate())
    expect(pill()).toBeNull()
  })

  it('appears when main announces a newer build, and a click asks to restart', async () => {
    const update = scriptedUpdate()
    await shellWith(update)

    act(() => update.announce('bbb2222'))

    const button = pill()
    expect(button).not.toBeNull()
    fireEvent.click(button as HTMLElement)
    await vi.waitFor(() => expect(update.restarts).toHaveLength(1))
  })

  it('shows a build already waiting at mount, so a pill cannot be missed', async () => {
    const update = scriptedUpdate('ccc3333')
    await shellWith(update)

    await vi.waitFor(() => expect(pill()).not.toBeNull())
  })
})
