import { createJiti } from 'jiti'
import type { WorkflowDef } from '../authoring'

// A workflow file's definition, loaded into this process the way the host
// entry loads it into its own. For tests that drive a definition's `run()`
// against a scripted context and inspect what it asked for: the process
// boundary is the host's own tests' business, not theirs.

export async function loadWorkflowDef(file: string, authoringModule: string): Promise<WorkflowDef> {
  const jiti = createJiti(__filename, {
    moduleCache: false,
    interopDefault: true,
    alias: { 'crucible:workflow': authoringModule }
  })
  return (await jiti.import(file, { default: true })) as WorkflowDef
}
