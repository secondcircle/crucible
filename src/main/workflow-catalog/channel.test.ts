// @vitest-environment node
//
// Plumbing only, checked as plumbing: names dispatch, malformed requests are
// refused, and a reader the renderer sends is made sound before it goes on.
import { describe, expect, it, vi } from 'vitest'
import type { MainWorkflowCatalogService } from '../../shared/workflows/catalog'
import { DEFAULT_CATALOG_READER } from '../../shared/workflows/catalog-settings'
import { invoke } from './channel'

function serviceRecorder(): MainWorkflowCatalogService {
  return {
    snapshot: vi.fn(async () => ({ reader: DEFAULT_CATALOG_READER, workspaces: [] })),
    open: vi.fn(async () => {}),
    setReader: vi.fn(async () => {}),
    onEvent: () => () => {},
    dispose: () => {}
  }
}

describe('the workflow catalog channel', () => {
  it('dispatches the read and the two commands', async () => {
    const service = serviceRecorder()

    await invoke(service, { op: 'snapshot', args: [] })
    expect(service.snapshot).toHaveBeenCalled()

    await invoke(service, { op: 'open', args: ['/repos/crucible'] })
    expect(service.open).toHaveBeenCalledWith('/repos/crucible')

    await invoke(service, {
      op: 'setReader',
      args: [{ model: 'anthropic/claude-haiku-5', effort: 'low' }]
    })
    expect(service.setReader).toHaveBeenCalledWith({
      model: 'anthropic/claude-haiku-5',
      effort: 'low'
    })
  })

  it('refuses anything it was not asked in the shape it takes', async () => {
    const service = serviceRecorder()
    await expect(invoke(service, 'snapshot')).rejects.toThrow(/has to be an object/)
    await expect(invoke(service, {})).rejects.toThrow(/name an operation/)
    await expect(invoke(service, { op: 'open', args: [''] })).rejects.toThrow(/workspace folder/)
    await expect(invoke(service, { op: 'setReader', args: ['opus'] })).rejects.toThrow(
      /a model and an effort/
    )
    await expect(invoke(service, { op: 'reread', args: [] })).rejects.toThrow(/does not do/)
  })

  it('makes an odd reader sound rather than passing it on', async () => {
    const service = serviceRecorder()
    await invoke(service, { op: 'setReader', args: [{ model: 'no provider', effort: 7 }] })
    expect(service.setReader).toHaveBeenCalledWith(DEFAULT_CATALOG_READER)
  })
})
