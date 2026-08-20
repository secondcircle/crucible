import { createFakeQuotaService } from '../../shared/quota/fake-service'
import type { QuotaService } from '../../shared/quota/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { createPiCredentials } from './pi-credentials'
import { createQuotaService } from './service'
import { createQuotaStore } from './store'

export type QuotaServiceKind = 'canned' | 'live'

// Pure, so the rule is testable without constructing anything. The flavor
// already chosen for the adapter decides here too, which keeps exactly one
// reader of `CRUCIBLE_AGENT` in the app.
export function quotaServiceKind(flavor: Flavor): QuotaServiceKind {
  return flavor === 'sdk' ? 'live' : 'canned'
}

// A fake-flavor launch reads no credential, opens no socket and never touches
// the cache the machine's apps share.
export function selectQuotaService(flavor: Flavor, log: LogSink): QuotaService {
  const kind = quotaServiceKind(flavor)
  log.append({ source: 'main', event: 'quota_service_selected', service: kind })

  if (kind === 'canned') return createFakeQuotaService()

  const credentials = createPiCredentials()
  return createQuotaService(
    createQuotaStore({
      getAuth: (providerId) => credentials.getAuth(providerId),
      credentialType: (providerId) => credentials.credentialType(providerId),
      // Fetch health is a fact about the machine, so it reaches the run log and
      // the UI only through the data's own age.
      log: (message) => log.append({ source: 'main', event: 'quota', message })
    })
  )
}
