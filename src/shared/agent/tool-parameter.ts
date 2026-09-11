// What every Crucible-owned tool says about one of its arguments. One shape,
// so the π schema is built in one place whatever the tool is.

export type ToolParameterKind = 'string' | 'number'

export interface ToolParameter {
  readonly name: string
  /** What the model is told the parameter is for, and how the user sees it. */
  readonly description: string
  /** Absent means required. */
  readonly optional?: boolean
  /** Absent means string. */
  readonly kind?: ToolParameterKind
}
