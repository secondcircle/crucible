// @vitest-environment node
//
// Electron and the service are both stand-ins here: what a command means is
// tested where it lives, and what is left is plumbing.
import { describe, expect, it } from 'vitest'
import type { CommandService } from '../../shared/commands/service'
import { invoke } from './channel'

const service: CommandService = {
  async list(workspacePath: string) {
    return [{ name: 'align', description: `for ${workspacePath}`, origin: 'built-in' as const }]
  },
  async expand(workspacePath: string, draft: string) {
    if (draft === '/gone') throw new Error('The file behind /gone could not be read.')
    if (!draft.startsWith('/')) return { kind: 'plain' as const }
    return {
      kind: 'command' as const,
      name: 'align',
      origin: 'built-in' as const,
      text: `${workspacePath}:${draft}`
    }
  }
}

describe('what crosses the command channel', () => {
  it('carries an operation through by its own name', async () => {
    await expect(invoke(service, { op: 'list', args: ['/repos/crucible'] })).resolves.toEqual([
      { name: 'align', description: 'for /repos/crucible', origin: 'built-in' }
    ])
    await expect(
      invoke(service, { op: 'expand', args: ['/repos/crucible', '/align now'] })
    ).resolves.toMatchObject({ kind: 'command', text: '/repos/crucible:/align now' })
  })

  it('refuses anything that is not a request this service serves', async () => {
    await expect(invoke(service, null)).rejects.toThrow('A request has to be an object.')
    await expect(invoke(service, {})).rejects.toThrow('A request has to name an operation.')
    await expect(invoke(service, { op: 'list', args: [7] })).rejects.toThrow(
      'list needs text where it was given none.'
    )
    await expect(invoke(service, { op: 'prompt', args: [] })).rejects.toThrow(
      'Crucible was asked for something its command service does not do.'
    )
  })

  it('lets the service\u2019s own refusal through, for the channel to make safe', async () => {
    await expect(invoke(service, { op: 'expand', args: ['/repos/crucible', '/gone'] })).rejects.toThrow(
      'The file behind /gone could not be read.'
    )
  })
})
