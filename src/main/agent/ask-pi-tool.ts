import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  ASK_TOOL_DEFINITION,
  askRequestFrom,
  type BoundAskTool
} from '../../shared/agent/ask-tool.ts'
import { parametersSchema, said } from './pi-tools.ts'

// The bound ask behavior as a π tool. Mounted on session agents only: a
// workflow node raises a blocker to its orchestrator instead, and nothing a
// node does may reach the dock.

export function askPiTool(bound: BoundAskTool): ToolDefinition {
  return {
    name: ASK_TOOL_DEFINITION.name,
    label: ASK_TOOL_DEFINITION.label,
    // A description survives the prompt override: it rides the request's
    // tools parameter, which is why the teaching lives there.
    description: ASK_TOOL_DEFINITION.description,
    parameters: parametersSchema(ASK_TOOL_DEFINITION.parameters),
    async execute(_callId: string, params: unknown) {
      return said(bound.ask(askRequestFrom(params)))
    }
  }
}
