// @vitest-environment node
//
// The flavor an agent-driven check drives: every answer is canned, so what
// those checks rely on is pinned here.
import { describe, expect, it } from 'vitest'
import { createFakeCommandService, FAKE_UNREADABLE_COMMAND } from './fake-service'

const WORKSPACE = '/repos/crucible'

describe('the fake command service', () => {
  it('serves all three origins, with hints, alphabetically', async () => {
    const listed = await createFakeCommandService().list(WORKSPACE)

    expect(listed.map((command) => `${command.name}:${command.origin}`)).toEqual([
      'align:built-in',
      'component:workspace',
      'review:user',
      'standup:workspace'
    ])
    expect(listed.find((command) => command.name === 'align')?.argumentHint).toBe('[subject]')
    expect(listed.find((command) => command.name === 'standup')?.argumentHint).toBeUndefined()
  })

  it('expands with the same grammar the real service uses', async () => {
    const service = createFakeCommandService()

    await expect(
      service.expand(WORKSPACE, '/component Button "click handler"')
    ).resolves.toEqual({
      kind: 'command',
      name: 'component',
      origin: 'workspace',
      text: 'Create a React component named Button with features: click handler'
    })
    // The default form, which the shipped /align leans on.
    await expect(service.expand(WORKSPACE, '/align')).resolves.toMatchObject({
      text: expect.stringContaining('(none given — make asking for it your first question)')
    })
  })

  it('answers plain for a draft that names no command', async () => {
    const service = createFakeCommandService()

    await expect(service.expand(WORKSPACE, '/nothing at all')).resolves.toEqual({ kind: 'plain' })
    await expect(service.expand(WORKSPACE, 'an ordinary message')).resolves.toEqual({
      kind: 'plain'
    })
  })

  it('keeps one draft that refuses, so the failure path is drivable too', async () => {
    await expect(
      createFakeCommandService().expand(WORKSPACE, `/${FAKE_UNREADABLE_COMMAND} now`)
    ).rejects.toThrow('That command file could not be read.')
  })
})
