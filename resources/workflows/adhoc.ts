import { readFileSync } from 'node:fs'
import { workflow } from 'crucible:workflow'

// The tracer bullet: one node running a prompt file, in the run's own
// worktree. Ported from the legacy system; the venue choice is gone because
// every run works in a worktree now (ADR 0016).

export default workflow({
  description: 'one node running a prompt file, in a worktree',
  inputs: { prompt: "A file containing the node's task, used verbatim." },
  plan: () => [{ id: 'work' }],
  run: async (ctx) => {
    const result = await ctx.node('work', {
      prompt: readFileSync(ctx.inputs.prompt, 'utf8').trim(),
      reads: [ctx.inputs.prompt],
      // Declared even though the branch is the real product, so a run is
      // inspectable from the graph and not only from the worktree.
      outputs: {
        report: {
          file: 'report.html',
          desc: "the node's report of what it did and why, for the human"
        }
      }
    })
    return { summary: result.summary, report: result.outputs.report }
  }
})
