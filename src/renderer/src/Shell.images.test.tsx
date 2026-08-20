// @vitest-environment jsdom
//
// Images ride the prompt they were attached to, and nothing else: an image is
// never dropped silently and never appears on a message that did not carry it.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ShellSnapshot } from '../../shared/agent/port'
import { Shell } from './Shell'
import { createScriptedPort, oneSession, type ScriptedPort } from './testing/scripted-port'
import { createScriptedWorkspace } from './testing/scripted-workspace'
import { createScriptedCommands } from './testing/scripted-commands'
import { settled } from './testing/settled'

const TWO_SESSIONS: ShellSnapshot = {
  workspaces: [{ id: 'w1', name: 'crucible', path: '/repos/crucible' }],
  activeWorkspaceId: 'w1',
  sessions: [
    { id: 's1', workspaceId: 'w1', createdAt: '2026-08-19T14:14:00.000Z', working: false },
    { id: 's2', workspaceId: 'w1', createdAt: '2026-08-19T15:20:00.000Z', working: false }
  ],
  activeSessionId: 's1'
}

/** A PNG of four bytes: enough to be read, small enough to be readable. */
function png(name = 'screenshot.png', bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

async function shell(snapshot: Partial<ShellSnapshot> = oneSession()): Promise<ScriptedPort> {
  const port = createScriptedPort(snapshot)
  port.models = [{ id: 'fake/deterministic', label: 'Fake', thinkingLevels: ['off'] }]
  render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
  if ((snapshot.sessions ?? []).length > 0) {
    await screen.findAllByRole('button', { name: /^Session · / })
  } else {
    await screen.findByText('No workspace yet.')
  }
  await settled()
  return port
}

/** The clipboard as the browser hands it over: items, each holding a file. */
function clipboard(files: readonly File[]): Event {
  const pasted = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(pasted, 'clipboardData', {
    value: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file }))
    }
  })
  return pasted
}

// The bytes are read through promises this test does not own, so counting
// ticks would be guesswork; a task boundary settles the chain whatever it is.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function paste(...files: readonly File[]): Promise<void> {
  await act(async () => {
    fireEvent(document, clipboard(files))
  })
  await settle()
}

async function drop(...files: readonly File[]): Promise<void> {
  await act(async () => {
    fireEvent.drop(window, { dataTransfer: { files } })
  })
  await settle()
}

const chips = (): string[] =>
  Array.from(document.querySelectorAll('.imgchip img')).map(
    (chip) => chip.getAttribute('alt') ?? ''
  )

const box = (): HTMLElement => screen.getByLabelText('Message')

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box(), { target: { value: text } })
  })
}

describe('attaching', () => {
  it('takes an image off the clipboard and shows it as a chip', async () => {
    await shell()

    await paste(png())

    expect(chips()).toEqual(['screenshot.png'])
  })

  it('leaves a text paste alone', async () => {
    await shell()

    await act(async () => {
      fireEvent(document, clipboard([]))
    })

    expect(chips()).toEqual([])
  })

  it('takes every image in a drop, and shows the veil while dragging', async () => {
    await shell()

    await act(async () => {
      fireEvent.dragOver(window)
    })
    expect(screen.getByText('Drop images to attach')).toBeInTheDocument()

    await drop(png('one.png'), png('two.png'))

    expect(screen.queryByText('Drop images to attach')).toBeNull()
    expect(chips()).toEqual(['one.png', 'two.png'])
  })

  it('shows no veil and attaches nothing with no session', async () => {
    await shell({ workspaces: [], sessions: [] })

    await act(async () => {
      fireEvent.dragOver(window)
    })
    await drop(png())

    expect(screen.queryByText('Drop images to attach')).toBeNull()
    expect(chips()).toEqual([])
  })

  it('refuses an oversize image out loud, naming the file and the reason', async () => {
    await shell()

    await drop(png('huge.png', 11 * 1024 * 1024))

    expect(screen.getByRole('alert')).toHaveTextContent('huge.png')
    expect(screen.getByRole('alert')).toHaveTextContent('over the 10 MB limit')
    expect(chips()).toEqual([])
  })

  it('refuses a file that is not an image Crucible can send', async () => {
    await shell()

    await drop(new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' }))

    expect(screen.getByRole('alert')).toHaveTextContent('notes.pdf')
    expect(chips()).toEqual([])
  })

  it('removes a chip on its ×', async () => {
    await shell()
    await paste(png('one.png'), png('two.png'))

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove one.png'))
    })

    expect(chips()).toEqual(['two.png'])
  })

  it('follows the session the way a draft does', async () => {
    const port = await shell(TWO_SESSIONS)
    await paste(png('for-the-first.png'))

    await act(async () => {
      await port.activateSession('s2')
    })
    expect(chips()).toEqual([])

    await act(async () => {
      await port.activateSession('s1')
    })
    expect(chips()).toEqual(['for-the-first.png'])
  })
})

describe('sending', () => {
  it('carries the chips on the prompt and renders them on the sent message', async () => {
    const port = await shell()
    await paste(png())
    await type('what is in this screenshot?')

    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })

    const sent = port.calls.find((call) => call.op === 'prompt')
    expect(sent?.args).toEqual([
      's1',
      'what is in this screenshot?',
      [{ mimeType: 'image/png', data: 'AAAAAA==' }]
    ])
    expect(chips()).toEqual([])
    expect(screen.getByAltText('Attached image 1')).toBeInTheDocument()
  })

  it('shows the same thumbnails on a restored transcript', async () => {
    const port = createScriptedPort(oneSession())
    port.transcripts.set('s1', [
      {
        kind: 'user',
        text: 'what is in this screenshot?',
        images: [{ mimeType: 'image/png', data: 'AAAAAA==' }]
      }
    ])
    render(<Shell
      port={port}
      workspace={createScriptedWorkspace()}
      commands={createScriptedCommands()}
    />)
    await screen.findByText('what is in this screenshot?')

    expect(screen.getByAltText('Attached image 1')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAAAA=='
    )
  })

  it('sends nothing for chips alone: some text is still required', async () => {
    const port = await shell()
    await paste(png())

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    expect(port.calls.map((call) => call.op)).not.toContain('prompt')
  })
})

describe('while the session works', () => {
  async function working(): Promise<ScriptedPort> {
    const port = await shell()
    await type('write the adapter')
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    return port
  }

  it('holds images back rather than dropping them from a steering message', async () => {
    const port = await working()
    await paste(png())
    await type('and look at this')

    const steer = screen.getByRole('button', { name: 'Steer ⏎' })
    expect(steer).toBeDisabled()
    expect(screen.getByText(/images go with the next prompt/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    })
    expect(port.calls.map((call) => call.op)).not.toContain('steer')
    expect(chips()).toEqual(['screenshot.png'])
  })

  it('lets the chips be added and taken off again while it works', async () => {
    await working()
    await paste(png())

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Remove screenshot.png'))
    })

    expect(chips()).toEqual([])
    expect(screen.getByRole('button', { name: 'Steer ⏎' })).toBeDisabled()
  })
})
