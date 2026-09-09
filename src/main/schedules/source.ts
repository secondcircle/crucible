import type { WorkflowLoader } from '../workflows/loader'
import type { DeclaredSchedule } from './scheduler'

// Where the scheduler's declarations come from: the workflow files, read
// through the loader whose module cache is off, so an edited schedule is live
// by the next evaluation and a deleted one stops existing.
//
// Only repo workflows carry schedules: a `schedule` field on a user workflow
// is ignored — not fired, not listed, no error. It would otherwise fire in
// every workspace at once. The loader is asked for workspace files only, so a
// user workflow is not even loaded: this runs every 30 seconds per open
// workspace, and loading a file re-executes its module body.

export function loaderSchedules(
  loader: WorkflowLoader
): (workspacePath: string) => Promise<readonly DeclaredSchedule[]> {
  return async (workspacePath: string) => {
    const listed = await loader.list(workspacePath, 'workspace')
    const declared: DeclaredSchedule[] = []
    for (const workflow of listed) {
      const schedule = workflow.def.schedule
      if (schedule === undefined || schedule === null) continue
      declared.push({
        workflow: workflow.name,
        description: workflow.def.description,
        // A cron that is not even text is an expression Crucible cannot fire,
        // which the scheduler says on the board rather than throwing here.
        cron: typeof schedule.cron === 'string' ? schedule.cron : '',
        declaresInputs: Object.keys(workflow.def.inputs).length > 0,
        ...(typeof schedule.check === 'function' ? { check: schedule.check } : {})
      })
    }
    return declared
  }
}
