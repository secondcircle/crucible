import type { AssembleRequest } from './assemble'

// The request the installed app hands its assembler process, as one JSON
// argument, read back on the other side. Checked field by field: argv is text
// from outside the process, however trusted its sender.

export function parseAssembleRequest(argument: string | undefined): AssembleRequest {
  if (argument === undefined) throw new Error('The assembler needs a request as JSON.')
  let parsed: unknown
  try {
    parsed = JSON.parse(argument)
  } catch {
    throw new Error('The assembler was given a request that is not JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The assembler was given a request that is not an object.')
  }
  const { tree, packageName, target } = parsed as Record<string, unknown>
  if (typeof tree !== 'string' || tree === '') throw new Error('The request names no tree.')
  if (typeof packageName !== 'string' || packageName === '') {
    throw new Error('The request names no package.')
  }
  if (target !== undefined && (typeof target !== 'string' || target === '')) {
    throw new Error('The request names a target that is not a path.')
  }
  return { tree, packageName, ...(target === undefined ? {} : { target }) }
}
