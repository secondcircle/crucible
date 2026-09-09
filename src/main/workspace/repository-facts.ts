// Nothing here spawns `git` or `gh`: the parsing is where the mistakes live,
// so it stays pure and drivable from captured output.

/** `refs/remotes/origin/main` is how origin/HEAD names the trunk. */
export function parseTrunkRef(stdout: string): string | undefined {
  const ref = stdout.trim()
  const name = ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : ''
  return name === '' || name === 'HEAD' ? undefined : name
}

export function isGitHubRemote(originUrl: string): boolean {
  return /(^|[@/.])github\.com[:/]/.test(originUrl.trim())
}

/** `owner/name`, which is both the board's label and what a query names. */
export function parseNameWithOwner(
  stdout: string
): { readonly owner: string; readonly name: string } | undefined {
  const [owner, name, ...rest] = stdout.trim().split('/')
  if (owner === undefined || name === undefined || rest.length > 0) return undefined
  if (owner === '' || name === '') return undefined
  return { owner, name }
}
