// This module imports nothing on purpose: it is a seam the renderer shares
// with main, and any import here could smuggle Electron or Node across.

export type CommandOrigin = 'built-in' | 'user' | 'workspace'

export interface CommandInfo {
  readonly name: string
  readonly description: string
  /** Free text from the file's frontmatter, shown verbatim. */
  readonly argumentHint?: string
  readonly origin: CommandOrigin
}

export type Expansion =
  | {
      readonly kind: 'command'
      readonly name: string
      readonly origin: CommandOrigin
      /** Exactly what will cross the agent port. */
      readonly text: string
    }
  /** Not an invocation: no leading `/`, or no command by that name. */
  | { readonly kind: 'plain' }

export interface CommandService {
  /** Winners only, alphabetical by name. */
  list(workspacePath: string): Promise<readonly CommandInfo[]>
  // Rejects display-safely only when a matched command file cannot be read at
  // expansion time; a draft naming no command resolves `plain`.
  expand(workspacePath: string, draft: string): Promise<Expansion>
}

/** Workspace beats user beats built-in, which is what lets a user shadow a shipped command. */
export const ORIGIN_PRECEDENCE: readonly CommandOrigin[] = ['built-in', 'user', 'workspace']
