// @vitest-environment jsdom
//
// The preload surface is a stand-in, because this side of the boundary is all a
// document can see.
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRequest, CommandResult } from '../../../shared/commands/channels'
import { createCommandClient } from './ipc-client'

function install(answer: (request: CommandRequest) => CommandResult): CommandRequest[] {
  const requests: CommandRequest[] = []
  window.crucible = {
    commands: {
      request: async (request: CommandRequest) => {
        requests.push(request)
        return answer(request)
      }
    }
  }
  return requests
}

afterEach(() => {
  delete window.crucible
})

describe('the command client', () => {
  it('carries an operation across as one named request', async () => {
    const requests = install(() => ({
      ok: true,
      value: [{ name: 'align', description: 'Grill an idea', origin: 'built-in' }]
    }))

    await expect(createCommandClient().list('/repos/crucible')).resolves.toEqual([
      { name: 'align', description: 'Grill an idea', origin: 'built-in' }
    ])
    expect(requests).toEqual([{ op: 'list', args: ['/repos/crucible'] }])
  })

  it('asks for an expansion with the whole draft, and answers with the delivered text', async () => {
    const requests = install(() => ({
      ok: true,
      value: { kind: 'command', name: 'align', origin: 'built-in', text: 'Interview me about x.' }
    }))

    await expect(
      createCommandClient().expand('/repos/crucible', '/align x')
    ).resolves.toMatchObject({ kind: 'command', text: 'Interview me about x.' })
    expect(requests).toEqual([{ op: 'expand', args: ['/repos/crucible', '/align x'] }])
  })

  it('turns a refused result back into a rejection a person can read', async () => {
    install(() => ({ ok: false, message: 'That command could not be read.' }))

    await expect(createCommandClient().expand('/repos/crucible', '/gone')).rejects.toThrow(
      'That command could not be read.'
    )
  })

  it('says plainly when the preload never loaded', () => {
    expect(() => createCommandClient()).toThrow('window.crucible.commands is missing')
  })
})
