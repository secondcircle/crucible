// @vitest-environment jsdom
//
// Driven over the scripted port, so a login Crucible only renders and usage
// summed from what the port answers cost no SDK call and no network.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProviderState, SessionUsage, ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedCommands } from './testing/scripted-commands'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { settled } from './testing/settled'

const PROVIDERS: readonly ProviderState[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    methods: ['oauth', 'api-key'],
    status: { kind: 'oauth', detail: 'Claude subscription' }
  },
  { id: 'openai', name: 'OpenAI', methods: ['api-key'], status: { kind: 'api-key' } },
  {
    id: 'google',
    name: 'Google',
    methods: ['api-key'],
    status: { kind: 'env', variable: 'GEMINI_API_KEY' }
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    methods: ['oauth', 'api-key'],
    status: { kind: 'none' }
  }
]

function usage(scale: number): SessionUsage {
  return {
    messages: 12 * scale,
    input: { tokens: 4_210 * scale, cost: 0.06 * scale },
    output: { tokens: 18_772 * scale, cost: 0.56 * scale },
    cacheRead: { tokens: 36_900 * scale, cost: 0.11 * scale },
    cacheWrite: { tokens: 2_100 * scale, cost: 0.11 * scale },
    totalTokens: 61_982 * scale,
    totalCost: 0.84 * scale
  }
}

const TWO_SESSIONS: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    {
      id: 's1',
      workspaceId: 'w1',
      createdAt: '2026-08-19T14:14:00.000Z',
      working: false,
      fresh: false,
      usage: { usedTokens: 62_000, contextWindow: 200_000, cost: 0.84 }
    },
    { id: 's2', workspaceId: 'w1', createdAt: '2026-08-19T15:20:00.000Z', working: false, fresh: false }
  ],
  activeSessionId: 's1'
}

async function shell(snapshot: Partial<ShellSnapshot> = oneSession()): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  port.providers = PROVIDERS
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

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
  await settled()
}

async function escape(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  await settled()
}

const sheet = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Settings' })

const providerRows = (): string[] =>
  Array.from(document.querySelectorAll('.prov')).map((row) => row.textContent ?? '')

const cards = (): string[] =>
  Array.from(document.querySelectorAll('.card')).map((card) => card.textContent ?? '')

const cell = (table: string, row: string): string[] => {
  const found = within(screen.getByRole('table', { name: table }))
    .getAllByRole('row')
    .find((line) => line.textContent?.startsWith(row))
  return Array.from(found?.querySelectorAll('td') ?? []).map((td) => td.textContent ?? '')
}

describe('reaching the settings surface', () => {
  it('opens on Providers from the gear, with no workspace and no session', async () => {
    await shell({ workspaces: [], sessions: [] })

    await click('Settings')

    expect(sheet()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Providers' })).toHaveAttribute(
      'aria-current',
      'true'
    )
  })

  it('shows the cost chip only with a session, and a dash until cost is reported', async () => {
    const port = await shell({ workspaces: [], sessions: [] })
    expect(screen.queryByRole('button', { name: 'Session cost' })).toBeNull()

    await act(async () => {
      port.update(() => TWO_SESSIONS)
    })
    expect(screen.getByRole('button', { name: 'Session cost' })).toHaveTextContent('$0.84')

    await act(async () => {
      port.update((snapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === 's1'
            ? { ...session, usage: { usedTokens: 62_000, contextWindow: 200_000 } }
            : session
        )
      }))
    })
    expect(screen.getByRole('button', { name: 'Session cost' })).toHaveTextContent('—')
  })

  it('lands on the Usage tab from the chip', async () => {
    await shell(TWO_SESSIONS)

    await click('Session cost')

    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('table', { name: 'This session' })).toBeInTheDocument()
  })

  it('closes the login dialog before the sheet, and the sheet before anything else', async () => {
    const port = await shell(TWO_SESSIONS)
    port.trees.set('s1', { roots: [], path: [] })
    await click('Settings')
    await click('Add provider')
    await click(/OpenRouter/)
    await click('Use an API key')

    expect(screen.getByRole('dialog', { name: 'Log in to OpenRouter' })).toBeInTheDocument()

    await escape()
    expect(screen.queryByRole('dialog', { name: 'Log in to OpenRouter' })).toBeNull()
    expect(sheet()).not.toBeNull()
    expect(port.calls.map((call) => call.op)).toContain('cancelLogin')

    await escape()
    expect(sheet()).toBeNull()
    // Nothing else Escape does fired while the sheet was taking the presses.
    expect(port.calls.map((call) => call.op)).not.toContain('sessionTree')
  })
})

describe('the providers tab', () => {
  it('shows one row per credentialed provider, and nothing for the rest', async () => {
    await shell(TWO_SESSIONS)

    await click('Settings')

    expect(providerRows()).toEqual([
      'AnthropicSigned in — Claude subscriptionLog out',
      'OpenAIAPI key storedLog out',
      'GoogleAPI key from environment (GEMINI_API_KEY) — managed outside CrucibleLog out'.replace(
        'Log out',
        '—'
      )
    ])
  })

  it('leaves an environment key alone, with no action to take', async () => {
    await shell(TWO_SESSIONS)
    await click('Settings')

    expect(
      screen.getByRole('button', { name: 'Google is managed outside Crucible' })
    ).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Log out of Google' })).toBeNull()
  })

  it('logs out through the port, then reads the providers again', async () => {
    const port = await shell(TWO_SESSIONS)
    await click('Settings')

    await click('Log out of OpenAI')

    expect(port.calls).toContainEqual({ op: 'logout', args: ['openai'] })
    expect(port.calls.filter((call) => call.op === 'listProviders').length).toBeGreaterThan(1)
    // The models a credential unlocked are read again too.
    expect(port.calls.filter((call) => call.op === 'listModels').length).toBeGreaterThan(1)
  })

  it('offers only the providers with no credential behind the picker', async () => {
    await shell(TWO_SESSIONS)
    await click('Settings')

    await click('Add provider')

    const picker = screen.getByRole('dialog', { name: 'Add provider' })
    expect(within(picker).getByText('OpenRouter')).toBeInTheDocument()
    expect(within(picker).queryByText('Anthropic')).toBeNull()
    expect(within(picker).getByText('OAuth · API key')).toBeInTheDocument()
  })
})

describe('a login', () => {
  async function started(): Promise<ScriptedPort> {
    const port = await shell(TWO_SESSIONS)
    await click('Settings')
    await click('Add provider')
    await click(/OpenRouter/)
    await click('Sign in with OAuth')
    return port
  }

  it('asks π for the flow and renders what it says', async () => {
    const port = await started()

    expect(port.calls).toContainEqual({ op: 'login', args: ['openrouter', 'oauth'] })

    await act(async () => {
      port.authNotice({
        kind: 'auth-url',
        message: 'Your browser opened for authorization.',
        url: 'https://example.invalid/authorize'
      })
      port.authPrompt({
        promptId: 'p1',
        kind: 'manual-code',
        message: 'Paste the redirect URL or code here:',
        placeholder: 'https://…/callback?code=…'
      })
    })

    expect(screen.getByText('Your browser opened for authorization.')).toBeInTheDocument()
    expect(screen.getByText('https://example.invalid/authorize')).toBeInTheDocument()
    expect(screen.getByLabelText('Paste the redirect URL or code here:')).toBeInTheDocument()
  })

  it('sends the answer back and, on success, refreshes the list and the models', async () => {
    const port = await started()
    await act(async () => {
      port.authPrompt({ promptId: 'p1', kind: 'secret', message: 'Paste your API key.' })
    })

    const field = screen.getByLabelText('Paste your API key.')
    expect(field).toHaveAttribute('type', 'password')
    await act(async () => {
      fireEvent.change(field, { target: { value: 'sk-anything' } })
    })
    await click('Continue')

    expect(port.calls).toContainEqual({ op: 'answerAuthPrompt', args: ['p1', 'sk-anything'] })

    port.providers = PROVIDERS.map((provider) =>
      provider.id === 'openrouter'
        ? { ...provider, status: { kind: 'api-key' as const } }
        : provider
    )
    await act(async () => {
      port.finishLogin('succeeded')
    })
    await settled()

    expect(screen.queryByRole('dialog', { name: 'Log in to OpenRouter' })).toBeNull()
    expect(providerRows().some((row) => row.startsWith('OpenRouter'))).toBe(true)
    expect(port.calls.filter((call) => call.op === 'listModels').length).toBeGreaterThan(1)
  })

  it('dismisses a question the flow resolved another way', async () => {
    const port = await started()
    await act(async () => {
      port.authPrompt({ promptId: 'p1', kind: 'manual-code', message: 'Paste the code:' })
    })
    expect(screen.getByLabelText('Paste the code:')).toBeInTheDocument()

    await act(async () => {
      port.closeAuthPrompt('p1')
    })

    expect(screen.queryByLabelText('Paste the code:')).toBeNull()
    expect(port.calls.map((call) => call.op)).not.toContain('answerAuthPrompt')
  })

  it('says why it failed, and adds nothing to the list', async () => {
    const port = await started()

    await act(async () => {
      port.finishLogin({ failure: 'That key was refused. Nothing was saved.' })
    })
    await settled()

    expect(screen.getByRole('alert')).toHaveTextContent('That key was refused.')
    expect(providerRows().some((row) => row.startsWith('OpenRouter'))).toBe(false)

    await click('Close')
    expect(screen.queryByRole('dialog', { name: 'Log in to OpenRouter' })).toBeNull()
  })

  it('is quiet when the user cancels it', async () => {
    const port = await started()

    await click('Cancel')

    expect(port.calls.map((call) => call.op)).toContain('cancelLogin')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Log in to OpenRouter' })).toBeNull()
  })

  it('refuses a second flow while one is live', async () => {
    const port = await started()
    const started_ = port.calls.filter((call) => call.op === 'login').length

    await click('Log out of OpenAI')
    await click('Add provider')

    // The sheet behind the dialog is still there to click through, and it
    // says plainly that one login is enough.
    expect(port.calls.filter((call) => call.op === 'login')).toHaveLength(started_)
  })
})

describe('the usage tab', () => {
  it('shows dashes everywhere until something has been reported', async () => {
    await shell(TWO_SESSIONS)

    await click('Session cost')

    expect(cell('This session', 'Input')).toEqual(['Input', '—', '—'])
    expect(cell('This session', 'Total')).toEqual(['Total', '—', '—'])
    expect(cell('Sessions in this workspace', 'Workspace total')).toEqual([
      'Workspace total',
      '—',
      '—',
      '—'
    ])
    // The meter's percentage is the one number that is known.
    expect(screen.getByText('31%')).toBeInTheDocument()
  })

  it('fills the cards and both tables from what the port summed', async () => {
    const port = await shell(TWO_SESSIONS)
    port.usage.set('s1', usage(1))
    port.usage.set('s2', usage(2))

    await click('Session cost')

    expect(port.calls).toContainEqual({ op: 'sessionUsage', args: ['s1'] })
    expect(cards()).toEqual(['Cost$0.84', 'Tokens61,982', 'Messages12', 'Context31%'])
    expect(cell('This session', 'Cache read')).toEqual(['Cache read', '36,900', '$0.11'])
    expect(cell('This session', 'Total')).toEqual(['Total', '61,982', '$0.84'])

    // Every curated session of the workspace, and the workspace's own total.
    expect(cell('Sessions in this workspace', 'Session · ')).toHaveLength(4)
    expect(cell('Sessions in this workspace', 'Workspace total')).toEqual([
      'Workspace total',
      '36',
      '185.9k',
      '$2.52'
    ])
  })

  it('leaves a session that reported nothing out of the totals', async () => {
    const port = await shell(TWO_SESSIONS)
    port.usage.set('s1', usage(1))

    await click('Session cost')

    expect(cell('Sessions in this workspace', 'Workspace total')).toEqual([
      'Workspace total',
      '12',
      '62k',
      '$0.84'
    ])
  })

  it('reads again at a turn boundary in this workspace', async () => {
    const port = await shell(TWO_SESSIONS)
    port.usage.set('s1', usage(1))
    await click('Session cost')
    const before = port.calls.filter((call) => call.op === 'sessionUsage').length

    port.usage.set('s1', usage(2))
    await act(async () => {
      void port.prompt('s1', 'another turn')
    })
    await act(async () => {
      port.endTurn('s1')
    })
    await settled()

    expect(port.calls.filter((call) => call.op === 'sessionUsage').length).toBeGreaterThan(before)
    expect(cell('This session', 'Total')).toEqual(['Total', '123,964', '$1.68'])
  })

  it('says so plainly with no session, and with no workspace at all', async () => {
    const port = await shell({
      workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
      activeWorkspaceId: 'w1',
      sessions: []
    })

    await click('Settings')
    await click('Usage')

    expect(screen.getByText('No session is active in this workspace.')).toBeInTheDocument()
    expect(screen.getByText('This workspace has no sessions yet.')).toBeInTheDocument()

    await act(async () => {
      port.update(() => ({ workspaces: [], sessions: [] }))
    })

    expect(
      screen.getByText('No workspace is open, so there is nothing to add up yet.')
    ).toBeInTheDocument()
  })
})
