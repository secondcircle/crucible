// The app's version seam. One snapshot answers every question the surfaces
// ask: which version is running, whether the registry holds a newer one, and
// whether a newer one is already on disk waiting for a restart.
//
// A dev launch cannot carry an update state at all — that is the type's job,
// not a rule anybody has to remember: updates are not checked in dev, so
// there is nothing an update state could truthfully say there.

export type Unsubscribe = () => void

export type UpdateStatus =
  /** No check has answered yet. The strip claims nothing on no evidence. */
  | { readonly kind: 'unchecked' }
  /** The registry's latest is not newer than what runs. */
  | { readonly kind: 'current' }
  /** A newer version is assembled into the bundle; a restart picks it up. */
  | { readonly kind: 'ready'; readonly version: string }

export type AppVersionState =
  | { readonly kind: 'dev'; readonly version: string; readonly commit?: string }
  | {
      readonly kind: 'installed'
      readonly version: string
      readonly update: UpdateStatus
    }

export type AppVersionListener = (state: AppVersionState) => void

export interface AppUpdateService {
  /** The whole snapshot, asked once at mount so nothing announced early is lost. */
  state(): Promise<AppVersionState>
  /** Relaunch into whatever the bundle now holds. Only ever the human's click. */
  restart(): Promise<void>
  /**
   * One check now, the same one the poll runs, settled when it is over:
   * announced ready, announced current, or failed quietly. A check already
   * in flight is the one waited for; nothing is asked twice.
   */
  check(): Promise<void>
  onEvent(listener: AppVersionListener): Unsubscribe
}
