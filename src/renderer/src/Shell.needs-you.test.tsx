// @vitest-environment jsdom
//
// Turns finish in sessions nobody is looking at, which is the whole point of
// running several at once. What the rail does about it is here: the mark, what
// clears it, the Tab walk across workspaces, and what leaves the window.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import type { NeedsYouService, WaitingSession } from '../../shared/needs-you/service'
import { Shell } from './Shell'
import { createScriptedPort, type ScriptedPort } from './testing/scripted-port'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const HERE = 'Sidebar working-state visual language'
const NEARBY = 'Quota strip rounds the wrong way past $10'
const AWAY = 'Deploy pipeline flakes on cold start'

// Two workspaces, because Tab crossing between them is the ruling most easily
// broken by an implementation that walks one list.
const TWO_WORKSPACES: ShellSnapshot = {
  workspaces: [
    { id: 'w1', name: 'crucible', path: '/repos/crucible' },
    { id: 'w2', name: 'splash-down', path: '/repos/splash-down' }
  ],
  activeWorkspaceId: 'w1',
  activeSessionId: 's1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:00:00.000Z',
      title: HERE,
      working: false,
      fresh: false
    },
    {
      id: 's2',
      workspaceId: 'w1',
      createdAt: '2026-08-20T10:01:00.000Z',
      title: NEARBY,
      working: false,
      fresh: false
    },
    {
      id: 's3',
      workspaceId: 'w2',
      createdAt: '2026-08-20T10:02:00.000Z',
      title: AWAY,
      working: false,
      fresh: false
    }
  ]
}

function recorder(): NeedsYouService & {
  readonly counts: number[]
  readonly banners: WaitingSession[]
} {
  const counts: number[] = []
  const banners: WaitingSession[] = []
  return {
    counts,
    banners,
    async waiting(count) {
      counts.push(count)
    },
    async announce(session) {
      banners.push(session)
    }
  }
}

async function rail(
  needsYou?: NeedsYouService
): Promise<{ readonly port: ScriptedPort }> {
  const port = createScriptedPort(TWO_WORKSPACES)
  render(
    <Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
      needsYou={needsYou}
    />
  )
  await screen.findByRole('button', { name: HERE })
  await settled()
  return { port }
}

/** A whole turn in one session, start to finish. */
async function turn(port: ScriptedPort, sessionId: string): Promise<void> {
  await act(async () => {
    await port.prompt(sessionId, 'go')
  })
  act(() => port.endTurn(sessionId))
  await settled()
}

function row(title: string): HTMLElement {
  return screen.getByRole('button', { name: (name) => name.startsWith(title) })
}

function tab(): void {
  fireEvent.keyDown(document, { key: 'Tab' })
}

describe('the mark', () => {
  it('goes on a session that finished while the user was somewhere else', async () => {
    const { port } = await rail()

    await turn(port, 's2')

    expect(screen.getByRole('button', { name: `${NEARBY} (needs you)` })).toBeInTheDocument()
  })

  it('stays off the session on screen, which the user watched finish', async () => {
    const { port } = await rail()

    await turn(port, 's1')

    expect(screen.getByRole('button', { name: HERE })).toBeInTheDocument()
  })

  it('goes on a turn that ended in an error, which is finished too', async () => {
    const { port } = await rail()
    await act(async () => {
      await port.prompt('s2', 'go')
    })

    act(() => port.failTurn('s2', 'the provider refused'))
    await settled()

    expect(screen.getByRole('button', { name: `${NEARBY} (needs you)` })).toBeInTheDocument()
  })

  it('stays off a turn the user stopped, which they already know about', async () => {
    const { port } = await rail()
    await act(async () => {
      await port.prompt('s2', 'go')
    })

    await act(async () => {
      await port.cancel('s2')
    })
    await settled()

    expect(screen.getByRole('button', { name: NEARBY })).toBeInTheDocument()
  })

  it('comes off when the user lands on that session', async () => {
    const { port } = await rail()
    await turn(port, 's2')

    await act(async () => fireEvent.click(row(NEARBY)))

    expect(screen.getByRole('button', { name: NEARBY })).toBeInTheDocument()
  })

  it('comes off again when a marked session starts working', async () => {
    const { port } = await rail()
    await turn(port, 's2')

    await act(async () => {
      await port.prompt('s2', 'a queued follow-up fires')
    })

    expect(screen.getByRole('button', { name: `${NEARBY} (working)` })).toBeInTheDocument()
  })

  it('goes on the session on screen when the window was left behind', async () => {
    const { port } = await rail()

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await turn(port, 's1')

    expect(screen.getByRole('button', { name: `${HERE} (needs you)` })).toBeInTheDocument()
  })

  it('comes off the session on screen when the window takes focus back', async () => {
    const { port } = await rail()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await turn(port, 's1')

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(screen.getByRole('button', { name: HERE })).toBeInTheDocument()
  })
})

describe('the workspace roll-up', () => {
  it('counts the sessions waiting there, beside no board count at all', async () => {
    const { port } = await rail()

    await turn(port, 's2')
    await turn(port, 's3')

    expect(screen.getByTitle('1 session waiting on you in crucible')).toHaveTextContent('1')
    expect(screen.getByTitle('1 session waiting on you in splash-down')).toHaveTextContent('1')
  })
})

describe('the Tab walk', () => {
  it('takes the topmost session asking, in rail order', async () => {
    const { port } = await rail()
    await turn(port, 's3')
    await turn(port, 's2')

    await act(async () => tab())

    expect(row(NEARBY)).toHaveAttribute('aria-current', 'true')
  })

  it('crosses into the next workspace once this one is clear', async () => {
    const { port } = await rail()
    await turn(port, 's2')
    await turn(port, 's3')

    await act(async () => tab())
    await act(async () => tab())

    expect(row(AWAY)).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'splash-down' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('empties the queue: every landing clears the mark behind it', async () => {
    const { port } = await rail()
    await turn(port, 's2')
    await turn(port, 's3')

    await act(async () => tab())
    await act(async () => tab())

    expect(screen.getByRole('button', { name: NEARBY })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: AWAY })).toBeInTheDocument()
  })

  it('does nothing at all when nothing is asking', async () => {
    const { port } = await rail()

    await act(async () => tab())

    expect(row(HERE)).toHaveAttribute('aria-current', 'true')
    expect(port.calls.filter((call) => call.op === 'activateSession')).toEqual([])
  })

  it('leaves Shift-Tab to the model ring', async () => {
    const { port } = await rail()
    await turn(port, 's2')

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    })

    // The mark is untouched and nobody was activated: the ring's key never
    // walks the rail.
    expect(screen.getByRole('button', { name: `${NEARBY} (needs you)` })).toBeInTheDocument()
    expect(port.calls.filter((call) => call.op === 'activateSession')).toEqual([])
  })
})

describe('what leaves the window', () => {
  it('reports the count so main can badge the dock with it', async () => {
    const service = recorder()
    const { port } = await rail(service)

    await turn(port, 's2')
    await turn(port, 's3')

    expect(service.counts.at(-1)).toBe(2)
  })

  it('takes the count back down as the user works through them', async () => {
    const service = recorder()
    const { port } = await rail(service)
    await turn(port, 's2')
    await turn(port, 's3')

    await act(async () => tab())

    expect(service.counts.at(-1)).toBe(1)
  })

  it('announces the finished session by workspace and title', async () => {
    const service = recorder()
    const { port } = await rail(service)

    await turn(port, 's3')

    expect(service.banners).toEqual([
      { sessionId: 's3', workspace: 'splash-down', title: AWAY }
    ])
  })

  it('announces nothing about a turn the user stopped', async () => {
    const service = recorder()
    const { port } = await rail(service)
    await act(async () => {
      await port.prompt('s2', 'go')
    })

    await act(async () => {
      await port.cancel('s2')
    })

    expect(service.banners).toEqual([])
  })
})
