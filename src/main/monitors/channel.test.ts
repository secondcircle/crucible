// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { MonitorService } from '../../shared/monitors/service'
import { invoke } from './channel'

function serviceRecorder(): MonitorService {
  return {
    snapshot: vi.fn(async () => ({ monitors: [] })),
    onEvent: () => () => {},
    stop: vi.fn(async () => {})
  }
}

describe('the monitor channel', () => {
  it('carries the snapshot and the stop, and nothing else', async () => {
    const service = serviceRecorder()

    await invoke(service, { op: 'snapshot', args: [] })
    expect(service.snapshot).toHaveBeenCalled()
    await invoke(service, { op: 'stop', args: ['m-1f3a'] })
    expect(service.stop).toHaveBeenCalledWith('m-1f3a')
  })

  it('refuses an operation it does not have', async () => {
    await expect(invoke(serviceRecorder(), { op: 'set', args: [] })).rejects.toThrow(
      /does not do/
    )
  })

  it('refuses a request that is not one', async () => {
    await expect(invoke(serviceRecorder(), 'stop')).rejects.toThrow(/has to be an object/)
    await expect(invoke(serviceRecorder(), { args: [] })).rejects.toThrow(/name an operation/)
  })

  it('refuses a stop that names no monitor', async () => {
    const service = serviceRecorder()
    await expect(invoke(service, { op: 'stop', args: [42] })).rejects.toThrow(/needs text/)
    expect(service.stop).not.toHaveBeenCalled()
  })
})
