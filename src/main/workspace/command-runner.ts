// The commands a collector runs arrive as a runner rather than being spawned
// where they are used, so every collection path is drivable from captured
// output and no test spawns git or gh.

export interface CommandOutcome {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number }
) => Promise<CommandOutcome>

export interface CollectionClock {
  /** Epoch milliseconds; the collection's own "now". */
  now(): number
}
