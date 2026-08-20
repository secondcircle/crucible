import { createFakeQuotaService } from '../../shared/quota/fake-service'
import type { QuotaService } from '../../shared/quota/service'
import type { Flavor } from '../agent/select-adapter'
import type { LogSink } from '../log/sink'
import { createPiCredentials } from './pi-credentials'
import { createQuotaService } from './service'
import { createQuotaStore } from './store'

/** Which quota service a launch gets: canned numbers, or the machine's own. */
export type QuotaServiceKind = 'canned' | 'live'

// Pure, so the rule is testable without constructing anything: the launch
// flavor already decided for the adapter decides the quota service too, which
// is what keeps exactly one reader of `CRUCIBLE_AGENT` in the app.
export function quotaServiceKind(flavor: Flavor): QuotaServiceKind {
  return flavor === 'sdk' ? 'live' : 'canned'
}

// One flavor decision governs every seam, so a fake-flavor launch reads no
// credential, opens no socket and never touches the cache the machine's apps
// share. The SDK flavor and the packaged app read for real.
export function selectQuotaService(flavor: Flavor, log: LogSink): QuotaService {
  const kind = quotaServiceKind(flavor)
  log.append({ source: 'main', event: 'quota_service_selected', service: kind })

  if (kind === 'canned') return createFakeQuotaService()

  const credentials = createPiCredentials()
  return createQuotaService(
    createQuotaStore({
      getAuth: (providerId) => credentials.getAuth(providerId),
      credentialType: (providerId) => credentials.credentialType(providerId),
      // Fetch health is a fact about the machine, not about the app: it goes to
      // the run log, and nothing about it ever reaches the UI except through
      // the data's own age.
      log: (message) => log.append({ source: 'main', event: 'quota', message })
    })
  )
}
