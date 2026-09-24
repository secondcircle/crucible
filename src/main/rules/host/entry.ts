import { createRpc } from '../../workflows/host/protocol.ts'
import { openParentChannel } from '../../host/parent-channel.ts'
import { createRuleEngine } from './engine.ts'
import type { RuleHostRequests, RuleMainRequests } from './protocol.ts'

// A workspace's rule host: where a repository's rule code runs, one
// long-lived process per workspace. Rules fire all day, so unlike a workflow
// host it outlives any one question; a rule that holds this process
// synchronously holds only this process, and main ends it when it stops
// answering.
//
// argv: <workspace checkout> <shipped rule library directory>

const [, , workspacePath, libDir] = process.argv
if (workspacePath === undefined || libDir === undefined) {
  process.stderr.write('rule host: expected <workspace> <rule library directory>\n')
  process.exit(2)
}

const engine = createRuleEngine(workspacePath, { dir: libDir })

createRpc<RuleMainRequests, RuleHostRequests>(openParentChannel('rule host'), {
  configure: (config) => {
    engine.configure(config)
    return undefined
  },
  load: () => engine.load(),
  evaluate: (request) => engine.evaluate(request),
  present: (request) => engine.present(request),
  head: ({ cwd }) => engine.head(cwd)
})

// The far end's disconnect is the host's cue to leave.
process.on('disconnect', () => process.exit(0))
