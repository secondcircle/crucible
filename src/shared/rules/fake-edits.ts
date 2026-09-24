import type { RuleWatch } from './gate'

// The fake flavor's two edits, the same for a session and for a run's node:
// one adds a comment that only narrates, and the next deletes it. Fed through
// the real gate, they make a firing on the first and its outcome on the
// second, with no file touched and nothing paid for. The text exists only
// here: nothing is written to the checkout.

export const FAKE_EDIT_PATH = 'src/renderer/src/runs/flow.ts'

const PLAIN = `import type { Edge, GraphNode } from './graph'

export function edgesOf(nodes: readonly GraphNode[]): Edge[] {
  const edges: Edge[] = []
  for (const node of nodes) {
    for (const parent of node.parents) edges.push({ from: parent, to: node.id })
  }
  return edges
}
`

const NARRATED = PLAIN.replace(
  '  for (const node of nodes) {',
  '  // Loop over the nodes and collect the edges\n  for (const node of nodes) {'
)

/** What the agent says between the two edits, which is half its reaction. */
export const FAKE_EDIT_SAID = 'Dropping that comment: the loop already says what it does.'

export interface FakeEdit {
  readonly summary: string
  /** What the tool reports, before any rule note is appended. */
  readonly output: string
  /** Said just before this edit. */
  readonly said?: string
  run(watch: RuleWatch, callId: string): Promise<string>
}

function edit(before: string, after: string, output: string, said?: string): FakeEdit {
  return {
    summary: FAKE_EDIT_PATH,
    output,
    ...(said === undefined ? {} : { said }),
    async run(watch, callId) {
      if (said !== undefined) watch.said(said)
      const { appendix } = await watch.afterEdit({ callId, tool: 'edit', path: FAKE_EDIT_PATH, before, after })
      return `${output}${appendix ?? ''}`
    }
  }
}

export const FAKE_EDITS: readonly FakeEdit[] = [
  edit(PLAIN, NARRATED, `Edited ${FAKE_EDIT_PATH} (+1 −0)`),
  edit(NARRATED, PLAIN, `Edited ${FAKE_EDIT_PATH} (+0 −1)`, FAKE_EDIT_SAID)
]
