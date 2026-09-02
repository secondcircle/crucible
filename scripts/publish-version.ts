import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bumpPatch,
  compareVersions,
  formatVersion,
  parseVersion,
  type SemVer
} from '../src/shared/app-update/semver.ts'

// What CI publishes. The registry is the record of what actually shipped; the
// repo's version is a floor the author raises by hand to mark a release. So
// every push to main ships something, a hand-bump is respected, and nothing is
// ever committed back to the repo.

/**
 * The whole rule, as a pure function:
 *
 *   none             → the repo's version   (first publish)
 *   repo > published → the repo's version   (the author bumped by hand)
 *   otherwise        → published, patch + 1 (CI's own bump)
 */
export function choose(repo: SemVer, published: SemVer | undefined): SemVer {
  if (published === undefined) return repo
  if (compareVersions(repo, published) > 0) return repo
  return bumpPatch(published)
}

/** The registry's `latest`, or undefined when the package has never shipped. */
export async function publishedVersion(
  packageName: string,
  fetchOne: typeof globalThis.fetch = globalThis.fetch
): Promise<SemVer | undefined> {
  const answer = await fetchOne(
    `https://registry.npmjs.org/${packageName.replace('/', '%2f')}/latest`,
    { headers: { accept: 'application/json' } }
  )
  if (answer.status === 404) return undefined
  if (!answer.ok) throw new Error(`the registry answered ${answer.status} for ${packageName}`)
  const document: unknown = await answer.json()
  const version = (document as { version?: unknown }).version
  if (typeof version !== 'string') {
    throw new Error(`the registry named no version for ${packageName}`)
  }
  const parsed = parseVersion(version)
  if (parsed === undefined) {
    throw new Error(`the registry's latest for ${packageName} is not a plain x.y.z: ${version}`)
  }
  return parsed
}

// Run by the publish workflow: writes the chosen version into the package.json
// it is about to publish, and prints it for the log.
async function main(): Promise<void> {
  const path = join(process.cwd(), 'package.json')
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const { name, version } = manifest as { name: string; version: string }
  const repo = parseVersion(version)
  if (repo === undefined) {
    throw new Error(`package.json's version is not a plain x.y.z: ${version}`)
  }

  const chosen = formatVersion(choose(repo, await publishedVersion(name)))
  writeFileSync(
    path,
    `${JSON.stringify({ ...(manifest as object), version: chosen }, null, 2)}\n`
  )
  process.stdout.write(`${chosen}\n`)
}

// Only when run as the script; importing it for a test must write nothing.
if (process.argv[1]?.endsWith('publish-version.ts') === true) {
  main().catch((cause: unknown) => {
    process.exitCode = 1
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
  })
}
