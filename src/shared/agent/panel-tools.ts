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
  // Carries the curation too: a description rides the request's tools
  // parameter, the one channel Crucible's system prompt does not replace.
  readonly description: string
  readonly parameters: readonly PanelToolParameter[]
}

export const PANEL_TOOLS: readonly PanelToolDefinition[] = [
  {
    name: 'panel_show',
    label: 'Show in Context Panel',
    description:
      "Show an HTML or markdown file, or a web address (http or https, localhost included), as a tab in the user's context panel. Pages render at full browser fidelity: scripts run, network loads, links navigate. Re-showing the same file or address replaces its tab and refreshes the view.\n\n" +
      'Reach for this tool whenever a document is pertinent to what the user is doing. Naming a path and waiting to be asked to open it leaves them with nothing to read. Show the file, then say plainly that it is in the panel.\n\n' +
      "The context panel is the user's primary display; they may not notice messages in the chat. Content shown there is what the user relies on to follow the work.\n\n" +
      "The panel's value comes from curation, not accumulation: it should reflect only what is relevant to the current conversation. Stale tabs actively obscure what matters now — close them once they have served their purpose (e.g. a plan that has been accepted).\n\n" +
      'Ephemeral artifacts (plans, diagrams, reports) belong in a temp directory, not the project tree.',
    parameters: [
      { name: 'path', description: 'Path to an .html or .md file, or an http(s) URL, to display' },
      { name: 'title', description: 'Short human-readable tab title' }
    ]
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
