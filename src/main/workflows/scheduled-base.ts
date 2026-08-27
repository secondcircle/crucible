import { capture } from '../workspace/capture'
import { findTrunk, NO_TRUNK, refreshRefs, type GitRunner } from '../workspace/trunk'

// Where a scheduled run starts from. No session exists to take a HEAD from,
// so a clock fire branches from the trunk, fetched fresh — the branch board's
// rule, shared rather than re-implemented: origin/HEAD, then local `main`,
// then local `master`, with a failed fetch tolerated and the refs on hand
// standing.

/** The trunk ref a scheduled fire branches from; the engine resolves it. */
export async function scheduledBase(
  workspacePath: string,
  git: GitRunner = gitIn(workspacePath)
): Promise<string> {
  const { originUrl } = await refreshRefs(git)
  const trunk = await findTrunk(git, originUrl !== '')
  if (trunk === undefined) throw new Error(NO_TRUNK)
  return trunk.ref
}

/** Real git in the workspace checkout, shaped as the shared rule reads it. */
function gitIn(workspacePath: string): GitRunner {
  return async (...args: readonly string[]) => {
    const ran = await capture('git', [...args], { cwd: workspacePath })
    return { ok: ran.code === 0, stdout: ran.stdout }
  }
}
