import type { WorkflowLoader } from '../workflows/loader'
import type { DeclaredSchedule } from './scheduler'

// Where the scheduler's declarations come from: the workflow files, read
// through the loader, which re-reads a file the moment it changes, so an
// edited schedule is live by the next evaluation and a deleted one stops
// existing.
//
// Only repo workflows carry schedules: a `schedule` field on a user workflow
// is ignored — not fired, not listed, no error. It would otherwise fire in
// every workspace at once. The loader is asked for workspace files only, so a
// user workflow is not even read: this runs every 30 seconds per open
// workspace, and reading a manifest starts a host that runs the file's
// module body.

export function loaderSchedules(
  loader: WorkflowLoader
): (workspacePath: string) => Promise<readonly DeclaredSchedule[]> {
  return async (workspacePath: string) => {
    const listed = await loader.list(workspacePath, 'workspace')
    const declared: DeclaredSchedule[] = []
    for (const workflow of listed) {
      const schedule = workflow.manifest.schedule
      if (schedule === undefined) continue
      declared.push({
        workflow: workflow.name,
        description: workflow.manifest.description,
        // A cron that is not even text is an expression Crucible cannot fire,
        // which the scheduler says on the board rather than throwing here.
        cron: schedule.cron ?? '',
        declaresInputs: Object.keys(workflow.manifest.inputs).length > 0,
        ...(schedule.checks
          ? {
              // The file's check, run in a host of its own for the one
              // question and stopped after it — or when the scheduler stops
              // waiting, so a check that hangs is a process that ends rather
              // than one that stays.
              check: async ({ workspacePath: at, signal }) => {
                const host = workflow.open()
                const stop = (): void => host.kill()
                signal?.addEventListener('abort', stop, { once: true })
                try {
                  return await host.scheduleCheck(at)
                } finally {
                  signal?.removeEventListener('abort', stop)
                  host.kill()
                }
              }
            }
          : {})
      })
    }
    return declared
  }
}
