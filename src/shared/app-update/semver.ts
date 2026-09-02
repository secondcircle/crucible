// Plain `x.y.z` and nothing else: only such versions are ever published, so a
// version that does not parse is a version this app refuses to reason about
// rather than one it guesses at. Shared because two very different callers
// need the same comparison — the running app deciding whether the registry
// holds something newer, and CI deciding what number to publish.

export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/

/** Undefined for anything with a prerelease tag, build metadata or a `v`. */
export function parseVersion(text: string): SemVer | undefined {
  const matched = PLAIN.exec(text.trim())
  if (matched === null) return undefined
  return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]) }
}

export function formatVersion(version: SemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/** Negative, zero or positive, the way a comparator is read. */
export function compareVersions(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

export function bumpPatch(version: SemVer): SemVer {
  return { major: version.major, minor: version.minor, patch: version.patch + 1 }
}

/**
 * Whether `candidate` is strictly newer than `than`, both as text. Either one
 * unreadable answers no: an update is installed on evidence, never on doubt.
 */
export function isNewerVersion(candidate: string, than: string): boolean {
  const one = parseVersion(candidate)
  const other = parseVersion(than)
  if (one === undefined || other === undefined) return false
  return compareVersions(one, other) > 0
}
