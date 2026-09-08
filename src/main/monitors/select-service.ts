import { join } from 'node:path'
import type { SessionId } from '../../shared/agent/port'
import type { DeliverMonitorMessage, MainMonitorService } from '../../shared/monitors/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { createCheckRunner } from './check-runner'
import { createMonitorModel } from './model'
import { createScriptedCheckRunner } from './scripted-checks'
import { createMonitorStore } from './store'

export interface MonitorWiring {
  readonly stateDir: string
  readonly deliver: DeliverMonitorMessage
  readonly sessionExists: (sessionId: SessionId) => boolean
}

export function selectMonitorService(
  flavor: Flavor,
  log: LogSink,
  wiring: MonitorWiring
): MainMonitorService {
  log.append({ source: 'main', event: 'monitor_service_selected', service: flavor })

  return createMonitorModel({
    store: createMonitorStore(join(wiring.stateDir, 'monitors.json'), (cause) => {
      log.append({
        source: 'main',
        event: 'monitor_store_write_failed',
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }),
    checks: flavor === 'sdk' ? createCheckRunner() : createScriptedCheckRunner(),
    deliver: wiring.deliver,
    sessionExists: wiring.sessionExists,
    log: (event) => log.append({ source: 'main', event: 'monitor', ...event })
  })
}
