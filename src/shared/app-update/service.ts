// The installed app's update seam. Main watches the bundle on disk for a
// newer build (install-stable replaces it in place while the app runs) and
// the renderer offers one button: restart into it. Dev launches serve the
// still service, which never has anything to say.

export type Unsubscribe = () => void

/** A newer build is sitting in the installed bundle than the one running. */
export interface UpdateReady {
  readonly type: 'update_ready'
  /** The short commit the waiting build was made from. */
  readonly commit: string
}

export type AppUpdateListener = (event: UpdateReady) => void

export interface AppUpdateService {
  /** The waiting build's commit, or null while the running one is current. */
  pending(): Promise<string | null>
  /** Relaunch into whatever build the bundle now holds. */
  restart(): Promise<void>
  onEvent(listener: AppUpdateListener): Unsubscribe
}
