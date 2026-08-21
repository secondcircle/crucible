// A JSON Schema subset, checked by hand: workflows declare verdict shapes as
// plain data, so no schema library has to be shipped to every folder a
// workflow file can live in. Unknown keywords are ignored rather than
// refused — the check is a floor, not a full validator.

export function checkVerdict(schema: Record<string, unknown>, value: unknown): string[] {
  return check(schema, value, 'verdict')
}

function check(schema: Record<string, unknown>, value: unknown, at: string): string[] {
  const problems: string[] = []

  if ('const' in schema && !same(schema.const, value)) {
    problems.push(`${at} must be ${JSON.stringify(schema.const)}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => same(allowed, value))) {
    problems.push(`${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`)
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined
  if (type !== undefined && !isType(type, value)) {
    problems.push(`${at} must be ${aOrAn(type)}, got ${describe(value)}`)
    return problems
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const name of required) {
      if (typeof name === 'string' && !(name in value)) {
        problems.push(`${at} is missing required property "${name}"`)
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!(name in value) || !isRecord(propertySchema)) continue
      problems.push(...check(propertySchema, value[name], `${at}.${name}`))
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => {
      problems.push(...check(schema.items as Record<string, unknown>, item, `${at}[${index}]`))
    })
  }

  return problems
}

function isType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      // An unknown type constrains nothing rather than failing everything.
      return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `${aOrAn(typeof value)}`
}

function aOrAn(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`
}
