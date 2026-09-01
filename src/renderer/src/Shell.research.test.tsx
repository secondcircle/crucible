// @vitest-environment jsdom
//
// The Research section of Settings, driven over the scripted workspace service:
// no process, no network, no credential. What is asserted is what a person can
// see and click, never a component's insides.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { redactKeys, type ResearchStatus } from '../../shared/workspace/research'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession } from './testing/scripted-port'
import { createScriptedWorkspace, type ScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const SIGNED_OUT: ResearchStatus = { kind: 'signedOut', version: redactKeys('1.23.3') }
const CONNECTED: ResearchStatus = {
  kind: 'signedIn',
  version: redactKeys('1.23.3'),
  credits: 12_500
}

async function shell(
  snapshot: Partial<ShellSnapshot> = oneSession()
): Promise<ScriptedWorkspace> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  const workspace = createScriptedWorkspace()
  render(<Shell port={port} workspace={workspace} commands={createScriptedCommands()} />)
  await settled()
  return workspace
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
  await settled()
}

/** Opens Settings and lands on Research, which is where every test starts. */
async function research(): Promise<void> {
  await click('Settings')
  await click('Research')
}

const rows = (): string[] =>
  Array.from(document.querySelectorAll('.prov')).map((row) => row.textContent ?? '')

const dialog = (): HTMLElement | null =>
  screen.queryByRole('dialog', { name: 'Connect research' })

const statusReads = (workspace: ScriptedWorkspace): number =>
  workspace.calls.filter((call) => call.op === 'researchStatus').length

const opsOn = (workspace: ScriptedWorkspace): string[] =>
  workspace.calls.filter((call) => call.op.startsWith('research')).map((call) => call.op)

describe('reaching the Research section', () => {
  it('is offered in the rail and opens with a workspace, and with none', async () => {
    await shell({ workspaces: [], sessions: [] })

    await research()

    expect(
      within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
        name: 'Research'
      })
    ).toHaveAttribute('aria-current', 'true')
    expect(rows()).toHaveLength(3)
    // Nothing about a workspace: this section is about the machine.
    expect(document.querySelector('.setinner')?.textContent).not.toContain('workspace')
  })

  it('reads the status once when it opens, saying so until the answer lands', async () => {
    const workspace = await shell()
    workspace.holdStatus = true

    await research()

    expect(statusReads(workspace)).toBe(1)
    expect(rows()[0]).toContain('Checking…')
    expect(rows()[1]).toContain('Checking…')
    expect(rows()[2]).toContain('—')

    workspace.research = CONNECTED
    await act(async () => {
      workspace.settleStatus()
    })
    await settled()

    expect(rows()[0]).toContain('Installed — 1.23.3')
    expect(statusReads(workspace)).toBe(1)
  })

  it('reads again when the section is left and come back to', async () => {
    const workspace = await shell()
    await research()
    expect(statusReads(workspace)).toBe(1)

    await click('Providers')
    expect(statusReads(workspace)).toBe(1)

    await click('Research')
    expect(statusReads(workspace)).toBe(2)
  })
})

describe('what the three rows say', () => {
  async function showing(status: ResearchStatus): Promise<ScriptedWorkspace> {
    const workspace = await shell()
    workspace.research = status
    await research()
    return workspace
  }

  it('quotes the install command, selectable, for a CLI that is not there', async () => {
    await showing({ kind: 'notInstalled' })

    expect(rows()[0]).toContain('Not installed — npm i -g firecrawl-cli')
    expect(document.querySelector('.prov .cmd')?.textContent).toBe('npm i -g firecrawl-cli')
    expect(rows()[1]).toContain('Needs the CLI')
    expect(rows()[2]).toContain('—')
  })

  it('says what happened, and claims nothing about the CLI, when the status could not be read', async () => {
    await showing({ kind: 'unreadable', reason: redactKeys('firecrawl did not answer in time.') })

    expect(rows()[0]).toContain('Status could not be read — firecrawl did not answer in time.')
    expect(rows()[0]).not.toContain('Installed')
    expect(rows()[1]).toContain('Unknown')
  })

  it('names the version, and says it is not connected', async () => {
    await showing(SIGNED_OUT)

    expect(rows()[0]).toContain('Installed — 1.23.3')
    expect(rows()[1]).toContain('Not connected')
    expect(rows()[2]).toContain('—')
  })

  it('shows the credits a connected CLI reported', async () => {
    await showing(CONNECTED)

    expect(rows()[1]).toContain('Connected')
    expect(rows()[2]).toContain('12,500 credits remaining')
  })

  it('shows none left as the number it is', async () => {
    await showing({ kind: 'signedIn', version: redactKeys('1.23.3'), credits: 0 })

    expect(rows()[2]).toContain('0 credits remaining')
    expect(rows()[2]).not.toContain('—')
  })

  it('leaves the figure a dash where the CLI reported none', async () => {
    await showing({ kind: 'signedIn', version: redactKeys('1.23.3') })

    expect(rows()[1]).toContain('Connected')
    expect(rows()[2]).toContain('—')
  })

  it('marks a connected CLI with the green dot on every row', async () => {
    await showing(CONNECTED)

    expect(document.querySelectorAll('.prov .dot.in')).toHaveLength(3)
  })

  it('marks the facts a signed-out CLI has not established with the faint one', async () => {
    await showing(SIGNED_OUT)

    // Installed is established; connected and the credits are not.
    expect(document.querySelectorAll('.prov .dot.in')).toHaveLength(1)
    expect(document.querySelectorAll('.prov .dot.out')).toHaveLength(2)
  })

  it('invents no third colour for a status nobody could read', async () => {
    await showing({ kind: 'unreadable', reason: redactKeys('spawn EACCES') })

    expect(document.querySelectorAll('.prov .dot.in')).toHaveLength(0)
    expect(document.querySelectorAll('.prov .dot.out')).toHaveLength(3)
  })
})

describe('the one button in the connection row', () => {
  it('is a disabled Connect, saying why, with no CLI installed', async () => {
    const workspace = await shell()
    workspace.research = { kind: 'notInstalled' }
    await research()

    const connect = screen.getByRole('button', { name: /which is not installed/ })
    expect(connect).toBeDisabled()
    expect(connect).toHaveAttribute('title', expect.stringContaining('npm i -g firecrawl-cli'))
    expect(screen.queryByRole('button', { name: /^Log out/ })).toBeNull()
  })

  it('is a disabled Connect, carrying the reason, when the status could not be read', async () => {
    const workspace = await shell()
    workspace.research = { kind: 'unreadable', reason: redactKeys('spawn EACCES') }
    await research()

    expect(screen.getByRole('button', { name: /spawn EACCES/ })).toBeDisabled()
  })

  it('is a live Connect when the CLI is installed and not connected', async () => {
    const workspace = await shell()
    workspace.research = SIGNED_OUT
    await research()

    const connect = screen.getByRole('button', { name: /^Connect/ })
    expect(connect).toBeEnabled()
    expect(connect.className).toContain('primary')
  })

  it('is Log out when the CLI is connected', async () => {
    const workspace = await shell()
    workspace.research = CONNECTED
    await research()

    expect(screen.getByRole('button', { name: /^Log out/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull()
  })

  it('has no Install, no Upgrade and no Refresh anywhere', async () => {
    const workspace = await shell()
    workspace.research = { kind: 'notInstalled' }
    await research()

    for (const gone of [/install/i, /upgrade/i, /refresh/i, /check again/i]) {
      expect(
        screen.queryAllByRole('button').filter((button) => gone.test(button.textContent ?? ''))
      ).toEqual([])
    }
  })
})

describe('connecting', () => {
  async function connecting(): Promise<ScriptedWorkspace> {
    const workspace = await shell()
    workspace.research = SIGNED_OUT
    await research()
    await click(/^Connect/)
    return workspace
  }

  it('opens the dialog in the same frame, and holds the row’s button while it waits', async () => {
    const workspace = await shell()
    workspace.research = SIGNED_OUT
    await research()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Connect/ }))
    })

    expect(dialog()).not.toBeNull()
    expect(screen.getByRole('button', { name: /^Connect/ })).toBeDisabled()
    expect(workspace.connecting()).toBe(1)
    expect(opsOn(workspace)).toContain('researchConnect')
  })

  it('shows what the CLI printed while it waits, under the notice, in order', async () => {
    const workspace = await connecting()

    await act(async () => {
      workspace.researchOutput('\nOpening browser for authorization…\n')
      workspace.researchOutput('If it did not open, visit: https://example.invalid/cli-auth\n')
    })

    const said = Array.from(document.querySelectorAll('.login .notice.out')).map(
      (line) => line.textContent
    )
    expect(said).toEqual([
      'Opening browser for authorization…',
      'If it did not open, visit: https://example.invalid/cli-auth'
    ])
  })

  it('collapses the line the CLI keeps rewriting while it waits', async () => {
    const workspace = await connecting()

    await act(async () => {
      workspace.researchOutput('\rWaiting for browser authentication.  ')
      workspace.researchOutput('\rWaiting for browser authentication.. ')
    })

    expect(
      Array.from(document.querySelectorAll('.login .notice.out')).map((line) => line.textContent)
    ).toEqual(['Waiting for browser authentication..'])
  })

  it('sends a pasted key to the service, masked, and puts it nowhere else', async () => {
    const workspace = await connecting()

    const field = screen.getByLabelText('Paste an API key instead')
    expect(field).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    await act(async () => {
      fireEvent.change(field, { target: { value: 'fc-pasted-by-a-person' } })
    })
    await click('Continue')

    expect(workspace.calls).toContainEqual({
      op: 'researchConnect',
      args: ['fc-pasted-by-a-person']
    })
    // Nowhere on screen, and in no other call.
    expect(document.body.textContent).not.toContain('fc-pasted-by-a-person')
    for (const call of workspace.calls.filter((one) => one.op !== 'researchConnect')) {
      expect(JSON.stringify(call.args)).not.toContain('fc-pasted-by-a-person')
    }
  })

  it('keeps the dialog open on a refusal, in the CLI’s words, with Cancel reading Close', async () => {
    const workspace = await connecting()

    await act(async () => {
      workspace.settleConnect({
        kind: 'refused',
        message: redactKeys('Error: Invalid API key format. API keys should start with "fc-"')
      })
    })
    await settled()

    expect(dialog()).not.toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid API key format')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    // Nothing about the rows was guessed from a failure.
    expect(rows()[1]).toContain('Not connected')
  })

  it('repaints the rows from the status that came back', async () => {
    const workspace = await connecting()

    await act(async () => {
      workspace.settleConnect({ kind: 'settled', status: CONNECTED })
    })
    await settled()

    expect(dialog()).toBeNull()
    expect(rows()[1]).toContain('Connected')
    expect(rows()[2]).toContain('12,500 credits remaining')
    // The status the connect answered with, not a second read.
    expect(statusReads(workspace)).toBe(1)
  })
})

describe('an attempt nobody is owed an answer for', () => {
  it('closes the dialog on Cancel and asks the service to end the attempt', async () => {
    const workspace = await shell()
    workspace.research = SIGNED_OUT
    await research()
    await click(/^Connect/)

    await click('Cancel')

    expect(dialog()).toBeNull()
    expect(opsOn(workspace)).toContain('researchCancelConnect')

    // The ended attempt still settles, and painting it is exactly what must
    // not happen: no message, no row change.
    await act(async () => {
      workspace.settleConnect({ kind: 'abandoned' })
    })
    await settled()

    expect(dialog()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(rows()[1]).toContain('Not connected')
  })

  it('paints nothing for an attempt a pasted key superseded', async () => {
    const workspace = await shell()
    workspace.research = SIGNED_OUT
    await research()
    await click(/^Connect/)

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Paste an API key instead'), {
        target: { value: 'fc-pasted-by-a-person' }
      })
    })
    await click('Continue')
    expect(workspace.connecting()).toBe(2)

    // The first attempt ends the way main ends it, while the second's dialog
    // is still open and waiting.
    await act(async () => {
      workspace.settleConnect({ kind: 'abandoned' })
    })
    await settled()

    expect(dialog()).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => {
      workspace.settleConnect({ kind: 'settled', status: CONNECTED })
    })
    await settled()

    expect(dialog()).toBeNull()
    expect(rows()[1]).toContain('Connected')
  })
})

describe('logging out', () => {
  async function connected(): Promise<ScriptedWorkspace> {
    const workspace = await shell()
    workspace.research = CONNECTED
    await research()
    return workspace
  }

  it('waits visibly for the whole call, then repaints from the status after it', async () => {
    const workspace = await connected()
    workspace.holdDisconnect = true

    await click(/^Log out/)

    const waiting = screen.getByRole('button', { name: /^Log out/ })
    expect(waiting).toBeDisabled()
    expect(waiting).toHaveTextContent('Logging out…')

    workspace.research = SIGNED_OUT
    await act(async () => {
      workspace.settleDisconnect()
    })
    await settled()

    expect(rows()[1]).toContain('Not connected')
    expect(rows()[2]).toContain('—')
    expect(screen.getByRole('button', { name: /^Connect/ })).toBeEnabled()
  })

  it('takes no confirmation step', async () => {
    const workspace = await connected()

    await click(/^Log out/)

    expect(screen.queryByRole('dialog', { name: /sure/i })).toBeNull()
    expect(opsOn(workspace)).toContain('researchDisconnect')
  })

  it('puts a refusal in the pane’s own alert line and leaves the rows alone', async () => {
    const workspace = await connected()
    workspace.disconnectOutcome = {
      kind: 'refused',
      message: redactKeys('Error logging out: EACCES')
    }

    await click(/^Log out/)

    expect(screen.getByRole('alert')).toHaveTextContent('Error logging out: EACCES')
    expect(dialog()).toBeNull()
    expect(rows()[1]).toContain('Connected')
    expect(rows()[2]).toContain('12,500 credits remaining')
  })
})
