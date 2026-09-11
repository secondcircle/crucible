import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
// Spelled with its extension so plain Node can load this module for
// `prove:sdk`: its ESM resolver does no extension guessing.
import type { ToolParameter } from '../../shared/agent/tool-parameter.ts'

// What every Crucible-owned π tool is built with: one JSON schema builder and
// one result shape, so two tools cannot describe their arguments in two
// different dialects.

export function parametersSchema(
  parameters: readonly ToolParameter[]
): ToolDefinition['parameters'] {
  return {
    type: 'object',
    required: parameters
      .filter((parameter) => parameter.optional !== true)
      .map((parameter) => parameter.name),
    properties: Object.fromEntries(
      parameters.map((parameter) => [
        parameter.name,
        {
          type: parameter.kind === 'number' ? 'number' : 'string',
          description: parameter.description
        }
      ])
    )
  } as unknown as ToolDefinition['parameters']
}

export function said(text: string): { content: { type: 'text'; text: string }[]; details: object } {
  return { content: [{ type: 'text' as const, text }], details: {} }
}
