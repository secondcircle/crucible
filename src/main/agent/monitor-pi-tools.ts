import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  MONITOR_TOOLS,
  monitorRequestFrom,
  type BoundMonitorTools,
  type MonitorToolParameter
} from '../../shared/agent/monitor-tools'

// The bound monitor behaviors as π tools. Used by the SDK adapter for a
// session agent and by the node session factory for a run's node, so the two
// build the same three tools from the same definitions and a monitor cannot
// mean one thing in a chat and another in a run.

export function monitorPiTools(bound: BoundMonitorTools): ToolDefinition[] {
  return MONITOR_TOOLS.map((tool): ToolDefinition => ({
    name: tool.name,
    label: tool.label,
    // A description survives the prompt override: it rides the request's tools
    // parameter, which is why the guidance lives here.
    description: tool.description,
    parameters: parametersSchema(tool.parameters) as ToolDefinition['parameters'],
    async execute(_callId: string, params: unknown) {
      if (tool.name === 'crucible_monitor') {
        // Throws the model-readable sentence when a required field is blank,
        // so a bad call fails in the model's face and sets no monitor.
        return said(await bound.set(monitorRequestFrom(params)))
      }
      if (tool.name === 'crucible_monitor_stop') {
        const given = (params ?? {}) as { monitorId?: unknown }
        return said(
          await bound.stop(typeof given.monitorId === 'string' ? given.monitorId.trim() : '')
        )
      }
      return said(await bound.list())
    }
  }))
}

/** JSON schema from a definition's parameters: required strings, optional numbers. */
export function parametersSchema(parameters: readonly MonitorToolParameter[]): unknown {
  return {
    type: 'object',
    required: parameters
      .filter((parameter) => parameter.optional !== true)
      .map((parameter) => parameter.name),
    properties: Object.fromEntries(
      parameters.map((parameter) => [
        parameter.name,
        { type: parameter.kind === 'number' ? 'number' : 'string', description: parameter.description }
      ])
    )
  }
}

function said(text: string): { content: { type: 'text'; text: string }[]; details: object } {
  return { content: [{ type: 'text' as const, text }], details: {} }
}
