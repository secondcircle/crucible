import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The package name lives in exactly one place — the running app's own
// package.json — so renaming the package before first publish is one edit.
// Everything that needs the name (the update check above all) reads it here.

export interface PackageIdentity {
  readonly name: string
  readonly version: string
}

export function readPackageIdentity(directory: string): PackageIdentity {
  const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const { name, version } = parsed as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || name === '') {
    throw new Error(`No package name in ${join(directory, 'package.json')}.`)
  }
  if (typeof version !== 'string' || version === '') {
    throw new Error(`No version in ${join(directory, 'package.json')}.`)
  }
  return { name, version }
}
