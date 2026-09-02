// @vitest-environment jsdom
//
// The version strip at the foot of the rail and the pill in the top bar: two
// doors onto one act, both driven through the shared version seam. Nothing
// here restarts on its own, and nothing claims to be up to date before a check
// has answered.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AppUpdateService,
  AppVersionListener,
  AppVersionState
} from '../../shared/app-update/service'
import { createFakeCacheService } from '../../shared/cache/fake-service'
import { createFakeQuotaService } from '../../shared/quota/fake-service'
import { Shell } from './Shell'
import { createScriptedPort, oneSession } from './testing/scripted-port'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { sessionsShown } from './testing/sidebar'
import { settled } from './testing/settled'

const MODEL = { id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off', 'low'] }

const INSTALLED = '0.4.17'
const WAITING = '0.4.18'

interface ScriptedUpdate extends AppUpdateService {
  announce(state: AppVersionState): void
  readonly restarts: ReadonlyArray<string>
}

function scriptedUpdate(state: AppVersionState): ScriptedUpdate {
  const listeners = new Set<AppVersionListener>()
  const restarts: string[] = []
  let held = state
  return {
    state: async () => held,
    restart: async () => {
      restarts.push('restart')
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    announce(next) {
      held = next
      for (const listener of [...listeners]) listener(next)
    },
    restarts
  }
}

const current = (checkedAt: number): AppVersionState => ({
  kind: 'installed',
  version: INSTALLED,
  update: { kind: 'current', checkedAt }
})

const ready: AppVersionState = {
  kind: 'installed',
  version: INSTALLED,
  update: { kind: 'ready', version: WAITING }
}

async function shellWith(
  appUpdate?: AppUpdateService,
  strips: 'strips' | 'bare' = 'bare'
): Promise<void> {
  const port = createScriptedPort(oneSession({ model: MODEL.id, thinkingLevel: 'low' }))
  port.models = [MODEL]
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      appUpdate={appUpdate}
      {...(strips === 'strips'
        ? { cache: createFakeCacheService(), quota: createFakeQuotaService() }
        : {})}
    />
  )
  await sessionsShown()
  await settled()
}

const pill = (): HTMLElement | null =>
  screen.queryByRole('button', { name: 'Restart into the updated app' })

const strip = (): HTMLElement | null => document.querySelector('.version')

describe('the version strip', () => {
  it('does not exist without the version seam, which is a test with no service', async () => {
    await shellWith(undefined)

    expect(strip()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('claims nothing before the first check has answered', async () => {
    await shellWith(
      scriptedUpdate({ kind: 'installed', version: INSTALLED, update: { kind: 'unchecked' } })
    )

    expect(strip()).toHaveTextContent(`Crucible ${INSTALLED}`)
    expect(strip()).toHaveTextContent('checking for updates…')
    expect(strip()).not.toHaveTextContent('up to date')
    expect(strip()?.tagName).toBe('DIV')
  })

  it('rests as an uninteractive block while the app is up to date', async () => {
    await shellWith(scriptedUpdate(current(Date.now() - 4 * 60_000)))

    expect(strip()).toHaveTextContent(`Crucible ${INSTALLED}`)
    expect(strip()).toHaveTextContent('up to date')
    expect(strip()).toHaveTextContent('checked 4 min ago')
    expect(strip()?.tagName).toBe('DIV')
    expect(pill()).toBeNull()
  })

  it('becomes the second restart door when a version is waiting, beside the pill', async () => {
    const update = scriptedUpdate(current(Date.now()))
    await shellWith(update)

    act(() => update.announce(ready))

    const door = screen.getByRole('button', { name: `Restart into Crucible ${WAITING}` })
    expect(door).toHaveTextContent(`↻ ${WAITING} · Restart`)
    expect(door).toHaveTextContent('downloaded, waiting for a restart')
    expect(door).toHaveAttribute('title', `${WAITING} is installed. Restart to pick it up.`)

    fireEvent.click(door)
    await vi.waitFor(() => expect(update.restarts).toHaveLength(1))

    // Two doors, one act: the top bar pill is up at the same time and fires
    // the same restart.
    const top = pill()
    expect(top).not.toBeNull()
    expect(top).toHaveAttribute('title', `${WAITING} is installed. Restart to pick it up.`)
    fireEvent.click(top as HTMLElement)
    await vi.waitFor(() => expect(update.restarts).toHaveLength(2))
  })

  it('reports a version staged before the window subscribed', async () => {
    const update = scriptedUpdate(ready)
    await shellWith(update)

    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: `Restart into Crucible ${WAITING}` })).not.toBeNull()
    )
    expect(pill()).not.toBeNull()
  })

  it('marks a dev launch in amber and offers nothing to click', async () => {
    await shellWith(scriptedUpdate({ kind: 'dev', version: '0.1.0', commit: 'd2d0bba' }))

    expect(strip()).toHaveTextContent('Crucible 0.1.0')
    expect(strip()?.querySelector('.vdev')).toHaveTextContent('dev · d2d0bba')
    expect(strip()).toHaveTextContent('updates are not checked in dev')
    expect(strip()?.tagName).toBe('DIV')
    expect(pill()).toBeNull()
  })

  it('names the launch `dev` alone when the commit cannot be read', async () => {
    await shellWith(scriptedUpdate({ kind: 'dev', version: '0.1.0' }))

    expect(strip()?.querySelector('.vdev')).toHaveTextContent('dev')
    expect(strip()?.querySelector('.vdev')).not.toHaveTextContent('·')
  })

  it('sits in the fixed foot order: cache, quota, version, then Add workspace', async () => {
    await shellWith(scriptedUpdate(current(Date.now())), 'strips')

    const feet = [...document.querySelectorAll('.side .cachestrip, .side .quota, .side .version, .side .addws')]
    expect(feet.map((foot) => foot.className.split(' ')[0])).toEqual([
      'cachestrip',
      'quota',
      'version',
      'addws'
    ])
  })
})
