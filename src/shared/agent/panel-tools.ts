import type { SessionId } from './port'

// Both adapters build their tools from these definitions, so the three tools
// cannot drift into meaning different things in the two flavors.

export type PanelToolName = 'panel_show' | 'panel_list' | 'panel_close'

/** Every parameter these tools take is a required string. */
export interface PanelToolParameter {
  readonly name: string
  /** What the model is told the parameter is for. */
  readonly description: string
}

export interface PanelToolDefinition {
  readonly name: PanelToolName
  /** Human-readable, for a tool row. */
  readonly label: string
  readonly description: string
  readonly parameters: readonly PanelToolParameter[]
  /** Appended to the system prompt while the tool is active. */
  readonly guidelines?: readonly string[]
}

// This text reaches every session as system prompt, so it stays current with
// the behavior below it.
export const PANEL_SHOW_GUIDELINES: readonly string[] = [
  "The context panel is the user's primary display; they may not notice messages in the chat. Content shown there is what the user relies on to follow the work.",
  "The panel's value comes from curation, not accumulation: it should reflect only what is relevant to the current conversation. Stale tabs actively obscure what matters now — close them once they have served their purpose (e.g. a plan that has been accepted).",
  'Ephemeral artifacts (plans, diagrams, reports) belong in a temp directory, not the project tree.'
]

export const PANEL_TOOLS: readonly PanelToolDefinition[] = [
  {
    name: 'panel_show',
    label: 'Show in Context Panel',
    description:
      "Show an HTML or markdown file as a tab in the user's context panel. Re-showing the same file replaces its tab and refreshes the view.",
    parameters: [
      { name: 'path', description: 'Path to an .html or .md file to display' },
      { name: 'title', description: 'Short human-readable tab title' }
    ],
    guidelines: PANEL_SHOW_GUIDELINES
  },
  {
    name: 'panel_list',
    label: 'List Context Panel Tabs',
    description: 'List the tabs currently visible to the user in the context panel.',
    parameters: []
  },
  {
    name: 'panel_close',
    label: 'Close Context Panel Tab',
    description: 'Close a context panel tab by id, or all tabs with "all".',
    parameters: [{ name: 'id', description: 'Tab id to close, or "all"' }]
  }
]

export function panelTool(name: PanelToolName): PanelToolDefinition {
  const found = PANEL_TOOLS.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`${name} is not a context panel tool.`)
  return found
}

// An adapter is handed behaviors rather than panel state. A failure throws,
// carrying exactly the text the tool result must show.
export interface PanelTools {
  /** Relative paths resolve against `workspacePath`. */
  show(sessionId: SessionId, workspacePath: string, path: string, title: string): string
  list(sessionId: SessionId): string
  /** `"all"` closes every tab. */
  close(sessionId: SessionId, id: string): string
}
