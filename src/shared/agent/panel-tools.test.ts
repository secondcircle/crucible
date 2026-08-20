// @vitest-environment node
//
// The tool surface the SDK adapter registers and the fake adapter scripts. No
// SDK adapter is constructed anywhere in `npm test`, so this is what keeps the
// registration from drifting: it is pinned here, word for word, because it is
// also this feature's shipped agent-facing documentation (ADR 0006).
import { describe, expect, it } from 'vitest'
import { PANEL_SHOW_GUIDELINES, PANEL_TOOLS, panelTool } from './panel-tools'

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
      description:
        "Show an HTML or markdown file as a tab in the user's context panel. Re-showing the same file replaces its tab and refreshes the view.",
      parameters: [
        { name: 'path', description: 'Path to an .html or .md file to display' },
        { name: 'title', description: 'Short human-readable tab title' }
      ],
      guidelines: PANEL_SHOW_GUIDELINES
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

  it('teach the curation the panel lives by, in the three sentences that do it', () => {
    expect(PANEL_SHOW_GUIDELINES).toEqual([
      "The context panel is the user's primary display; they may not notice messages in the chat. Content shown there is what the user relies on to follow the work.",
      "The panel's value comes from curation, not accumulation: it should reflect only what is relevant to the current conversation. Stale tabs actively obscure what matters now — close them once they have served their purpose (e.g. a plan that has been accepted).",
      'Ephemeral artifacts (plans, diagrams, reports) belong in a temp directory, not the project tree.'
    ])
    // Crucible is not a TUI, and that is the only word this differs by.
    expect(PANEL_SHOW_GUIDELINES[0]).not.toContain('TUI')
  })

  it('refuses a name that is not one of the three', () => {
    // @ts-expect-error the type says as much; this is the answer at runtime.
    expect(() => panelTool('panel_open')).toThrow('panel_open is not a context panel tool.')
  })
})
