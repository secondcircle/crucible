// @vitest-environment node
//
// No SDK adapter is ever constructed under test, so pinning these texts word
// for word is what keeps the registration from drifting.
import { describe, expect, it } from 'vitest'
import { PANEL_TOOLS, panelTool } from './panel-tools'

// Pinned word for word, because a drift here changes what every session is
// told about the panel.
const CURATION = [
  'Reach for this tool whenever a document is pertinent to what the user is doing. Naming a path and waiting to be asked to open it leaves them with nothing to read. Show the file, then say plainly that it is in the panel.',
  "The context panel is the user's primary display; they may not notice messages in the chat. Content shown there is what the user relies on to follow the work.",
  "The panel's value comes from curation, not accumulation: it should reflect only what is relevant to the current conversation. Stale tabs actively obscure what matters now \u2014 close them once they have served their purpose (e.g. a plan that has been accepted).",
  'Ephemeral artifacts (plans, diagrams, reports) belong in a temp directory, not the project tree.'
]

describe('the three context panel tools', () => {
  it('are named and described exactly as the legacy system named them', () => {
    expect(PANEL_TOOLS.map((tool) => tool.name)).toEqual([
      'panel_show',
      'panel_list',
      'panel_close'
    ])

    expect(panelTool('panel_show')).toEqual({
      name: 'panel_show',
      label: 'Show in Context Panel',
      description: [
        "Show an HTML or markdown file, or a web address (http or https, localhost included), as a tab in the user's context panel. Pages render at full browser fidelity: scripts run, network loads, links navigate. Re-showing the same file or address replaces its tab and refreshes the view.",
        ...CURATION
      ].join('\n\n'),
      parameters: [
        { name: 'path', description: 'Path to an .html or .md file, or an http(s) URL, to display' },
        { name: 'title', description: 'Short human-readable tab title' }
      ]
    })

    expect(panelTool('panel_list')).toEqual({
      name: 'panel_list',
      label: 'List Context Panel Tabs',
      description: 'List the tabs currently visible to the user in the context panel.',
      parameters: []
    })

    expect(panelTool('panel_close')).toEqual({
      name: 'panel_close',
      label: 'Close Context Panel Tab',
      description: 'Close a context panel tab by id, or all tabs with "all".',
      parameters: [{ name: 'id', description: 'Tab id to close, or "all"' }]
    })
  })

  it('teach the curation the panel lives by, in the paragraphs that do it', () => {
    const { description } = panelTool('panel_show')

    for (const sentence of CURATION) expect(description).toContain(sentence)
    // Crucible is not a TUI, and that is the only word this differs by.
    expect(description).not.toContain('TUI')
  })

  it('carry that curation nowhere but the description', () => {
    for (const tool of PANEL_TOOLS) {
      expect(Object.keys(tool)).not.toContain('guidelines')
    }
  })

  it('refuses a name that is not one of the three', () => {
    // @ts-expect-error the type says as much; this is the answer at runtime.
    expect(() => panelTool('panel_open')).toThrow('panel_open is not a context panel tool.')
  })
})
