import { readFileSync } from 'node:fs'
import { artifactPaths, workflow } from 'crucible:workflow'

// The tracer bullet: one node running a prompt file, in the run's own
// worktree. Ported from the legacy system; the venue choice is gone because
// every run works in a worktree now.

const REPORT = {
  file: 'report.html',
  desc: "the node's report of what it did and why, for the human"
}

/**
 * The node's system prompt. A node is told exactly what its workflow writes,
 * so what the prompt file leaves unsaid about the situation is said here:
 * nobody is watching, and the report is owed. How a node finishes is the
 * `complete_node` and `raise_blocker` tools' own descriptions to carry.
 */
export const NODE_SYSTEM = `\
You are one node of an automated workflow run, working in a git worktree of a
repository with no interactive user. Nobody reads what you write as you work,
and a question typed into a message is never answered: work from the task
autonomously, verify every claim you make by running tools rather than
asserting it, and when something you cannot resolve stands in the way, raise
it with the raise_blocker tool and wait for the answer. You are finished only
when the report the task names is written and you have called complete_node.`

/** The prompt file's text, then the one thing it cannot know: where the report goes. */
export const taskPrompt = (task: string, report: string): string => `\
${task}

When the work is done, write a report of what you did and why, for the human
who reads it, to \`${report}\`; the run is not complete until that file exists
and has content.`

export default workflow({
  description: 'one node running a prompt file, in a worktree',
  inputs: { prompt: "A file containing the node's task, used verbatim." },
  plan: () => [{ id: 'work', outputs: { report: REPORT } }],
  run: async (ctx) => {
    const outputs = { report: REPORT }
    const result = await ctx.node('work', {
      system: NODE_SYSTEM,
      prompt: taskPrompt(readFileSync(ctx.inputs.prompt, 'utf8').trim(), artifactPaths(ctx, outputs).report),
      reads: [ctx.inputs.prompt],
      // Declared even though the branch is the real product, so a run is
      // inspectable from the graph and not only from the worktree.
      outputs
    })
    return { summary: result.summary, report: result.outputs.report }
  }
})
